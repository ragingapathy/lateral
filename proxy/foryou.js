'use strict';
// "For you": the top of Home. It adds no new sources of its own; it gathers what Lateral already knows into a few short lists:
//
//   moved     tracked stories with new coverage, and predictions whose evidence moved (from the alert events, last 3 days)
//   coming    the next 7 days from the calendar (voting dates, deadlines, meetings, your own events) and predictions that come due
//   civic     things that happened in your Civic watches (votes, committee action, meeting notices) in the last 3 days
//   podcasts  today's picks: a daily pass searches podcasts for each active story, the local model scores the episodes, and the best
//             few (never more than two per story) are kept. Nothing is transcribed here; that stays a click.
//
//   GET  foryou          { asOf, moved, coming, civic, podcasts, pending, empty }   cheap; refreshes the podcast picks in the background
//                                                                                  when they are more than 20 hours old
//   POST foryou/refresh  run the podcast pass now

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.LATERAL_DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'foryou.json');
const HOUR = 3600000;
const LOOKBACK = 72 * HOUR;
const PICKS_TTL = 20 * HOUR;
const MAX_STORIES = 8, MAX_PICKS = 5, PER_STORY = 2, FRESH_DAYS = 21;

let ctx = {};                                   // test and server hooks: now, stories, events, calendar, searchPodcasts, rank, hidden, localToday
const nowMs = () => (ctx.now ? ctx.now() : Date.now());
const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { s = clean(s); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const addDays = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

const stories = () => (ctx.stories ? ctx.stories() : (readJson(path.join(DATA_DIR, 'stories.json'), { stories: [] }).stories || []));
const alertEvents = () => (ctx.events ? ctx.events() : require('./alerts')._db().events || []);
const localToday = () => (ctx.localToday ? ctx.localToday() : require('./calendar-sources').localToday(nowMs()));

let state = (() => { const j = readJson(FILE, {}); return { at: j.at || 0, picks: j.picks || [], error: j.error || '' }; })();
let running = false;
const save = () => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, FILE); } catch { /* next time */ } };

// ─── Moved and Civic: from the alert events ──────────────────────────────────

const MOVED_KINDS = new Set(['prediction-move', 'story-activity']);
const firstLines = (body, n) => clip(String(body || '').split('\n').filter(Boolean).slice(0, 2).join(' · '), n);
const sev = e => (e.severity === 'important' ? 0 : 1);

function recentEvents(events, now) {
  return events.filter(e => e && !e.muted && e.at && now - Date.parse(e.at) < LOOKBACK && now - Date.parse(e.at) >= -HOUR);
}
const viewEvent = e => ({ id: e.id, at: e.at, kind: e.kind, severity: e.severity || 'info', title: clip(e.title, 140), body: firstLines(e.body, 180), storyId: e.storyId || '', read: !!e.read });

