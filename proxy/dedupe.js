'use strict';
// Same-story grouping: find articles that report the same underlying event (wire copy, rewrites, many outlets covering one
// announcement) so the evidence balance counts the event once, not once per outlet.
//
// How: cheap signals propose CANDIDATE pairs (title word overlap, plus embedding similarity if `nomic-embed-text` is installed),
// then the local model judges each candidate pair "same" or "different". Embeddings alone cannot do this: two different
// stories about the same company are as similar as two copies of one story. Verdicts are cached, so each pair is judged once.
//
//   groupEntries(entries) -> judges any uncached candidate pairs (slow; run in the background)
//   clustersFor(entries)  -> instant: groups from cached verdicts only
// An entry is { id, title, text?, source? }; ids are anything stable (a v2 item id, or a hash of a URL).

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const DATA_DIR = process.env.LATERAL_DATA_DIR || '/data';
const VERDICT_FILE = path.join(DATA_DIR, 'dedupe-cache.json');
const EMBED_FILE = path.join(DATA_DIR, 'embed-cache.json');
const MODEL = process.env.LATERAL_DEDUPE_MODEL || process.env.LATERAL_RELEVANCE_MODEL || process.env.VALE_CHAT_MODEL || 'qwen3:latest';
const EMBED_MODEL = process.env.LATERAL_EMBED_MODEL || 'nomic-embed-text';
const EMBED_THRESHOLD = 0.86;    // "worth asking the model about"; not a verdict
const LEX_THRESHOLD = 0.4;
const BATCH = 3;
const MAX_CANDIDATES = 80;
const MAX_PAIRS = 20000;
const MERGE_MEAN = 0.3;          // average verdict across two groups needed to join them (+1 same, -1 different, 0 unjudged)

// ─── Caches ──────────────────────────────────────────────────────────────────

function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
let verdicts = loadJson(VERDICT_FILE, { pairs: {} });
if (!verdicts.pairs) verdicts = { pairs: {} };
let vecs = loadJson(EMBED_FILE, { v: {} });
if (!vecs.v) vecs = { v: {} };
const timers = {};
function saveSoon(name, file, obj) {
  if (timers[name]) return;
  timers[name] = setTimeout(() => {
    timers[name] = null;
    try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, file); } catch { /* next time */ }
  }, 1000);
}
function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

// ─── Text helpers ────────────────────────────────────────────────────────────

// "Headline - Reuters", "Headline | CNN", "Headline – The Hill": drop the outlet tail.
function cleanTitle(t) { return String(t || '').replace(/\s+[|\-–—]\s+[^|\-–—]{2,45}$/, '').trim(); }
const STOP = new Set(['the', 'and', 'for', 'with', 'new', 'says', 'said', 'from', 'that', 'this', 'after', 'over', 'into', 'are', 'was', 'has', 'have', 'will', 'its', 'not', 'but', 'you', 'what', 'how', 'why', 'who', 'about', 'more', 'than', 'amid', 'report', 'reports']);
const NUMWORD = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
function tokens(t) {
  const out = new Set();
  for (let w of cleanTitle(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)) {
    w = NUMWORD[w] || w;
    if ((w.length > 2 || /\d/.test(w)) && !STOP.has(w)) out.add(w.replace(/(ing|ed|es|s)$/, ''));
  }
  return out;
}
function jaccard(a, b) { let n = 0; for (const x of a) if (b.has(x)) n++; return n / ((a.size + b.size - n) || 1); }
function cosine(a, b) { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); }

// ─── Embeddings (optional) ───────────────────────────────────────────────────

let embedDownUntil = 0;
function post(pathname, payload, timeoutMs) {
  const url = new URL(pathname, process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434');
  const lib = url.protocol === 'https:' ? https : http;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Ollama HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Could not read model response')); }
      });
    });
    req.on('error', e => reject(new Error('Ollama unreachable: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timed out')); });
    req.write(body); req.end();
  });
}

