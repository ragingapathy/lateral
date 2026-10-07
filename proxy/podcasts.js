'use strict';
// Podcast intelligence: rank episodes against a story, transcribe the ones you pick (local Whisper worker), and pull
// out the key moments that actually concern the story.
//
//   POST /podcast/rank          { storyId, topic, ctx?, tags?, episodes:[{title,podcastTitle,summary,audioUrl,url}] }
//                               -> { items:[{ i, key, score, why, rank, hidden }], ai }  (score 0-3; null when the judge is down)
//   POST /podcast/feedback      { storyId, key, hidden }   hide ("Not relevant") or restore an episode for one story
//   POST /podcast/transcribe    { audioUrl, title?, podcastTitle?, url?, imageUrl?, date?, storyId? }  start (or report) a transcript
//   POST /podcast/status        { urls:[audioUrl…] }       transcript state per episode, for card badges
//   GET  /podcast/job           ?key=…                      progress of one transcription
//   GET  /podcast/worker                                    is the transcription worker reachable?
//   GET  /podcast/transcript    ?key=…                      full transcript (segments with seconds)
//   GET  /podcast/list          ?storyId=                   transcribed episodes
//   POST /podcast/sections      { key, topic, ctx?, tags?, force? }  start finding key moments (background job)
//   GET  /podcast/sections      ?key=…&topic=…              progress + result of that job, or the cached sections
//   DELETE /podcast/item        ?key=…                      forget a transcript
//
// Transcription is done by tools/transcribe_worker.py (optional, local, CPU). Everything else needs only the local
// language model that the relevance filter already uses. The judge FAILS OPEN: if it is down, episodes keep their
// search order and nothing is hidden.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const relevance = require('./relevance');

const DATA_DIR = process.env.LATERAL_DATA_DIR || '/data';
const DIR = path.join(DATA_DIR, 'podcasts');
const INDEX_FILE = path.join(DIR, 'index.json');
const RANK_FILE = path.join(DIR, 'rank-cache.json');
const SECTIONS_FILE = path.join(DIR, 'sections-cache.json');
const WORKER_FILE = path.join(DATA_DIR, 'podcast-worker.json');   // optional { url, token }; env vars win

const RANK_BATCH = 6;
const RANK_DEADLINE_MS = 55000;
const MAX_EPISODES = 40;
const WINDOW_SECS = 90;
const WINDOW_STEP_SECS = 60;
const MAX_WINDOWS_JUDGED = 30;
const SECTION_BATCH = 5;
const MAX_RANK_ENTRIES = 6000;

fs.mkdirSync(DIR, { recursive: true });

// ─── Small helpers ───────────────────────────────────────────────────────────

const sha = (s, n = 16) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n);
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const epKey = audioUrl => sha(String(audioUrl || '').trim());

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, obj) {
  try { fs.writeFileSync(file + '.tmp', JSON.stringify(obj)); fs.renameSync(file + '.tmp', file); }
  catch (e) { console.warn('[Podcasts] could not save', path.basename(file), e.message); }
}

let index = (() => { const j = readJson(INDEX_FILE, {}); return { items: j.items || {}, pending: j.pending || {}, failed: j.failed || {}, hidden: j.hidden || {} }; })();
let _saveT = null;
function saveIndexSoon() { clearTimeout(_saveT); _saveT = setTimeout(() => writeJson(INDEX_FILE, index), 300); }

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}

const STOP = new Set('about above after again against also among because been before being between both but could does doing down during each from further have having here into itself just more most much must once only other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your the and for are was not you all any can had has her him his how its may our out she who why yes new say said says one two get got let now see use via'.split(' '));
function terms(text) {
  const out = new Set();
  for (const w of norm(text).replace(/[^a-z0-9\s'-]/g, ' ').split(' ')) {
    const t = w.replace(/^['-]+|['-]+$/g, '');
    if (t.length >= 3 && !STOP.has(t)) out.add(t.length > 5 ? t.replace(/(ing|ed|es|s)$/, '') : t);
  }
  return out;
}
function overlap(topicTerms, text) {
  if (!topicTerms.size) return 0;
  const have = terms(text);
  let hit = 0;
  for (const t of topicTerms) if (have.has(t)) hit++;
  return hit;
}

// Judge calls are queued one at a time (they share the GPU with everything else).
let _q = Promise.resolve();
function queued(fn) { const p = _q.then(fn, fn); _q = p.catch(() => {}); return p; }

function parseVerdicts(text, n) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/^[\s>*\-•]+/, '').trim();
    const parts = line.split('|');
    if (parts.length < 2) continue;
    const id = Number(String(parts[0]).replace(/[^0-9]/g, ''));
    const sc = Number(String(parts[1]).replace(/[^0-9]/g, '').slice(0, 1));
    if (Number.isInteger(id) && id >= 1 && id <= n && Number.isInteger(sc) && sc >= 0 && sc <= 3 && !out[id]) {
      out[id] = { score: sc, why: parts.slice(2).join('|').trim().slice(0, 140) };
    }
  }
  return out;
}