// Newest first, important first, one per story (the newest), at most `n`. Pure.
function movedFrom(events, now, n = 5) {
  const seen = new Set();
  return recentEvents(events, now).filter(e => MOVED_KINDS.has(e.kind))
    .sort((a, b) => sev(a) - sev(b) || Date.parse(b.at) - Date.parse(a.at))
    .filter(e => { const k = e.storyId || e.title; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, n).map(viewEvent);
}
function civicFrom(events, now, n = 4) {
  const seen = new Set();
  return recentEvents(events, now).filter(e => /^civic-/.test(e.kind))
    .sort((a, b) => sev(a) - sev(b) || Date.parse(b.at) - Date.parse(a.at))
    .filter(e => { const k = e.title; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, n).map(viewEvent);
}

// ─── Coming up: calendar plus predictions that come due ──────────────────────

const COMING_RANK = { vote: 0, deadline: 0, meeting: 1, mine: 1, term: 2, event: 3, food: 3 };
function comingFrom(calendarEvents, events, now, today, n = 6) {
  const to = addDays(today, 7);
  const seenCal = new Set();
  const cal = (calendarEvents || []).filter(e => e && e.date <= to && (e.endDate || e.date) >= today)
    .filter(e => { const k = `${e.date}|${String(e.title).toLowerCase()}`; if (seenCal.has(k)) return false; seenCal.add(k); return true; })
    .sort((a, b) => (COMING_RANK[a.kind] ?? 3) - (COMING_RANK[b.kind] ?? 3) || a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
  // spread by day order after choosing the most relevant, so the list reads as a short agenda
  const chosen = cal.slice(0, n).sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''))
    .map(e => ({ id: e.id, type: 'calendar', date: e.date < today ? today : e.date, time: e.time || '', title: clip(e.title, 120), kind: e.kind, group: e.group || '', url: e.url || '' }));
  const due = recentEvents(events, now).filter(e => e.kind === 'prediction-due').slice(0, 2)
    .map(e => ({ id: e.id, type: 'prediction', date: today, time: '', title: clip(e.title, 120), kind: 'prediction', group: 'Prediction', storyId: e.storyId || '' }));
  return [...due, ...chosen].slice(0, n);
}

// ─── Podcast picks ───────────────────────────────────────────────────────────

const epId = e => String(e.audioUrl || e.url || `${e.podcastTitle}::${e.title}`);
const isFresh = (date, now) => { const t = Date.parse(date); return !date || !Number.isFinite(t) || now - t < FRESH_DAYS * 86400000; };

async function picksFor(story, now) {
  const rc = require('./relevance').storyContext(story);
  const queries = [...new Set([rc.topic, (story.tags || []).slice(0, 2).join(' ')].map(clean).filter(q => q.length > 3))].slice(0, 2);
  const search = ctx.searchPodcasts;
  if (!search || !queries.length) return { ranked: [], ai: 'skipped' };
  const seen = new Set(), eps = [];
  for (const q of queries) {
    let got = []; try { got = await search(q, 12); } catch { got = []; }
    for (const e of got || []) { const k = epId(e); if (!seen.has(k) && isFresh(e.date, now)) { seen.add(k); eps.push(e); } }
  }
  if (!eps.length) return { ranked: [], ai: 'ok' };
  const rank = ctx.rank || require('./podcasts').rankEpisodes;
  const out = await rank({ topic: rc.topic, storyId: story.id, ctx: rc.ctx, tags: rc.tags, episodes: eps.slice(0, 20).map(e => ({ title: e.title, podcastTitle: e.podcastTitle, summary: e.summary, audioUrl: e.audioUrl, url: e.url })) });
  const hidden = (ctx.hidden ? ctx.hidden(story.id) : (require('./podcasts')._internals.index.hidden[story.id] || {})) || {};
  const ranked = (out.items || []).filter(it => !it.hidden && !hidden[it.key] && it.score != null && it.score >= 2).map(it => {
    const e = eps[it.i];
    return { key: it.key, storyId: story.id, storyTitle: rc.topic, score: it.score, why: clip(it.why, 120), ep: { title: clip(e.title, 160), podcastTitle: clip(e.podcastTitle, 80), url: e.url || '', audioUrl: e.audioUrl || '', date: e.date || '', imageUrl: e.imageUrl || '', summary: clip(e.summary, 240) } };
  });
  return { ranked, ai: out.ai };
}

// Pure. Best score first, newest first; at most two per story and one per episode; at most MAX_PICKS.
function choosePicks(all) {
  const byEp = new Map();
  for (const p of all) { const k = epId(p.ep); const cur = byEp.get(k); if (!cur || p.score > cur.score) byEp.set(k, p); }
  const per = {}, out = [];
  for (const p of [...byEp.values()].sort((a, b) => b.score - a.score || String(b.ep.date).localeCompare(String(a.ep.date)))) {
    if ((per[p.storyId] = (per[p.storyId] || 0) + 1) > PER_STORY) continue;
    out.push(p); if (out.length >= MAX_PICKS) break;
  }
  return out;
}

async function refreshPicks() {
  if (running) return false;
  running = true;
  try {
    const now = nowMs();
    const isWatch = id => { try { return ctx.isWatch ? ctx.isWatch(id) : require('./civic-watch').hasWatch(id); } catch { return false; } };
    // stories that only exist to carry Civic watch items are skipped: podcasts would be noise for them
    const active = stories().filter(s => s && s.status !== 'buried' && s.title && !isWatch(s.id)).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, MAX_STORIES);
    const all = []; let unavailable = 0, tried = 0;
    for (const s of active) {
      try { const r = await picksFor(s, now); all.push(...r.ranked); tried++; if (r.ai === 'unavailable') unavailable++; } catch { unavailable++; tried++; }
    }
    if (tried && unavailable === tried) { state.error = 'The local model is not answering, so today\'s podcast picks could not be made.'; state.at = now - PICKS_TTL + 30 * 60000; }   // keep the old picks, try again in 30 minutes
    else { state = { at: now, picks: choosePicks(all), error: '' }; }
    save();
    return true;
  } finally { running = false; }
}

// ─── The view ────────────────────────────────────────────────────────────────

async function build() {
  const now = nowMs(), today = localToday(), events = alertEvents();
  let cal = [];
  try { const r = await (ctx.calendar ? ctx.calendar(today, addDays(today, 7)) : require('./calendar').allEvents({ from: today, to: addDays(today, 7) })); cal = (r && r.events) || []; } catch { cal = []; }
  const stale = now - state.at > PICKS_TTL;
  if (stale && !running && !ctx.noBackground) refreshPicks().catch(() => {});
  const hiddenFor = id => (ctx.hidden ? ctx.hidden(id) : (require('./podcasts')._internals.index.hidden[id] || {})) || {};
  const view = {
    asOf: new Date(now).toISOString(), today,
    moved: movedFrom(events, now), coming: comingFrom(cal, events, now, today), civic: civicFrom(events, now),
    podcasts: state.picks.filter(p => !(hiddenFor(p.storyId) || {})[p.key]), podcastsAt: state.at ? new Date(state.at).toISOString() : '',
    pending: running || (stale && !ctx.noBackground), podcastError: state.error || '',
  };
  view.empty = !view.moved.length && !view.coming.length && !view.civic.length && !view.podcasts.length;
  return view;
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n < 20000) chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
async function route(req, reqUrl, res, send) {
  const sub = reqUrl.pathname.replace(/^\/api\/lateral/, '').replace(/^\/foryou\/?/, '');
  try {
    if (req.method === 'GET' && sub === '') return send(res, 200, await build());
    if (req.method === 'POST' && sub === 'refresh') { await readBody(req); if (!running) refreshPicks().catch(() => {}); return send(res, 200, { pending: true }); }
  } catch (e) { return send(res, 200, { error: e.message }); }
  return send(res, 404, { error: 'Unknown route.' });
}

// A daily pass: check every few hours whether the picks are stale.
let timer = null;
function init(c) {
  ctx = { ...ctx, ...(c || {}) };
  if (timer) clearInterval(timer);
  if (!ctx.noBackground) { timer = setInterval(() => { if (nowMs() - state.at > PICKS_TTL && !running) refreshPicks().catch(() => {}); }, 3 * HOUR); if (timer.unref) timer.unref(); }
}

module.exports = {
  route, build, refreshPicks, init,
  // exported for tests
  movedFrom, civicFrom, comingFrom, choosePicks, picksFor,
  _reset: () => { state = { at: 0, picks: [], error: '' }; running = false; },
  _state: () => state,
};
