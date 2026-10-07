'use strict';
// Change alerts: tells you when something you follow has moved, without you having to open the app.
//
//   Events (always recorded in the in-app Activity inbox):
//     prediction-move   a prediction's evidence changed direction, or moved by a meaningful amount
//     prediction-due    a prediction is approaching, or past, its resolution date
//     story-activity    a tracked story picked up new coverage
//     system            something Lateral depends on stopped working (or recovered)
//     tavily            search credits are running low
//
//   Delivery (optional): ntfy, Discord, Slack, or any webhook, as a daily digest and/or instantly for the events that matter.
//
//   GET  /alerts/config · POST /alerts/config      read / change settings (secrets are masked on the way out)
//   GET  /alerts/events · /alerts/unread           the inbox
//   POST /alerts/read · /alerts/clear              mark read / empty the inbox
//   POST /alerts/test {channelId}                  send a test message
//   POST /alerts/digest {preview?}                 build (and send) the digest now
//   POST /alerts/watch                             run the prediction watcher now
//   GET  /alerts/status

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const DATA_DIR = process.env.LATERAL_DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'alerts.json');
const MAX_EVENTS = 300;
const DIRECTIONAL = ['supports', 'contradicts', 'complicates'];

const uid = () => crypto.randomBytes(6).toString('hex');
const nowIso = () => new Date().toISOString();

// ─── Storage ─────────────────────────────────────────────────────────────────

function defaults() {
  return {
    config: {
      channels: [],
      digest: { enabled: true, time: '08:00', tzOffsetMin: 0 },
      instant: { predictionMoves: true, resolutionDue: true, system: true, tavilyUsage: true, civic: true },
      sensitivity: { scoreDelta: 20 },
      watch: { hours: 0 },
      appUrl: '',
    },
    state: { lastDigestDay: '', lastDigestAt: '', predSnap: {}, fired: {}, health: { ok: true, key: '' }, tavilyPct: 0, lastWatchAt: '' },
    events: [],
  };
}
function load() {
  const d = defaults();
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const k of Object.keys(d.config)) if (j.config && j.config[k] !== undefined) d.config[k] = (typeof d.config[k] === 'object' && !Array.isArray(d.config[k])) ? { ...d.config[k], ...j.config[k] } : j.config[k];
    d.state = { ...d.state, ...(j.state || {}) };
    d.events = Array.isArray(j.events) ? j.events : [];
  } catch { /* first run */ }
  return d;
}
let db = load();
let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, FILE); } catch { /* try again on the next change */ }
  }, 600);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let ctx = { getTavilyKey: () => '', runChecks: null };
const v2 = () => require('./v2');

function readStories() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'stories.json'), 'utf8')).stories || []; } catch { return []; }
}
function storyForPrediction(predId) { return readStories().find(s => s.predictionId === predId) || null; }