// ─── Episode ranking ─────────────────────────────────────────────────────────

const rankCache = (() => { const j = readJson(RANK_FILE, {}); return { entries: j.entries || {} }; })();
function saveRankCache() {
  const keys = Object.keys(rankCache.entries);
  if (keys.length > MAX_RANK_ENTRIES) {
    keys.sort((a, b) => (rankCache.entries[a].at || 0) - (rankCache.entries[b].at || 0)).slice(0, Math.ceil(MAX_RANK_ENTRIES / 10)).forEach(k => delete rankCache.entries[k]);
  }
  writeJson(RANK_FILE, rankCache);
}

function rankPrompt(ctx, eps) {
  const lines = eps.map((e, i) => `${i + 1}. ${String(e.podcastTitle || '').slice(0, 60)} — ${String(e.title || '').slice(0, 160)} — ${String(e.summary || '').replace(/\s+/g, ' ').slice(0, 260)}`);
  return `You choose podcast episodes for someone following a news topic. Score how useful each episode is for that topic.

TOPIC: "${ctx.topic}"
${ctx.ctx ? `ABOUT THE TOPIC: ${ctx.ctx}\n` : ''}${ctx.tags ? `TAGS: ${ctx.tags}\n` : ''}
Scores:
3 = the episode is mainly about this topic.
2 = a substantial part of the episode is about this topic, or it is a strong, directly connected subject.
1 = only a passing mention, loose background, or a generic show on the same broad subject.
0 = shares a word or name with the topic but is about something else, or is promotional, a trailer, or unrelated.

Rules: judge the episode's SUBJECT, not keyword overlap. Descriptions are short, so give plausible matches the benefit of the doubt (score 1 or 2), but score 0 when you can tell it is about something else.

Reply with EXACTLY ${eps.length} lines, one per episode, in this format and nothing else:
NUMBER|score|short reason (under 12 words)

EPISODES:
${lines.join('\n')}`;
}

async function rankEpisodes(body) {
  const topic = String(body.topic || '').trim();
  const storyId = String(body.storyId || '');
  const list = (Array.isArray(body.episodes) ? body.episodes : []).slice(0, MAX_EPISODES);
  const ctx = { topic, ctx: String(body.ctx || '').slice(0, 400), tags: String(body.tags || '').slice(0, 200) };
  const tTerms = terms(`${topic} ${ctx.tags}`);
  const t0 = Date.now();
  const hiddenMap = index.hidden[storyId] || {};

  const rows = list.map((e, i) => {
    const key = epKey(e.audioUrl || e.url || `${e.podcastTitle}::${e.title}`);
    const heur = overlap(tTerms, `${e.title} ${e.title} ${e.podcastTitle} ${e.summary}`);
    return { i, key, e, heur, score: null, why: '', hidden: !!hiddenMap[key] };
  });

  const todo = [];
  for (const r of rows) {
    const hit = rankCache.entries[sha(norm(topic) + '\n' + r.key)];
    if (hit) { r.score = hit.score; r.why = hit.why; r.cached = true; } else todo.push(r);
  }

  let ai = todo.length === 0 ? 'cached' : 'ok';
  await queued(async () => {
    for (let i = 0; i < todo.length; i += RANK_BATCH) {
      if (Date.now() - t0 > RANK_DEADLINE_MS) { ai = 'partial'; break; }
      const chunk = todo.slice(i, i + RANK_BATCH);
      let got = {};
      try { got = parseVerdicts(await relevance.ollamaText(rankPrompt(ctx, chunk.map(c => c.e)), { numPredict: 700 }), chunk.length); }
      catch { ai = 'unavailable'; break; }
      const miss = chunk.map((_, j) => j).filter(j => !got[j + 1]);
      if (miss.length && miss.length < chunk.length && Date.now() - t0 < RANK_DEADLINE_MS) {
        try { const again = parseVerdicts(await relevance.ollamaText(rankPrompt(ctx, miss.map(j => chunk[j].e)), { numPredict: 400 }), miss.length); miss.forEach((j, n) => { if (again[n + 1]) got[j + 1] = again[n + 1]; }); } catch {}
      }
      chunk.forEach((r, j) => {
        const g = got[j + 1];
        if (g) { r.score = g.score; r.why = g.why; rankCache.entries[sha(norm(topic) + '\n' + r.key)] = { score: g.score, why: g.why, at: Date.now() }; }
      });
    }
  });
  if (todo.some(r => r.score !== null)) saveRankCache();

  // Judge score dominates; keyword overlap breaks ties and orders episodes the judge never saw.
  const items = rows.map(r => ({ i: r.i, key: r.key, score: r.score, why: r.why, hidden: r.hidden, rank: (r.score == null ? 1.5 : r.score) * 10 + Math.min(r.heur, 5) }))
    .sort((a, b) => b.rank - a.rank);
  return { items, ai };
}