async function embed(text) {
  const key = crypto.createHash('sha1').update(text).digest('hex').slice(0, 20);
  const hit = vecs.v[key];
  if (hit) return new Float32Array(Buffer.from(hit, 'base64').buffer.slice(0));
  if (Date.now() < embedDownUntil) return null;
  try {
    const j = await post('/api/embeddings', { model: EMBED_MODEL, prompt: 'clustering: ' + text }, 30000);
    if (!Array.isArray(j.embedding) || !j.embedding.length) throw new Error('no embedding');
    const f = Float32Array.from(j.embedding);
    vecs.v[key] = Buffer.from(f.buffer).toString('base64');
    const keys = Object.keys(vecs.v);
    if (keys.length > 6000) for (const k of keys.slice(0, keys.length - 6000)) delete vecs.v[k];
    saveSoon('embed', EMBED_FILE, vecs);
    return f;
  } catch { embedDownUntil = Date.now() + 5 * 60 * 1000; return null; }
}

// ─── Candidate pairs ─────────────────────────────────────────────────────────

async function candidatePairs(entries) {
  const toks = entries.map(e => tokens(e.title));
  const vs = [];
  for (const e of entries) vs.push(await embed(`${cleanTitle(e.title)}. ${String(e.text || '').replace(/\s+/g, ' ').slice(0, 300)}`));
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const lex = jaccard(toks[i], toks[j]);
      const cos = vs[i] && vs[j] ? cosine(vs[i], vs[j]) : 0;
      if (lex >= LEX_THRESHOLD || cos >= EMBED_THRESHOLD) out.push({ a: entries[i], b: entries[j], score: Math.max(lex, cos) });
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, MAX_CANDIDATES);
}

// ─── The judge ───────────────────────────────────────────────────────────────

function buildPrompt(pairs) {
  const line = (e) => `${String(e.title || '').replace(/\s+/g, ' ').slice(0, 180)}${e.source ? ' — ' + String(e.source).slice(0, 40) : ''}${e.text ? ' — ' + String(e.text).replace(/\s+/g, ' ').slice(0, 320) : ''}`;
  return `You are an editor at a news desk. Decide whether two items are COPIES of the same story: the same article republished, or two outlets reporting the very same event, announcement, or finding, where reading one would teach you essentially nothing new beyond the other.

Answer "different" for ALL of these, even when the topic, company, or people are the same:
- explainers, guides, definitions, backgrounders, encyclopedia or reference pages
- opinion, analysis, commentary, or a deeper dive on an event
- lists, roundups, databases, trackers, annual reports, press-release or landing pages
- a follow-up, a reaction, or a consequence of an event
- a different incident, announcement, or data point (a second incident at the same company is a different event)
- one organisation's document or statement versus a news report about something else

Answer "same" when both clearly describe the same specific happening: the same actors, the same action, and the same key facts or numbers. Different outlets covering the same happening is exactly what "same" means; wording, headline style, outlet, and number format ("six" versus "6") may all differ. Only answer "different" for a real difference in what happened, never merely because the outlets or wording differ. If the facts differ or it is a different kind of piece, answer "different".

Reply with EXACTLY ${pairs.length} lines, one per pair, in this format and nothing else:
NUMBER|verdict|short reason (under 10 words)
where verdict is same or different.

PAIRS:
${pairs.map((p, i) => `${i + 1}.\nA: ${line(p.a)}\nB: ${line(p.b)}`).join('\n')}`;
}

async function judgeBatch(pairs) {
  const j = await post('/api/chat', {
    model: MODEL, stream: false, think: false,
    messages: [{ role: 'user', content: buildPrompt(pairs) }],
    options: { temperature: 0.1, num_predict: 500 },
  }, 90000);
  const out = {};
  for (const raw of String(j?.message?.content || '').split('\n')) {
    const parts = raw.replace(/^[\s>*\-•]+/, '').trim().split('|');
    if (parts.length < 2) continue;
    const n = Number(String(parts[0]).replace(/[^0-9]/g, ''));
    const v = /same/i.test(parts[1]) && !/not|differen/i.test(parts[1]) ? 'same' : /differen/i.test(parts[1]) ? 'different' : null;
    if (Number.isInteger(n) && n >= 1 && n <= pairs.length && v && !out[n]) out[n] = { v, why: parts.slice(2).join('|').trim().slice(0, 100) };
  }
  return out;
}