function localNow(offsetMin = 0, at = new Date()) {
  const d = new Date(at.getTime() - Number(offsetMin) * 60000); // getTimezoneOffset() is minutes *behind* UTC
  const p = n => String(n).padStart(2, '0');
  return { day: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, hhmm: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` };
}

// Links only make sense when the user told us where their Lateral lives (Settings -> Alerts -> "Link back to"); otherwise none.
function appLink(storyId) {
  const base = String(db.config.appUrl || '').replace(/\/+$/, '');
  if (!base) return '';
  return storyId ? `${base}/?story=${encodeURIComponent(storyId)}` : base;
}
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const DIR_WORDS = { closer: 'toward TRUE', further: 'toward FALSE', mixed: 'mixed', none: 'no clear lean' };
const signed = n => `${n > 0 ? '+' : ''}${n}`;

// ─── Delivery ────────────────────────────────────────────────────────────────

function post(urlStr, bodyObj, headers = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlStr); } catch { return reject(new Error('That is not a valid URL')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('Only http and https URLs are supported'));
    const body = JSON.stringify(bodyObj);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', timeout, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 300) }));
    });
    req.on('error', e => reject(new Error(e.code || e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('timed out')); });
    req.write(body); req.end();
  });
}

// msg: { title, message, url?, priority? (1-5), kind? }
async function sendTo(ch, msg) {
  let r;
  if (ch.type === 'ntfy') {
    const server = String(ch.server || 'https://ntfy.sh').replace(/\/+$/, '');
    const payload = { topic: ch.topic, title: msg.title, message: msg.message, priority: msg.priority || 3, tags: [msg.kind === 'system' ? 'warning' : msg.kind === 'tavily' ? 'moneybag' : 'newspaper'] };
    if (msg.url && /^https?:/i.test(msg.url)) payload.click = msg.url;
    r = await post(server, payload, ch.token ? { Authorization: `Bearer ${ch.token}` } : {});
  } else if (ch.type === 'discord') {
    r = await post(ch.url, { username: 'Lateral', content: clip(`**${msg.title}**\n${msg.message}${msg.url ? `\n${msg.url}` : ''}`, 1900) });
  } else if (ch.type === 'slack') {
    r = await post(ch.url, { text: clip(`*${msg.title}*\n${msg.message}${msg.url ? `\n<${msg.url}|Open in Lateral>` : ''}`, 3500) });
  } else {
    r = await post(ch.url, { app: 'lateral', kind: msg.kind || 'alert', title: msg.title, message: msg.message, url: msg.url || '', priority: msg.priority || 3, sentAt: nowIso() });
  }
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}${r.body ? ': ' + clip(r.body, 80) : ''}`);
  return r.status;
}

async function deliver(msg) {
  const results = [];
  for (const ch of db.config.channels) {
    if (!ch.enabled) continue;
    try { await sendTo(ch, msg); results.push({ channel: ch.name, ok: true }); }
    catch (e) { results.push({ channel: ch.name, ok: false, error: e.message }); }
  }
  return results;
}

// ─── Events ──────────────────────────────────────────────────────────────────

function isInstant(e) {
  const i = db.config.instant;
  return (e.kind === 'prediction-move' && i.predictionMoves) || (e.kind === 'prediction-due' && i.resolutionDue)
    || (e.kind === 'system' && i.system) || (e.kind === 'tavily' && i.tavilyUsage)
    || (['civic-vote', 'civic-deadline', 'civic-meeting'].includes(e.kind) && i.civic);   // civic-activity goes to the digest only
}

function addEvent(ev) {
  const e = { id: uid(), at: nowIso(), read: false, delivered: {}, severity: 'info', ...ev };
  db.events.unshift(e);
  if (db.events.length > MAX_EVENTS) db.events.length = MAX_EVENTS;
  saveSoon();
  if (isInstant(e)) {
    e.delivered.instant = 'pending';
    deliver({ title: e.title, message: e.body, url: appLink(e.storyId), kind: e.kind, priority: e.severity === 'important' ? 4 : 3 })
      .then(results => { e.delivered.instant = results.length ? results : 'no-channels'; saveSoon(); })
      .catch(() => { e.delivered.instant = 'error'; });
  }
  return e;
}

// ─── Detectors ───────────────────────────────────────────────────────────────