function setHidden(storyId, key, hidden) {
  if (!storyId || !key) return false;
  const m = index.hidden[storyId] || (index.hidden[storyId] = {});
  if (hidden) m[key] = 1; else delete m[key];
  if (!Object.keys(m).length) delete index.hidden[storyId];
  saveIndexSoon();
  return true;
}

// ─── Transcription worker ────────────────────────────────────────────────────

function workerCfg() {
  const f = readJson(WORKER_FILE, {});
  return {
    url: String(process.env.LATERAL_TRANSCRIBE_URL || f.url || 'http://host.docker.internal:3007').replace(/\/+$/, ''),
    token: String(process.env.LATERAL_TRANSCRIBE_TOKEN || f.token || ''),
  };
}
async function workerCall(method, p, body, timeoutMs = 8000) {
  const { url, token } = workerCfg();
  const r = await fetch(url + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  if (!r.ok) { const err = new Error(j.error || `Worker HTTP ${r.status}`); err.status = r.status; throw err; }
  return j;
}
async function workerHealth() {
  try { return { ok: true, ...(await workerCall('GET', '/health', null, 4000)), url: workerCfg().url }; }
  catch (e) {
    return { ok: false, url: workerCfg().url, error: e.status === 401 ? 'The worker rejected the token.' : 'Not reachable.', unauthorized: e.status === 401 };
  }
}

function transcriptFile(key) { return path.join(DIR, `${key}.json`); }
function loadTranscript(key) { return index.items[key] ? readJson(transcriptFile(key), null) : null; }

function publicItem(m) {
  return { key: m.key, title: m.title, podcastTitle: m.podcastTitle, audioUrl: m.audioUrl, url: m.url, imageUrl: m.imageUrl, date: m.date,
    duration: m.duration, language: m.language, model: m.model, words: m.words, storyIds: m.storyIds || [], at: m.at };
}

function stateFor(key) {
  if (index.items[key]) return { state: 'done', key };
  const p = index.pending[key];
  if (p) return { state: p.state || 'queued', progress: p.progress || 0, key };
  const f = index.failed[key];
  if (f) return { state: 'error', error: f.reason, key };
  return { state: 'none', key };
}

async function startTranscript(body) {
  const audioUrl = String(body.audioUrl || '').trim();
  if (!/^https?:\/\//i.test(audioUrl)) { const e = new Error('This episode has no audio file to transcribe.'); e.status = 400; throw e; }
  const key = epKey(audioUrl);
  const storyId = String(body.storyId || '');
  const existing = index.items[key];
  if (existing) {
    if (storyId && !(existing.storyIds || []).includes(storyId)) { (existing.storyIds = existing.storyIds || []).push(storyId); saveIndexSoon(); }
    return stateFor(key);
  }
  if (index.pending[key]) return stateFor(key);
  const h = await workerHealth();
  if (!h.ok) {
    const e = new Error(h.unauthorized ? 'The transcription worker rejected the token. Check LATERAL_TRANSCRIBE_TOKEN.' : `The transcription worker is not running (${h.url}). Start it with: python tools/transcribe_worker.py`);
    e.status = 503; throw e;
  }
  let job;
  try { job = await workerCall('POST', '/jobs', { url: audioUrl }, 15000); }
  catch (e) { e.status = 502; throw e; }
  delete index.failed[key];
  index.pending[key] = {
    jobId: job.id, state: 'queued', progress: 0, startedAt: Date.now(),
    meta: { key, title: String(body.title || '').slice(0, 300), podcastTitle: String(body.podcastTitle || '').slice(0, 200), audioUrl, url: String(body.url || ''), imageUrl: String(body.imageUrl || ''), date: String(body.date || ''), storyIds: storyId ? [storyId] : [] },
  };
  saveIndexSoon();
  ensurePoller();
  return stateFor(key);
}

let _poll = null;
function ensurePoller() {
  if (_poll || !Object.keys(index.pending).length) return;
  _poll = setInterval(pollPending, 3000);
}
let _polling = false;
async function pollPending() {
  if (_polling) return;
  _polling = true;
  try {
    for (const [key, p] of Object.entries(index.pending)) {
      try {
        const j = await workerCall('GET', `/jobs/${p.jobId}`, null, 20000);
        p.state = j.state; p.progress = j.progress || 0;
        if (j.state === 'done' && j.result) {
          const segs = (j.result.segments || []).filter(s => s && typeof s.t === 'string');
          writeJson(transcriptFile(key), { key, segments: segs, duration: j.result.duration, language: j.result.language, model: j.result.model });
          index.items[key] = { ...p.meta, duration: j.result.duration, language: j.result.language, model: j.result.model, words: segs.reduce((n, s) => n + s.t.split(/\s+/).length, 0), at: Date.now() };
          delete index.pending[key];
          workerCall('DELETE', `/jobs/${p.jobId}`, null, 5000).catch(() => {});
        } else if (j.state === 'error') {
          index.failed[key] = { reason: j.error || 'Transcription failed.', at: Date.now() };
          delete index.pending[key];
        }
      } catch (e) {
        if (e.status === 404) { index.failed[key] = { reason: 'The worker lost this job (it may have restarted). Try again.', at: Date.now() }; delete index.pending[key]; }
        // unreachable: keep the job and retry on the next tick
      }
    }
    saveIndexSoon();
  } finally {
    _polling = false;
    if (!Object.keys(index.pending).length && _poll) { clearInterval(_poll); _poll = null; }
  }
}
ensurePoller();   // resume jobs that were running before a restart

function removeItem(key) {
  const had = !!index.items[key] || !!index.pending[key];
  if (index.pending[key]) workerCall('DELETE', `/jobs/${index.pending[key].jobId}`, null, 4000).catch(() => {});
  delete index.items[key]; delete index.pending[key]; delete index.failed[key];
  try { fs.unlinkSync(transcriptFile(key)); } catch {}
  const sc = readJson(SECTIONS_FILE, { entries: {} });
  for (const k of Object.keys(sc.entries)) if (sc.entries[k].key === key) delete sc.entries[k];
  writeJson(SECTIONS_FILE, sc);
  saveIndexSoon();
  return had;
}

// ─── Key moments ─────────────────────────────────────────────────────────────

const sectionCache = (() => { const j = readJson(SECTIONS_FILE, {}); return { entries: j.entries || {} }; })();
const _jobs = new Map();      // sectionsKey -> { state, done, total, error, sections }

// Overlapping windows of about 90 s, cut on segment boundaries.
function buildWindows(segs) {
  const wins = [];
  if (!segs.length) return wins;
  const end = segs[segs.length - 1].e;
  for (let start = segs[0].s; start < end; start += WINDOW_STEP_SECS) {
    const inside = segs.filter(s => s.e > start && s.s < start + WINDOW_SECS);
    if (!inside.length) continue;
    const text = inside.map(s => s.t).join(' ');
    wins.push({ s: inside[0].s, e: inside[inside.length - 1].e, text, first: segs.indexOf(inside[0]), last: segs.indexOf(inside[inside.length - 1]) });
  }
  return wins;
}

function sectionPrompt(ctx, wins) {
  const lines = wins.map((w, i) => `${i + 1}. [${fmtTime(w.s)}] ${w.text.replace(/\s+/g, ' ').slice(0, 900)}`);
  return `You are marking up a podcast transcript for someone following a news topic. For each excerpt, score how much it is actually about the topic.

TOPIC: "${ctx.topic}"
${ctx.ctx ? `ABOUT THE TOPIC: ${ctx.ctx}\n` : ''}${ctx.tags ? `TAGS: ${ctx.tags}\n` : ''}
Scores:
3 = the speakers discuss this topic itself here (facts, analysis, claims, quotes about it). The passage would still make sense as a clip about the topic.
2 = a closely connected subject with the same actors or events, or a substantial aside about the topic.
1 = a passing mention, or a different story that only shares background with the topic (for example war spending when the topic is interest rates).
0 = unrelated: other topics, ads, sponsor reads, intros, banter.

Be strict: a passage about a related but different story is a 1, not a 3.

Reply with EXACTLY ${wins.length} lines in this format and nothing else:
NUMBER|score|what is said about the topic (under 14 words)

EXCERPTS:
${lines.join('\n')}`;
}

async function buildSections(key, ctx, jobKey) {
  const job = _jobs.get(jobKey);
  const doc = loadTranscript(key);
  if (!doc || !doc.segments.length) { job.state = 'error'; job.error = 'No transcript for this episode.'; return; }
  const wins = buildWindows(doc.segments);
  const tTerms = terms(`${ctx.topic} ${ctx.tags || ''}`);
  wins.forEach(w => { w.heur = overlap(tTerms, w.text); });

  // Judge every window if the episode is short; otherwise the best keyword matches plus a spread of the rest.
  let pick = wins.map((w, i) => i);
  if (wins.length > MAX_WINDOWS_JUDGED) {
    const byHeur = pick.slice().sort((a, b) => wins[b].heur - wins[a].heur);
    const top = new Set(byHeur.slice(0, Math.ceil(MAX_WINDOWS_JUDGED * 0.75)));
    const stride = Math.max(1, Math.floor(wins.length / (MAX_WINDOWS_JUDGED - top.size)));
    for (let i = 0; i < wins.length && top.size < MAX_WINDOWS_JUDGED; i += stride) top.add(i);
    pick = [...top].sort((a, b) => a - b);
  }
  job.total = pick.length; job.done = 0;

  const verdict = {};
  let failures = 0;
  await queued(async () => {
    for (let i = 0; i < pick.length; i += SECTION_BATCH) {
      const chunk = pick.slice(i, i + SECTION_BATCH);
      let got = {};
      try { got = parseVerdicts(await relevance.ollamaText(sectionPrompt(ctx, chunk.map(j => wins[j])), { numPredict: 700, timeoutMs: 120000 }), chunk.length); }
      catch { failures++; if (failures >= 2) { job.error = 'The local model is not responding.'; return; } }
      chunk.forEach((j, n) => { if (got[n + 1]) verdict[j] = got[n + 1]; });
      job.done = Math.min(pick.length, i + chunk.length);
    }
  });
  if (job.error && !Object.keys(verdict).length) { job.state = 'error'; return; }

  // Keep windows scoring 2+ (or 1+ if nothing did), then merge neighbours that touch or sit within 30 s.
  const keepMin = Object.values(verdict).some(v => v.score >= 2) ? 2 : 1;
  const chosen = Object.keys(verdict).map(Number).filter(j => verdict[j].score >= keepMin).sort((a, b) => a - b);
  const merged = [];
  for (const j of chosen) {
    const w = wins[j], prev = merged[merged.length - 1];
    if (prev && w.s <= prev.e + 30) { prev.e = Math.max(prev.e, w.e); prev.last = Math.max(prev.last, w.last); if (verdict[j].score > prev.score) { prev.score = verdict[j].score; prev.why = verdict[j].why; } }
    else merged.push({ s: w.s, e: w.e, first: w.first, last: w.last, score: verdict[j].score, why: verdict[j].why });
  }
  const sections = merged.map(m => ({
    start: m.s, end: m.e, score: m.score, why: m.why,
    text: doc.segments.slice(m.first, m.last + 1).map(s => s.t).join(' '),
  }));
  const best = sections.reduce((b, s) => (s.score > (b?.score || 0) ? s : b), null);
  if (best && best.score === 3) best.top = true;

  const out = { key, topic: ctx.topic, sections, judged: Object.keys(verdict).length, windows: wins.length, minutes: Math.round((doc.duration || 0) / 60), at: Date.now() };
  sectionCache.entries[jobKey] = out;
  writeJson(SECTIONS_FILE, sectionCache);
  job.sections = out; job.state = 'done';
}

function sectionsKey(key, topic) { return sha(key + '\n' + norm(topic)); }

function startSections(body) {
  const key = String(body.key || '');
  const topic = String(body.topic || '').trim();
  if (!index.items[key]) { const e = new Error('No transcript for that episode.'); e.status = 404; throw e; }
  if (!topic) { const e = new Error('Missing topic.'); e.status = 400; throw e; }
  const jk = sectionsKey(key, topic);
  const running = _jobs.get(jk);
  if (running && running.state === 'running') return { state: 'running', done: running.done, total: running.total };
  if (sectionCache.entries[jk] && !body.force) return { state: 'done', ...sectionCache.entries[jk] };
  const job = { state: 'running', done: 0, total: 0, error: '', startedAt: Date.now() };
  _jobs.set(jk, job);
  buildSections(key, { topic, ctx: String(body.ctx || '').slice(0, 400), tags: String(body.tags || '').slice(0, 200) }, jk)
    .catch(e => { job.state = 'error'; job.error = e.message || 'Failed.'; });
  return { state: 'running', done: 0, total: 0 };
}

function getSections(key, topic) {
  const jk = sectionsKey(String(key || ''), topic);
  const job = _jobs.get(jk);
  if (job && job.state === 'running') return { state: 'running', done: job.done, total: job.total };
  if (job && job.state === 'error') return { state: 'error', error: job.error };
  if (sectionCache.entries[jk]) return { state: 'done', ...sectionCache.entries[jk] };
  return { state: 'none' };
}

// ─── HTTP routes ─────────────────────────────────────────────────────────────

function readBody(req, max = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n <= max) chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

async function route(req, reqUrl, res, send) {
  const p = reqUrl.pathname.replace(/^\/api\/lateral/, '');
  if (!p.startsWith('/podcast/')) return false;
  const sub = p.slice('/podcast/'.length);
  const q = reqUrl.searchParams;
  try {
    if (req.method === 'GET') {
      if (sub === 'worker') return send(res, 200, await workerHealth());
      if (sub === 'job') return send(res, 200, stateFor(String(q.get('key') || '')));
      if (sub === 'transcript') {
        const key = String(q.get('key') || '');
        const doc = loadTranscript(key);
        return doc ? send(res, 200, { ...doc, item: publicItem(index.items[key]) }) : send(res, 404, { error: 'No transcript for that episode.' });
      }
      if (sub === 'list') {
        const sid = q.get('storyId') || '';
        const items = Object.values(index.items).filter(m => !sid || (m.storyIds || []).includes(sid)).sort((a, b) => (b.at || 0) - (a.at || 0)).map(publicItem);
        return send(res, 200, { items, pending: Object.entries(index.pending).map(([key, v]) => ({ key, title: v.meta.title, state: v.state, progress: v.progress })) });
      }
      if (sub === 'sections') return send(res, 200, getSections(q.get('key'), q.get('topic')));
    }
    if (req.method === 'DELETE' && sub === 'item') return send(res, 200, { ok: removeItem(String(q.get('key') || '')) });
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (sub === 'rank') {
        if (!String(body.topic || '').trim()) return send(res, 400, { error: 'Missing topic' });
        try { return send(res, 200, await rankEpisodes(body)); }
        catch (e) { return send(res, 200, { items: [], ai: 'unavailable', error: e.message }); }   // fail open
      }
      if (sub === 'feedback') return send(res, 200, { ok: setHidden(String(body.storyId || ''), String(body.key || ''), !!body.hidden) });
      if (sub === 'transcribe') return send(res, 200, await startTranscript(body));
      if (sub === 'status') {
        const out = {};
        for (const u of Array.isArray(body.urls) ? body.urls.slice(0, 100) : []) out[u] = stateFor(epKey(u));
        return send(res, 200, { status: out });
      }
      if (sub === 'sections') return send(res, 200, startSections(body));
    }
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || 'Podcast request failed.' });
  }
  return send(res, 404, { error: 'Unknown podcast route.' });
}

module.exports = { route, epKey, rankEpisodes, buildWindows, parseVerdicts, terms, overlap, _internals: { index, rankCache, sectionCache } };
