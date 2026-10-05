/**
 * Lateral v2 — Prediction tracking with Tavily search and closer/further scoring.
 * Refactored: stories (raw items) + links (prediction+story+stance).
 */

const fs = require('fs');
const https = require('https');

const DATA_DIR = process.env.LATERAL_DATA_DIR || '/data';
const V2_FILE = require('path').join(DATA_DIR, 'v2.json');

// The key can be saved from Lateral's Settings (stored in llm-secrets.json) or supplied via the TAVILY_API_KEY env var.
// Read at call time so a key saved in the UI takes effect immediately, with no restart.
function getTavilyKey() {
  try {
    const f = require('path').join(DATA_DIR, 'llm-secrets.json');
    if (fs.existsSync(f)) {
      const k = String(JSON.parse(fs.readFileSync(f, 'utf8') || '{}').tavilyApiKey || '').trim();
      if (k) return k;
    }
  } catch { /* fall through to env */ }
  return String(process.env.TAVILY_API_KEY || '').trim();
}
const TAVILY_BASE_URL = 'https://api.tavily.com';

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readV2() {
  try {
    ensureDir();
    if (!fs.existsSync(V2_FILE)) return { predictions: [], items: [], links: [], version: '2.1.0' };
    return JSON.parse(fs.readFileSync(V2_FILE, 'utf8'));
  } catch { return { predictions: [], items: [], links: [], version: '2.1.0' }; }
}

function writeV2(data) {
  ensureDir();
  fs.writeFileSync(V2_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function nowIso() { return new Date().toISOString(); }

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ─── Tavily Search ─────────────────────────────────────────────────────────────────

async function tavilySearch({ query, maxResults = 10, searchDepth = 'basic', includeDomains = [], excludeDomains = [] } = {}) {
  const tavilyKey = getTavilyKey();
  if (!tavilyKey) throw new Error('Tavily API key not configured — add it in Settings → Web search');
  const body = JSON.stringify({
    api_key: tavilyKey, query, max_results: maxResults, search_depth: searchDepth,
    include_answer: false, include_raw_content: false, include_images: false,
    include_domains: includeDomains, exclude_domains: excludeDomains,
  });
  return new Promise((resolve, reject) => {
    const req = https.request(TAVILY_BASE_URL + '/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error('Invalid Tavily response: ' + text.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tavily timeout')); });
    req.write(body); req.end();
  });
}

// ─── LLM Scoring (local Ollama — no external API key) ────────────────────────────

const http = require('http');
const SCORING_MODEL = process.env.LATERAL_SCORING_MODEL || process.env.VALE_CHAT_MODEL || 'qwen3:latest';
const VALID_STANCES = new Set(['supports', 'contradicts', 'complicates', 'irrelevant']);