// Called whenever a prediction's evidence may have changed (after a search-and-score run and same-story grouping).
function checkPrediction(predId) {
  let snap;
  try { snap = v2().evidenceSnapshot(predId); } catch { return null; }
  if (!snap || snap.prediction.resolution || snap.prediction.status === 'resolved') return null;
  const ev = snap.evidence;
  const cur = { direction: ev.direction, score: ev.score, at: nowIso() };
  const prev = db.state.predSnap[predId];
  if (!prev) { db.state.predSnap[predId] = cur; saveSoon(); return null; }   // first sighting is the baseline, never an alert

  const delta = cur.score - prev.score;
  const dirChanged = prev.direction !== cur.direction;
  if (!dirChanged && Math.abs(delta) < (Number(db.config.sensitivity.scoreDelta) || 20)) return null;
  if (cur.direction === 'none' && prev.direction === 'none') return null;

  const newOnes = snap.links
    .filter(l => DIRECTIONAL.includes(l.stance) && l.scoredAt && l.scoredAt > prev.at && l.item)
    .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0)).slice(0, 3);
  const story = storyForPrediction(predId);
  const word = DIR_WORDS[cur.direction] || '';
  const title = prev.direction === 'none'
    ? 'First evidence found for a prediction'
    : dirChanged ? `A prediction's evidence now leans ${word}` : `Evidence ${delta > 0 ? 'strengthened' : 'weakened'} for a prediction`;
  const lines = [`"${clip(snap.prediction.statement, 140)}"`, `Evidence balance ${signed(prev.score)} → ${signed(cur.score)}${ev.strength && ev.strength !== 'none' ? ` (${ev.strength} evidence)` : ''}.`];
  for (const l of newOnes) lines.push(`• ${l.stance === 'supports' ? '▲' : l.stance === 'contradicts' ? '▼' : '◆'} ${clip(l.item.title, 90)}`);
  db.state.predSnap[predId] = cur;
  return addEvent({ kind: 'prediction-move', severity: dirChanged ? 'important' : 'info', title, body: lines.join('\n'), storyId: story ? story.id : '', predictionId: predId, data: { from: prev, to: cur } });
}

// Daily: predictions nearing or past their resolution date with no outcome recorded.
function checkDue() {
  let preds = [];
  try { preds = v2().listPredictions(); } catch { return; }
  for (const p of preds) {
    if (!p.resolutionDate || p.resolution || p.status === 'resolved') continue;
    const end = Date.parse(`${String(p.resolutionDate).slice(0, 10)}T23:59:59Z`);
    if (!Number.isFinite(end)) continue;
    const days = Math.floor((end - Date.now()) / 86400000);
    const bucket = days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 1 ? '1d' : days <= 7 ? '7d' : '';
    if (!bucket) continue;
    const key = `due:${p.id}:${bucket}`;
    if (db.state.fired[key]) continue;
    // one alert per prediction per stage; mark the earlier stages too so a late-added prediction doesn't fire all of them
    ['7d', '1d', 'today', 'overdue'].forEach(b => { db.state.fired[`due:${p.id}:${b}`] = db.state.fired[`due:${p.id}:${b}`] || (b === bucket ? Date.now() : -1); });
    const snap = (() => { try { return v2().evidenceSnapshot(p.id); } catch { return null; } })();
    const ev = snap && snap.evidence;
    const when = bucket === 'overdue' ? 'is past its resolution date' : bucket === 'today' ? 'resolves today' : bucket === '1d' ? 'resolves tomorrow' : `resolves in ${days + 1} days`;
    const story = storyForPrediction(p.id);
    addEvent({
      kind: 'prediction-due', severity: bucket === 'overdue' || bucket === 'today' ? 'important' : 'info',
      title: `A prediction ${when}`,
      body: `"${clip(p.statement, 140)}"\n${ev && ev.direction !== 'none' ? `Evidence leans ${DIR_WORDS[ev.direction]} (${signed(ev.score)}). ` : 'No clear evidence yet. '}Record how it turned out to add it to your track record.`,
      storyId: story ? story.id : '', predictionId: p.id,
    });
  }
  saveSoon();
}