// One run at a time: the judge shares the GPU with everything else.
let queue = Promise.resolve();
function groupEntries(entries) {
  const run = () => groupNow(entries);
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

async function groupNow(entries) {
  const stats = { entries: entries.length, candidates: 0, cached: 0, judged: 0, failed: 0, ms: 0 };
  const t0 = Date.now();
  const list = (entries || []).filter(e => e && e.id && e.title);
  if (list.length < 2) return stats;
  const cands = await candidatePairs(list);
  stats.candidates = cands.length;
  const todo = [];
  for (const c of cands) { if (verdicts.pairs[pairKey(c.a.id, c.b.id)]) stats.cached++; else todo.push(c); }
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    let got = {};
    try { got = await judgeBatch(chunk); } catch { /* leave uncached; retried on the next run */ }
    const missing = chunk.map((_, k) => k).filter(k => !got[k + 1]);
    if (missing.length && missing.length < chunk.length) {
      try { const r = await judgeBatch(missing.map(k => chunk[k])); missing.forEach((k, n) => { if (r[n + 1]) got[k + 1] = r[n + 1]; }); } catch { /* ignore */ }
    }
    chunk.forEach((c, k) => {
      const g = got[k + 1];
      if (g) { verdicts.pairs[pairKey(c.a.id, c.b.id)] = { v: g.v, why: g.why, at: Date.now() }; stats.judged++; }
      else stats.failed++;
    });
    saveSoon('verdicts', VERDICT_FILE, verdicts);
  }
  const keys = Object.keys(verdicts.pairs);
  if (keys.length > MAX_PAIRS) { for (const k of keys.slice(0, keys.length - MAX_PAIRS)) delete verdicts.pairs[k]; saveSoon('verdicts', VERDICT_FILE, verdicts); }
  stats.ms = Date.now() - t0;
  return stats;
}

// ─── Clusters from cached verdicts (instant) ─────────────────────────────────

// Returns Map(id -> { gid, size, members:[ids] }) for ids that share a group of two or more. `separate` is a Set of ids to leave alone.
function clustersFor(ids, separate) {
  const list = [...new Set(ids)].filter(id => !(separate && separate.has(id)));
  const verdictOf = (x, y) => (verdicts.pairs[pairKey(x, y)] || {}).v || '';
  // Best-first average-linkage clustering over the judge's verdicts: same = +1, different = -1, never judged = 0.
  // Two groups join when the average across all their cross pairs is clearly positive, so one noisy verdict can neither
  // split a real group nor chain unrelated articles together (A~B and B~C does not make A~C).
  const score = (x, y) => { const v = verdictOf(x, y); return v === 'same' ? 1 : v === 'different' ? -1 : 0; };
  let groups = list.map(id => [id]);
  for (;;) {
    let best = -2, bi = -1, bj = -1;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        let sum = 0, sames = 0;
        for (const x of groups[i]) for (const y of groups[j]) { const sc = score(x, y); sum += sc; if (sc === 1) sames++; }
        const mean = sum / (groups[i].length * groups[j].length);
        if (sames && mean > best) { best = mean; bi = i; bj = j; }
      }
    }
    if (best < MERGE_MEAN) break;
    groups[bi] = groups[bi].concat(groups[bj]);
    groups.splice(bj, 1);
  }
  const out = new Map();
  for (const members of groups) {
    if (members.length < 2) continue;
    const arr = members.slice().sort();
    for (const id of arr) out.set(id, { gid: arr[0], size: arr.length, members: arr });
  }
  return out;
}

function stats() {
  return { pairs: Object.keys(verdicts.pairs).length, same: Object.values(verdicts.pairs).filter(v => v.v === 'same').length, embeddings: Object.keys(vecs.v).length, embedModel: EMBED_MODEL, embeddingsAvailable: Date.now() >= embedDownUntil };
}

module.exports = { groupEntries, clustersFor, stats, cleanTitle, tokens };