// Ask the local model for a JSON object. think:false keeps qwen3 fast; format:'json' constrains output.
function ollamaJson(prompt, { timeoutMs = 90000, numPredict = 500 } = {}) {
  const base = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  const url = new URL('/api/chat', base);
  const lib = url.protocol === 'https:' ? https : http;
  const body = JSON.stringify({
    model: SCORING_MODEL, stream: false, think: false, format: 'json',
    messages: [{ role: 'user', content: prompt }],
    options: { temperature: 0.1, num_predict: numPredict },
  });
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Ollama HTTP ${res.statusCode}: ${text.slice(0, 120)}`));
        try {
          const content = JSON.parse(text)?.message?.content || '';
          const m = content.match(/\{[\s\S]*\}/);
          if (!m) return reject(new Error('Model returned no JSON'));
          resolve(JSON.parse(m[0]));
        } catch (e) { reject(new Error('Could not parse model JSON: ' + e.message)); }
      });
    });
    req.on('error', e => reject(new Error('Ollama unreachable: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timed out')); });
    req.write(body); req.end();
  });
}

// Score one item against a prediction. Never throws: failures come back as stance 'error'
// (distinct from 'irrelevant') so a broken scorer is visible and retryable.
// Extra legacy args (apiKey, baseUrl) are ignored.
async function scoreItemAgainstPrediction(item, prediction, signals = []) {
  const sigText = signals.length ? signals.map((s, i) => `${i + 1}. ${s.query} (${s.type})`).join('\n') : '(none)';
  const prompt = `You are scoring one news item against a prediction.

PREDICTION: "${prediction.statement}"
${prediction.resolutionDate ? `RESOLVES BY: ${prediction.resolutionDate}\n` : ''}
SIGNALS BEING TRACKED:
${sigText}

NEWS ITEM:
Title: ${item.title || '(untitled)'}
Source: ${item.source || ''}
Summary: ${String(item.summary || '(no summary)').slice(0, 1500)}

TODAY'S DATE: ${new Date().toISOString().slice(0, 10)}

Work in this order: first find the single most relevant FACT in the item, then judge what that fact does to the odds.

Stances (pick the one that best matches the fact):
- "supports": the fact makes the predicted outcome MORE likely.
- "contradicts": the fact makes the predicted outcome LESS likely.
- "complicates": the item is clearly relevant, but you cannot honestly say whether it raises or lowers the odds (it could cut either way, e.g. a buildup that could be deterrence OR preparation), or it contains strong evidence on both sides. It is NOT for items that are merely on-topic (those are "irrelevant").
- "irrelevant": background, history, explainers, calendars, or anything that merely shares the topic without moving the odds.

Rules:
- Absence is not evidence. If the item does not state or clearly imply something concrete about the outcome (a decision, statement, data point, or trend), it is "irrelevant", NOT "contradicts".
- Past events and generic schedules are "irrelevant" unless they directly change the likelihood of the predicted outcome.
- Your stance MUST agree with your reason. If your reason says the item makes the outcome more likely, the stance is "supports"; if less likely, "contradicts".
- If key_fact is "none", the stance must be "irrelevant".

strength = how much this fact moves the odds:
  "decisive": the outcome has effectively happened or been ruled out
  "strong": direct evidence about the outcome itself (an official decision, an explicit statement, hard data on the outcome)
  "indirect": a related trend, development, or partial signal that you must infer from
  "faint": barely relevant
Most items are "indirect". Use "strong" or "decisive" sparingly, only when the item speaks directly to the outcome.
directness = "direct" if the item explicitly states the fact, "inferred" if you are reading between the lines.

Respond ONLY with JSON, keys in this order: {"key_fact":"the specific fact, or none","reason":"one sentence on what that fact does to the odds","stance":"supports|contradicts|complicates|irrelevant","strength":"decisive|strong|indirect|faint","directness":"direct|inferred"}`;
  try {
    const r = await ollamaJson(prompt);
    let stance = String(r.stance || '').toLowerCase().trim();
    if (!VALID_STANCES.has(stance)) throw new Error(`Invalid stance "${r.stance}"`);
    const keyFact = String(r.key_fact || '').trim().toLowerCase();
    if (stance !== 'irrelevant' && (keyFact === 'none' || keyFact === 'n/a')) stance = 'irrelevant'; // no grounding fact -> not evidence
    // Labels -> numbers in code: small models are far more consistent with categories than with 0-100 scales.
    const STRENGTH_W = { decisive: 90, strong: 60, indirect: 30, faint: 10 };
    const label = String(r.strength || '').toLowerCase().trim();
    const numeric = Math.max(0, Math.min(100, Math.round(Number(r.weight) || 0)));
    const weight = STRENGTH_W[label] ?? (numeric || 30);
    const directness = String(r.directness || '').toLowerCase().trim();
    const conf = Number(r.confidence);
    const confidence = directness === 'direct' ? 0.9 : directness === 'inferred' ? 0.6
      : (Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.6);
    return {
      stance,
      weight: stance === 'irrelevant' ? 0 : weight,
      reason: String(r.reason || '').slice(0, 400) || null,
      confidence,
    };
  } catch (e) {
    return { stance: 'error', weight: 0, reason: `Scoring failed: ${e.message}`, confidence: 0 };
  }
}

// Turn a prediction statement into search queries worth tracking.
async function suggestSignals(statement, resolutionDate) {
  const prompt = `You help track a forecast. Given this prediction, propose 4 to 5 web-news search queries that would surface evidence for or against it as events unfold.

PREDICTION: "${statement}"
${resolutionDate ? `RESOLVES BY: ${resolutionDate}\n` : ''}
Each query should be short (3-10 words), specific, and useful for a news search of CURRENT news. Vary the wording. Do NOT append the resolution year or date to the queries unless the query is meaningless without it. Mix these types:
- "indicator": a measurable metric or data release
- "actor": what a key person, company, or government says or does
- "event": a scheduled or trigger event that would settle it

Respond ONLY with JSON: {"signals":[{"query":"...","type":"indicator|actor|event"}]}`;
  const r = await ollamaJson(prompt, { numPredict: 600 });
  const seen = new Set();
  const out = [];
  for (const sg of (Array.isArray(r.signals) ? r.signals : [])) {
    const query = String(sg?.query || '').trim().replace(/\s+/g, ' ');
    const key = query.toLowerCase();
    if (query.length < 6 || query.length > 140 || seen.has(key)) continue;
    seen.add(key);
    out.push({ query, type: ['indicator', 'actor', 'event'].includes(sg.type) ? sg.type : 'indicator' });
    if (out.length >= 6) break;
  }
  if (!out.length) throw new Error('Model did not suggest any usable queries');
  return out;
}

// Roll scored links up into a closer/further reading.
// score: -100 (evidence says it won't happen) .. +100 (evidence says it will). Mixed/complicating items add no direction.
function computeEvidence(links) {
  const c = { supports: 0, contradicts: 0, complicates: 0, irrelevant: 0, pending: 0, error: 0 };
  let sup = 0, con = 0;
  for (const l of links) {
    c[l.stance] = (c[l.stance] || 0) + 1;
    const conf = l.tagger === 'user' || !(l.confidence > 0) ? 1 : l.confidence;
    const w = (Number(l.weight) || 0) * conf;
    if (l.stance === 'supports') sup += w;
    else if (l.stance === 'contradicts') con += w;
  }
  const total = sup + con;
  // Smoothed: a constant prior keeps one or two articles from pinning the score at +/-100.
  const score = total > 0 ? Math.round(((sup - con) / (total + 100)) * 100) : 0;
  const direction = total === 0 ? 'none' : score >= 15 ? 'closer' : score <= -15 ? 'further' : 'mixed';
  const directional = c.supports + c.contradicts;
  const strength = directional === 0 ? 'none' : directional < 3 ? 'thin' : directional < 8 ? 'moderate' : 'solid';
  return { score, direction, strength, ...c, total: links.length, scored: c.supports + c.contradicts + c.complicates + c.irrelevant };
}

// ─── Background search + score jobs (one per prediction) ──────────────────────────
// Scoring runs one article at a time on the local GPU, so a full run can take minutes — far longer
// than Caddy/Cloudflare allow a single request. The client starts a job and polls its status.

const _jobs = new Map();

function publicJob(j) {
  if (!j) return null;
  return {
    id: j.id, predictionId: j.predictionId, state: j.state, phase: j.phase,
    startedAt: j.startedAt, finishedAt: j.finishedAt || null,
    signalsTotal: j.signalsTotal, signalsDone: j.signalsDone, currentSignal: j.currentSignal,
    found: j.found, scored: j.scored, retried: j.retried, errors: j.errors.slice(-5), message: j.message || '',
  };
}

async function scoreAndStoreLink(job, linkId, activeSignals) {
  const v = readV2();
  const link = v.links.find(l => l.id === linkId);
  const item = link && v.items.find(i => i.id === link.itemId);
  const pred = link && v.predictions.find(x => x.id === link.predictionId);
  if (!link || !item || !pred) return;
  const sc = await scoreItemAgainstPrediction(item, pred, activeSignals);
  const v2 = readV2(); // fresh read: the user may have edited things while the model was thinking
  const l2 = v2.links.find(l => l.id === linkId);
  if (!l2 || l2.tagger === 'user') return; // never overwrite a manual review
  Object.assign(l2, { stance: sc.stance, weight: sc.weight, reason: sc.reason, confidence: sc.confidence, tagger: 'llm', scoredAt: nowIso() });
  writeV2(v2);
  if (sc.stance === 'error') job.errors.push(`${String(item.title || item.url).slice(0, 60)}: ${sc.reason}`);
  else job.scored++;
}

async function runSearchJob(job) {
  const first = readV2().predictions.find(x => x.id === job.predictionId);
  if (!first) throw new Error('Prediction not found');
  const signals = (first.signals || []).filter(s => s.active && s.query);
  job.signalsTotal = signals.length;

  for (const sig of signals) {
    job.currentSignal = sig.query;
    job.phase = 'searching';
    let results = [];
    try { results = (await tavilySearch({ query: sig.query, maxResults: 5 })).results || []; }
    catch (e) { job.errors.push(`Search "${sig.query}": ${e.message}`); job.signalsDone++; continue; }

    for (const r of results) {
      if (!r.url) continue;
      const v = readV2();
      if (!v.predictions.find(x => x.id === job.predictionId)) throw new Error('Prediction was deleted');
      let item = v.items.find(i => i.url === r.url);
      if (!item) {
        let host = ''; try { host = new URL(r.url).hostname; } catch {}
        item = {
          id: uuid(), title: r.title, url: r.url, summary: r.content,
          source: r.source || host, publishedAt: r.published_date || nowIso(), fetchedAt: nowIso(),
        };
        v.items.push(item);
      }
      if (v.links.find(l => l.predictionId === job.predictionId && l.itemId === item.id)) { writeV2(v); continue; }
      const link = {
        id: uuid(), predictionId: job.predictionId, itemId: item.id,
        stance: 'pending', weight: 0, reason: null, confidence: 0,
        signalId: sig.id, tagger: 'pending', createdAt: nowIso(),
      };
      v.links.push(link);
      writeV2(v);
      job.found++;
      job.phase = 'scoring';
      await scoreAndStoreLink(job, link.id, signals);
    }
    job.signalsDone++;
  }

  // Retry pass: anything still pending or errored from this or an earlier run.
  const retry = readV2().links.filter(l => l.predictionId === job.predictionId && (l.stance === 'pending' || l.stance === 'error') && l.tagger !== 'user');
  if (retry.length) {
    job.phase = 'retrying';
    job.currentSignal = '';
    for (const l of retry) { await scoreAndStoreLink(job, l.id, signals); job.retried++; }
  }
}

// ─── Route Handlers ──────────────────────────────────────────────────────────────

function handlePredictionsList(res) {
  const v2 = readV2();
  send(res, 200, { predictions: v2.predictions });
}

function handlePredictionCreate(req, res) {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const statement = String(body.statement || '').trim();
      if (!statement) return send(res, 400, { error: 'statement required' });
      const prediction = {
        id: uuid(), statement,
        status: body.status || 'active',
        signals: Array.isArray(body.signals) ? body.signals.map(s => ({
          id: uuid(), query: String(s.query || '').trim(),
          type: s.type || 'indicator', active: s.active !== false,
        })) : [],
        confidence: Number(body.confidence) || 50,
        resolutionDate: body.resolutionDate || null,
        createdAt: nowIso(), updatedAt: nowIso(),
      };
      const v2 = readV2();
      v2.predictions.push(prediction);
      writeV2(v2);
      send(res, 201, { prediction });
    } catch (e) { send(res, 400, { error: e.message }); }
  });
}

function handlePredictionGet(reqUrl, res) {
  const id = require('path').basename(reqUrl.pathname);
  const v2 = readV2();
  const p = v2.predictions.find(x => x.id === id);
  if (!p) return send(res, 404, { error: 'Not found' });
  const links = v2.links.filter(l => l.predictionId === id);
  const items = links.map(l => {
    const item = v2.items.find(i => i.id === l.itemId);
    return { ...item, link: l };
  });
  send(res, 200, { prediction: p, items, evidence: computeEvidence(links) });
}

function handlePredictionPatch(req, reqUrl, res) {
  const id = require('path').basename(reqUrl.pathname);
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const v2 = readV2();
      const idx = v2.predictions.findIndex(x => x.id === id);
      if (idx === -1) return send(res, 404, { error: 'Not found' });
      const p = v2.predictions[idx];
      if (body.statement !== undefined) p.statement = String(body.statement).trim();
      if (body.status !== undefined) p.status = body.status;
      if (body.confidence !== undefined) p.confidence = Number(body.confidence);
      if (Array.isArray(body.signals)) {
        p.signals = body.signals.map(s => ({
          id: s.id || uuid(), query: String(s.query || '').trim(),
          type: s.type || 'indicator', active: s.active !== false,
        })).filter(s => s.query);
      }
      p.updatedAt = nowIso();
      writeV2(v2);
      send(res, 200, { prediction: p });
    } catch (e) { send(res, 400, { error: e.message }); }
  });
}

function handlePredictionDelete(reqUrl, res) {
  const id = require('path').basename(reqUrl.pathname);
  const v2 = readV2();
  v2.predictions = v2.predictions.filter(x => x.id !== id);
  v2.links = v2.links.filter(l => l.predictionId !== id);
  writeV2(v2);
  send(res, 200, { ok: true });
}

// POST /v2/predictions/:id/search — start a background search+score job (returns immediately)
function handlePredictionSearch(req, reqUrl, res) {
  const id = reqUrl.pathname.split('/').filter(Boolean)[2];
  if (!id) return send(res, 400, { error: 'Missing prediction ID' });
  const p = readV2().predictions.find(x => x.id === id);
  if (!p) return send(res, 404, { error: 'Not found' });
  const existing = _jobs.get(id);
  if (existing && existing.state === 'running') return send(res, 202, { job: publicJob(existing), alreadyRunning: true });
  if (!(p.signals || []).some(s => s.active && s.query)) return send(res, 400, { error: 'Add at least one active signal first.' });
  if (!getTavilyKey()) return send(res, 503, { error: 'Tavily API key not configured — add it in Settings → Web search (the ⚙ icon).' });

  const job = {
    id: uuid(), predictionId: id, state: 'running', phase: 'starting', startedAt: nowIso(),
    signalsTotal: 0, signalsDone: 0, currentSignal: '', found: 0, scored: 0, retried: 0, errors: [], message: '',
  };
  _jobs.set(id, job);
  runSearchJob(job)
    .then(() => { job.state = 'done'; job.phase = 'done'; job.message = `Found ${job.found} new article${job.found === 1 ? '' : 's'}, scored ${job.scored}.`; })
    .catch(e => { job.state = 'error'; job.phase = 'error'; job.message = e.message; })
    .finally(() => { job.finishedAt = nowIso(); job.currentSignal = ''; });
  send(res, 202, { job: publicJob(job) });
}

// GET /v2/predictions/:id/search/status — latest job for this prediction (or null)
function handleSearchStatus(reqUrl, res) {
  const id = reqUrl.pathname.split('/').filter(Boolean)[2];
  send(res, 200, { job: publicJob(_jobs.get(id)) });
}

// POST /v2/signals/suggest { statement, resolutionDate? } — suggest signal queries (does not save anything)
function handleSignalsSuggest(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const statement = String(body.statement || '').trim();
      if (!statement) return send(res, 400, { error: 'statement required' });
      const signals = await suggestSignals(statement, body.resolutionDate || null);
      send(res, 200, { signals });
    } catch (e) { send(res, 502, { error: e.message }); }
  });
}

// POST /v2/links/:id/review — user reviews a link
function handleLinkReview(req, reqUrl, res) {
  const parts = reqUrl.pathname.split('/').filter(Boolean);
  const id = parts[2];
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const v2 = readV2();
      const link = v2.links.find(x => x.id === id);
      if (!link) return send(res, 404, { error: 'Link not found' });
      if (body.stance) link.stance = body.stance;
      if (body.weight !== undefined) link.weight = Number(body.weight);
      if (body.reason) link.reason = String(body.reason);
      link.tagger = 'user';
      link.reviewedAt = nowIso();
      writeV2(v2);
      send(res, 200, { link });
    } catch (e) { send(res, 400, { error: e.message }); }
  });
}

// POST /v2/links/:id/score — rescore a link with LLM
async function handleLinkScore(req, reqUrl, res, llmConfig) {
  const parts = reqUrl.pathname.split('/').filter(Boolean);
  const id = parts[2];
  const v2 = readV2();
  const link = v2.links.find(x => x.id === id);
  if (!link) return send(res, 404, { error: 'Link not found' });
  const p = v2.predictions.find(x => x.id === link.predictionId);
  if (!p) return send(res, 404, { error: 'Prediction not found' });
  const item = v2.items.find(x => x.id === link.itemId);
  if (!item) return send(res, 404, { error: 'Item not found' });
  const activeSignals = (p.signals || []).filter(sig => sig.active);
  const result = await scoreItemAgainstPrediction(item, p, activeSignals);
  link.stance = result.stance;
  link.weight = result.weight;
  link.reason = result.reason;
  link.confidence = result.confidence;
  link.tagger = 'llm';
  link.scoredAt = nowIso();
  writeV2(v2);
  send(res, 200, { link, item });
}

// GET /v2/items — list raw items
function handleItemsList(reqUrl, res) {
  const v2 = readV2();
  send(res, 200, { items: v2.items });
}

// GET /v2/links — list links, optionally filtered by prediction
function handleLinksList(reqUrl, res) {
  const predictionId = reqUrl.searchParams.get('predictionId');
  const v2 = readV2();
  let links = v2.links;
  if (predictionId) links = links.filter(l => l.predictionId === predictionId);
  // Attach item data
  const withItems = links.map(l => {
    const item = v2.items.find(i => i.id === l.itemId);
    return { ...l, item };
  });
  send(res, 200, { links: withItems });
}

// ─── Programmatic evidence API ───────────────────────────────────────────────────────────
// POST /v2/items — add an article as evidence, optionally linked to a prediction with a stance. Lets scripts and other
// tools feed Lateral directly instead of going through search.
//   { title, url, summary?, source?, publishedAt?, predictionId?, stance?, weight?, reason?, confidence? }

function handleItemCreate(req, res) {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const title = String(body.title || '').trim();
      const url = String(body.url || '').trim();
      if (!title || !/^https?:\/\//i.test(url)) return send(res, 400, { error: 'title and a valid http(s) url are required' });
      const v2 = readV2();
      if (body.predictionId && !v2.predictions.find(x => x.id === body.predictionId)) return send(res, 404, { error: 'Prediction not found' });
      let item = v2.items.find(i => i.url === url);
      if (!item) {
        item = {
          id: uuid(), title, url,
          summary: String(body.summary || '').trim(),
          source: body.source || '',
          publishedAt: body.publishedAt || nowIso(),
          fetchedAt: nowIso(), addedBy: 'api', addedAt: nowIso(),
        };
        v2.items.push(item);
      }
      let link = null;
      if (body.predictionId && !v2.links.find(l => l.predictionId === body.predictionId && l.itemId === item.id)) {
        link = {
          id: uuid(), predictionId: body.predictionId, itemId: item.id,
          stance: ['supports', 'contradicts', 'complicates', 'irrelevant'].includes(body.stance) ? body.stance : 'pending',
          weight: Math.max(0, Math.min(100, Number(body.weight) || 0)),
          reason: body.reason ? String(body.reason).slice(0, 400) : null,
          confidence: Math.max(0, Math.min(1, Number(body.confidence) || 0)),
          // Linked without a stance -> left 'pending' so the next Search & score pass will score it.
          tagger: body.stance ? 'user' : 'pending', createdAt: nowIso(),
        };
        v2.links.push(link);
      }
      writeV2(v2);
      send(res, 201, { item, link });
    } catch (e) { send(res, 400, { error: e.message }); }
  });
}

// Optional local route extensions: a git-ignored proxy/v2.local.js may export
//   route(req, reqUrl, res, { readV2, writeV2, uuid, nowIso, send })  ->  false if it did not handle the request.
let _localExt;
function localExtension() {
  if (_localExt === undefined) { try { _localExt = require('./v2.local'); } catch { _localExt = null; } }
  return _localExt;
}

// ─── Main Router ──────────────────────────────────────────────────────────────

function route(req, reqUrl, res, llmConfig) {
  const pathname = reqUrl.pathname || '/';

  // Predictions
  if (pathname === '/v2/predictions' && req.method === 'GET') return handlePredictionsList(res);
  if (pathname === '/v2/predictions' && req.method === 'POST') return handlePredictionCreate(req, res);
  if (pathname.startsWith('/v2/predictions/') && pathname.endsWith('/search/status') && req.method === 'GET') {
    return handleSearchStatus(reqUrl, res);
  }
  if (pathname.startsWith('/v2/predictions/') && req.method === 'GET' && !pathname.endsWith('/search')) {
    return handlePredictionGet(reqUrl, res);
  }
  if (pathname.startsWith('/v2/predictions/') && req.method === 'PATCH') {
    return handlePredictionPatch(req, reqUrl, res);
  }
  if (pathname.startsWith('/v2/predictions/') && req.method === 'DELETE') {
    return handlePredictionDelete(reqUrl, res);
  }
  if (pathname.endsWith('/search') && pathname.startsWith('/v2/predictions/') && req.method === 'POST') {
    return handlePredictionSearch(req, reqUrl, res);
  }
  if (pathname === '/v2/signals/suggest' && req.method === 'POST') return handleSignalsSuggest(req, res);

  // Links
  if (pathname === '/v2/links' && req.method === 'GET') return handleLinksList(reqUrl, res);
  if (pathname === '/v2/items' && req.method === 'GET') return handleItemsList(reqUrl, res);
  if (pathname.endsWith('/review') && pathname.startsWith('/v2/links/') && req.method === 'POST') {
    return handleLinkReview(req, reqUrl, res);
  }
  if (pathname.endsWith('/score') && pathname.startsWith('/v2/links/') && req.method === 'POST') {
    return handleLinkScore(req, reqUrl, res, llmConfig);
  }

  // Report page
  if (pathname === '/v2/report' && req.method === 'GET') {
    const fs = require('fs');
    const path = require('path');
    const reportPath = path.join(__dirname, 'report.html');
    try {
      const html = fs.readFileSync(reportPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return true;
    } catch (e) {
      send(res, 500, { error: 'Report not found' });
      return true;
    }
  }

  // Programmatic evidence API
  if (pathname === '/v2/items' && req.method === 'POST') return handleItemCreate(req, res);

  // Local extensions (optional, git-ignored)
  const ext = localExtension();
  if (ext && typeof ext.route === 'function') {
    const handled = ext.route(req, reqUrl, res, { readV2, writeV2, uuid, nowIso, send });
    if (handled !== false) return handled === undefined ? true : handled;
  }

  return false; // not handled
}

module.exports = { route, tavilySearch, scoreItemAgainstPrediction, suggestSignals, computeEvidence };