// Called by the server's background refresh with the run it just recorded.
function onRefreshRun(run) {
  for (const s of (run && run.stories) || []) {
    const fresh = (s.novelHeadlines || []).filter(h => h && h.title);
    if (s.coverage !== 'growing' || !fresh.length) continue;
    const bullets = fresh.slice(0, 4).map(h => `• ${clip(h.title, 100)}${h.source && h.source.name ? ` (${h.source.name})` : ''}`);
    const recent = db.events.find(e => e.kind === 'story-activity' && e.storyId === s.id && Date.now() - Date.parse(e.at) < 12 * 3600000);
    // Coverage that keeps arriving for one story is one growing entry, not a pile of near-identical ones.
    const count = (recent && recent.data && recent.data.count || 0) + fresh.length;
    const merged = [...bullets, ...(recent ? String(recent.body).split('\n') : [])].filter((x, i, arr) => arr.indexOf(x) === i).slice(0, 4);
    const title = `${clip(s.title, 70)}: ${count} new article${count === 1 ? '' : 's'}`;
    if (recent) { recent.title = title; recent.body = merged.join('\n'); recent.data = { count }; recent.at = nowIso(); recent.read = false; recent.delivered = {}; saveSoon(); continue; }
    addEvent({ kind: 'story-activity', title, body: merged.join('\n'), storyId: s.id, data: { count } });
  }
}

// Civic watches (see civic-watch.js): a bill or ordinance that moved, a meeting tomorrow, a public-comment period closing, and
// the ordinary new items (digest only). Keyed events fire once.
async function checkCivic() {
  let evs = [];
  try { evs = await require('./civic-watch').collect(); } catch { /* the bill tracker below still runs */ }
  // Official-record events for bills tracked as predictions (civic-track.js).
  try { evs = evs.concat(await require('./civic-track').collect()); } catch { /* optional */ }
  if (!evs.length) return;
  for (const ev of evs) {
    const { key, activity, count, ...rest } = ev;
    if (key) { if (db.state.fired[key]) continue; db.state.fired[key] = Date.now(); }
    if (activity) {
      // New items that keep arriving for one watch are one growing entry, not a pile of near-identical ones.
      const recent = db.events.find(e => e.kind === 'civic-activity' && e.storyId === rest.storyId && Date.now() - Date.parse(e.at) < 12 * 3600000);
      if (recent) {
        const total = (recent.data && recent.data.count || 0) + count;
        recent.title = rest.title.replace(/: \d+ new or updated items?$/, `: ${total} new or updated item${total === 1 ? '' : 's'}`);
        recent.body = [...rest.body.split('\n'), ...String(recent.body).split('\n')].filter((x, i, a) => a.indexOf(x) === i).slice(0, 4).join('\n');
        recent.data = { count: total }; recent.at = nowIso(); recent.read = false; recent.delivered = {};
        continue;
      }
      rest.data = { count };
    }
    addEvent(rest);
  }
  saveSoon();
}

async function checkSystem() {
  if (!ctx.runChecks) return;
  let r;
  try { r = await ctx.runChecks(); } catch { return; }
  const failing = r.checks.filter(c => c.status === 'fail');
  const key = failing.map(c => c.id).sort().join(',');
  const was = db.state.health;
  if (failing.length && key !== was.key) {
    const c = failing[0];
    addEvent({ kind: 'system', severity: 'important', title: `Lateral needs attention: ${c.label}`, body: `${c.detail}${c.fix ? `\n${c.fix}` : ''}` });
  } else if (!failing.length && !was.ok) {
    addEvent({ kind: 'system', title: 'Lateral is back to normal', body: 'Everything the setup check looks at is working again.' });
  }
  db.state.health = { ok: !failing.length, key };
  saveSoon();
}

async function tavilyUsage() {
  const key = ctx.getTavilyKey();
  if (!key) return null;
  try {
    const res = await fetch('https://api.tavily.com/usage', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const j = await res.json();
    const used = (j.account && j.account.plan_usage) ?? (j.key && j.key.usage) ?? 0;
    const limit = (j.account && j.account.plan_limit) ?? (j.key && j.key.limit) ?? null;
    return { used, limit, pct: limit ? Math.round((used / limit) * 100) : 0 };
  } catch { return null; }
}
async function checkTavily() {
  const u = await tavilyUsage();
  if (!u || !u.limit) return u;
  if (u.pct < 50) db.state.tavilyPct = 0;                       // a new billing period
  if (u.pct >= 85 && u.pct >= db.state.tavilyPct + 5) {
    db.state.tavilyPct = u.pct;
    addEvent({ kind: 'tavily', severity: 'important', title: `Tavily credits at ${u.pct}%`, body: `${u.used.toLocaleString()} of ${u.limit.toLocaleString()} used. Searches, prediction scoring and some saved copies may stop working when they run out.` });
  }
  saveSoon();
  return u;
}

// Optional: re-run each active prediction's searches on a schedule, so evidence (and these alerts) keep moving without you.
let watching = false;
function watchTargets() {
  let preds = [];
  try { preds = v2().listPredictions(); } catch { return []; }
  return preds.filter(p => !p.resolution && p.status !== 'resolved' && (p.signals || []).some(s => s.active && s.query));
}
function watchCost() { return watchTargets().reduce((n, p) => n + p.signals.filter(s => s.active && s.query).length, 0); }

async function watchPredictions({ force = false } = {}) {
  const hours = Number(db.config.watch.hours) || 0;
  if (watching || (!force && !hours)) return { started: 0, reason: watching ? 'already running' : 'off' };
  if (!force && Date.now() - (Date.parse(db.state.lastWatchAt) || 0) < hours * 3600000) return { started: 0, reason: 'not due' };
  const u = await tavilyUsage();
  if (u && u.limit && u.pct >= 90) return { started: 0, reason: `Tavily credits are at ${u.pct}%` };
  watching = true;
  let started = 0;
  try {
    for (const p of watchTargets()) {
      const r = v2().startSearchJob(p.id);
      if (r.error) continue;
      started++;
      // one prediction at a time: scoring shares the GPU with everything else
      for (let i = 0; i < 180; i++) { await new Promise(res => setTimeout(res, 5000)); const st = v2().jobStatus(p.id); if (!st || st.state !== 'running') break; }
    }
    db.state.lastWatchAt = nowIso(); saveSoon();
  } finally { watching = false; }
  return { started };
}

// ─── Digest ──────────────────────────────────────────────────────────────────

function compileDigest(sinceIso) {
  const evs = db.events.filter(e => e.at > sinceIso && e.kind !== 'digest');
  const part = (kinds) => evs.filter(e => kinds.includes(e.kind));
  const moves = part(['prediction-move']), due = part(['prediction-due']), acts = part(['story-activity']), sys = part(['system', 'tavily']);
  const civ = part(['civic-vote', 'civic-deadline', 'civic-meeting', 'civic-activity']);
  const sections = [];
  const list = (arr) => arr.map(e => `• ${e.title}${e.body ? '\n  ' + e.body.split('\n').slice(0, 3).join('\n  ') : ''}`).join('\n');
  if (moves.length) sections.push(`PREDICTIONS\n${list(moves)}`);
  if (due.length) sections.push(`RESOLUTION DATES\n${list(due)}`);
  if (civ.length) sections.push(`CIVIC\n${list(civ)}`);
  if (acts.length) sections.push(`STORIES WITH NEW COVERAGE\n${list(acts)}`);
  if (sys.length) sections.push(`HEADS UP\n${list(sys)}`);
  const count = moves.length + due.length + civ.length + acts.length + sys.length;
  return { count, title: `Lateral digest: ${count} update${count === 1 ? '' : 's'}`, message: clip(sections.join('\n\n'), 3800) || '', ids: evs.map(e => e.id) };
}

async function runDigest({ preview = false } = {}) {
  const since = db.state.lastDigestAt || new Date(Date.now() - 24 * 3600000).toISOString();
  const d = compileDigest(since);
  if (preview) return { sent: false, preview: true, ...d };
  if (!d.count) return { sent: false, reason: 'Nothing new since the last digest.', ...d };
  const channels = db.config.channels.filter(c => c.enabled);
  if (!channels.length) return { sent: false, reason: 'No delivery channel is switched on.', ...d };
  const results = await deliver({ title: d.title, message: d.message, url: appLink(''), kind: 'digest' });
  db.state.lastDigestAt = nowIso();
  saveSoon();
  return { sent: results.some(r => r.ok), results, ...d };
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

let lastHourly = 0, lastHalfHour = 0;
async function tick() {
  try {
    const dg = db.config.digest;
    if (dg.enabled) {
      const lt = localNow(dg.tzOffsetMin);
      if (lt.hhmm >= dg.time && db.state.lastDigestDay !== lt.day) {
        db.state.lastDigestDay = lt.day; saveSoon();
        await runDigest();
      }
    }
    if (Date.now() - lastHalfHour > 30 * 60000) { lastHalfHour = Date.now(); await checkSystem(); }
    if (Date.now() - lastHourly > 60 * 60000) {
      lastHourly = Date.now();
      checkDue();
      await checkTavily();
      await checkCivic();
      await watchPredictions();
    }
  } catch (e) { console.warn('[Alerts] tick error:', e.message); }
}

function init(opts = {}) {
  ctx = { ...ctx, ...opts };
  setTimeout(() => { tick(); setInterval(tick, 60000); }, 20000);
  console.log('[Alerts] Engine started');
}

// ─── HTTP routes ─────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise(resolve => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n < 1e6) chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const hint = s => { s = String(s || ''); return s ? `…${s.slice(-4)}` : ''; };
function publicConfig() {
  const c = db.config;
  return {
    channels: c.channels.map(ch => ({
      id: ch.id, type: ch.type, name: ch.name, enabled: !!ch.enabled, server: ch.server || '',
      topicHint: ch.type === 'ntfy' ? hint(ch.topic) : '', urlHint: ch.url ? `${(() => { try { return new URL(ch.url).host; } catch { return ''; } })()}/${hint(ch.url)}` : '', hasToken: !!ch.token,
    })),
    digest: c.digest, instant: c.instant, sensitivity: c.sensitivity, watch: c.watch, appUrl: c.appUrl,
  };
}

function applyConfig(body) {
  const c = db.config;
  if (Array.isArray(body.channels)) {
    const old = new Map(c.channels.map(ch => [ch.id, ch]));
    c.channels = body.channels.slice(0, 8).map(n => {
      const prev = old.get(n.id) || {};
      const type = ['ntfy', 'discord', 'slack', 'webhook'].includes(n.type) ? n.type : (prev.type || 'webhook');
      const ch = { id: prev.id || uid(), type, name: clip(n.name || prev.name || type, 40), enabled: n.enabled !== false };
      if (type === 'ntfy') {
        ch.server = clip(n.server || prev.server || 'https://ntfy.sh', 200);
        ch.topic = String(n.topic || prev.topic || '').trim();
        ch.token = n.token !== undefined && n.token !== '' ? String(n.token).trim() : (prev.token || '');
      } else {
        ch.url = String(n.url || prev.url || '').trim();
      }
      return ch;
    }).filter(ch => (ch.type === 'ntfy' ? ch.topic : /^https?:\/\//i.test(ch.url)));
  }
  if (body.digest) {
    const d = body.digest;
    if (d.enabled !== undefined) c.digest.enabled = !!d.enabled;
    if (/^\d{2}:\d{2}$/.test(String(d.time || ''))) c.digest.time = d.time;
    if (Number.isFinite(Number(d.tzOffsetMin))) c.digest.tzOffsetMin = Math.max(-840, Math.min(840, Number(d.tzOffsetMin)));
  }
  if (body.instant) for (const k of Object.keys(c.instant)) if (body.instant[k] !== undefined) c.instant[k] = !!body.instant[k];
  if (body.sensitivity && Number.isFinite(Number(body.sensitivity.scoreDelta))) c.sensitivity.scoreDelta = Math.max(5, Math.min(60, Math.round(Number(body.sensitivity.scoreDelta))));
  if (body.watch && Number.isFinite(Number(body.watch.hours))) c.watch.hours = [0, 24, 48, 168].includes(Number(body.watch.hours)) ? Number(body.watch.hours) : 0;
  if (body.appUrl !== undefined) c.appUrl = /^https?:\/\//i.test(String(body.appUrl)) ? String(body.appUrl).trim().replace(/\/+$/, '') : '';
  saveSoon();
}

async function route(req, reqUrl, res, send) {
  const p = reqUrl.pathname.replace(/^\/api\/lateral/, '');
  if (!p.startsWith('/alerts/')) return false;
  const sub = p.slice('/alerts/'.length);
  const q = reqUrl.searchParams;

  if (sub === 'config' && req.method === 'GET') return send(res, 200, { config: publicConfig() });
  if (sub === 'config' && req.method === 'POST') { applyConfig(await readBody(req)); return send(res, 200, { config: publicConfig() }); }
  if (sub === 'unread' && req.method === 'GET') return send(res, 200, { unread: db.events.filter(e => !e.read).length, important: db.events.filter(e => !e.read && e.severity === 'important').length });
  if (sub === 'events' && req.method === 'GET') {
    const limit = Math.min(200, Number(q.get('limit')) || 60);
    return send(res, 200, { events: db.events.slice(0, limit).map(e => ({ id: e.id, at: e.at, kind: e.kind, severity: e.severity, title: e.title, body: e.body, storyId: e.storyId || '', read: !!e.read, delivered: e.delivered && e.delivered.instant ? e.delivered.instant : null })) });
  }
  if (sub === 'status' && req.method === 'GET') {
    const dg = db.config.digest, lt = localNow(dg.tzOffsetMin);
    return send(res, 200, {
      channels: db.config.channels.filter(c => c.enabled).length, unread: db.events.filter(e => !e.read).length,
      lastDigestAt: db.state.lastDigestAt || null, digestToday: db.state.lastDigestDay === lt.day,
      watch: { hours: db.config.watch.hours, lastWatchAt: db.state.lastWatchAt || null, targets: watchTargets().length, creditsPerRun: watchCost() },
    });
  }
  if (req.method === 'POST') {
    const body = await readBody(req);
    if (sub === 'read') {
      const ids = Array.isArray(body.ids) ? new Set(body.ids) : null;
      db.events.forEach(e => { if (body.all || (ids && ids.has(e.id))) e.read = true; });
      saveSoon();
      return send(res, 200, { unread: db.events.filter(e => !e.read).length });
    }
    if (sub === 'clear') { db.events = []; saveSoon(); return send(res, 200, { ok: true }); }
    if (sub === 'test') {
      const ch = db.config.channels.find(c => c.id === body.channelId);
      if (!ch) return send(res, 404, { error: 'Unknown channel. Save it first.' });
      try { await sendTo(ch, { title: 'Lateral test alert', message: 'If you can read this, alerts from Lateral will reach you here.', url: appLink(''), kind: 'test' }); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }
    if (sub === 'digest') return send(res, 200, await runDigest({ preview: !!body.preview }));
    if (sub === 'check') {
      // run every detector now: prediction movement, resolution dates, setup problems, Tavily credits
      const before = db.events.length;
      try { v2().listPredictions().forEach(p => checkPrediction(p.id)); } catch { /* none yet */ }
      checkDue(); await checkSystem(); await checkTavily(); await checkCivic();
      return send(res, 200, { ok: true, newEvents: Math.max(0, db.events.length - before) });
    }
    if (sub === 'watch') { watchPredictions({ force: true }).catch(() => {}); return send(res, 202, { started: true, targets: watchTargets().length, creditsPerRun: watchCost() }); }
  }
  return send(res, 404, { error: 'Unknown alerts route.' });
}

module.exports = { init, route, checkPrediction, onRefreshRun, addEvent, checkDue, checkCivic, runDigest, configure: applyConfig, _db: () => db };
