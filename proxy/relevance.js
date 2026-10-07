'use strict';
/**
 * Lateral — AI relevance gate.
 *
 * Search engines match on keywords, so "military duty" in a football story ends up under "Military AI Ethics".
 * This module asks the local model to actually read each article against the topic it was filed under and
 * says whether it belongs. It never deletes anything itself: callers move "off_topic" articles into a
 * "Filtered out" list the user can review and restore.
 *
 * Design rules:
 *  - FAIL OPEN. If the model is down, slow, or skips an article, that article is kept. A broken judge must
 *    never cost anyone results.
 *  - Verdicts are cached per (topic, url) so a refresh only judges articles it hasn't seen.
 *  - A manual "restore" is stored as an override and always wins over the model.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const DATA_DIR = process.env.LATERAL_DATA_DIR || '/data';
const CACHE_FILE = path.join(DATA_DIR, 'relevance-cache.json');
const MODEL = process.env.LATERAL_RELEVANCE_MODEL || process.env.VALE_CHAT_MODEL || 'qwen3:latest';
const BATCH_SIZE = 8;            // small batches: the model sometimes stops early on long lists
const DEADLINE_MS = 50000;       // stay well inside Caddy's 90s / Cloudflare's 100s limits
const MAX_ENTRIES = 8000;
const MAX_ARTICLES = 60;

// ─── Verdict cache ───────────────────────────────────────────────────────────

let _cache = null;
function loadCache() {
  if (_cache) return _cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    _cache = parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed : { entries: {} };
  } catch { _cache = { entries: {} }; }
  return _cache;
}
function saveCache() {
  const c = loadCache();
  const keys = Object.keys(c.entries);
  if (keys.length > MAX_ENTRIES) {
    // Drop the oldest tenth, but never a manual override.
    keys.filter(k => !c.entries[k].manual).sort((a, b) => (c.entries[a].at || 0) - (c.entries[b].at || 0))
      .slice(0, Math.ceil(MAX_ENTRIES / 10)).forEach(k => { delete c.entries[k]; });
  }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c), 'utf8');
  } catch (e) { console.warn('[Relevance] could not save cache:', e.message); }
}

function topicKey(topic) { return String(topic || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function keyFor(topic, url) {
  return crypto.createHash('sha1').update(topicKey(topic) + '\n' + String(url || '')).digest('hex').slice(0, 20);
}

// ─── Model call ──────────────────────────────────────────────────────────────

// Plain-text call. JSON-constrained decoding (format:'json') made the model stop after a single entry whenever the
// prompt carried topic context, so verdicts are requested as simple "NUMBER|verdict|reason" lines instead.
function ollamaText(prompt, { timeoutMs = 60000, numPredict = 900 } = {}) {
  const base = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  const url = new URL('/api/chat', base);
  const lib = url.protocol === 'https:' ? https : http;
  const body = JSON.stringify({
    model: MODEL, stream: false, think: false,
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
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Ollama HTTP ${res.statusCode}`));
        try { resolve(String(JSON.parse(text)?.message?.content || '')); }
        catch (e) { reject(new Error('Could not read model response')); }
      });
    });
    req.on('error', e => reject(new Error('Ollama unreachable: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timed out')); });
    req.write(body); req.end();
  });
}

// The model occasionally mangles labels ("on,topic"), so match loosely instead of trusting the exact string.
function normalizeVerdict(raw) {
  const t = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return null;
  if (t.includes('off')) return 'off_topic';
  if (t.includes('related')) return 'related';
  if (t.startsWith('on')) return 'on_topic';
  return null;
}

function buildPrompt(ctx, articles) {
  const lines = articles.map((a, i) => {
    const src = String(a.source || '').slice(0, 60);
    const snip = String(a.snippet || '').replace(/\s+/g, ' ').slice(0, 160);
    return `${i + 1}. ${String(a.title || '').slice(0, 200)} — ${src} — ${snip}`;
  });
  return `You are a strict relevance editor for a news-tracking app. Decide whether each article belongs under the topic it was filed under.

TOPIC: "${ctx.topic}"
${ctx.ctx ? `ABOUT THE TOPIC: ${ctx.ctx}\n` : ''}${ctx.tags ? `TAGS: ${ctx.tags}\n` : ''}
For each article choose one verdict:
- "on_topic": reports a development, event, statement, or analysis directly about the topic.
- "related": not directly about the topic, but a clearly connected actor, cause, consequence, or essential background that a reader following this topic would want.
- "off_topic": shares a word or name with the topic but is about something else; or is generic, a listicle, an advertisement, spam, a bare index/category page, or an entirely different subject.

Rules:
- Judge the article's SUBJECT, not keyword overlap. A shared name or term alone does not make it relevant.
- Be strict about articles that are clearly about something else: if a reader browsing this topic would be puzzled or annoyed to see it, it is "off_topic".
- "related" is for something a follower of THIS topic would specifically want: it names the topic's actors, event, place or subject. General news about a whole sector or theme ("AI", "the markets", "tech", "the economy", "the military") is NOT related just because the topic sits inside it: that is "off_topic".
- But give plausible matches the benefit of the doubt. Headlines and snippets are short and often leave out context. If the article could easily be about the same subject using different words (an alternate name, a nickname, or a description of the same event), choose "related", NOT "off_topic". Choose "off_topic" only when you can tell the article is about a different subject.

Reply with EXACTLY ${articles.length} lines, one per article, in this format and nothing else:
NUMBER|verdict|short reason (under 12 words)
where verdict is on_topic, related, or off_topic.

ARTICLES:
${lines.join('\n')}`;
}

// Returns { [1-based index]: { v, why } } for the articles the model actually answered.
async function judgeBatch(ctx, articles) {
  const text = await ollamaText(buildPrompt(ctx, articles));
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[\s>*\-•]+/, '').trim();
    const parts = line.split('|');
    if (parts.length < 2) continue;
    const id = Number(String(parts[0]).replace(/[^0-9]/g, ''));
    const v = normalizeVerdict(parts[1]);
    if (Number.isInteger(id) && id >= 1 && id <= articles.length && v && !out[id]) {
      out[id] = { v, why: parts.slice(2).join('|').trim().slice(0, 140) };
    }
  }
  return out;
}

// ─── Key terms (the strict guard) ────────────────────────────────────────────

const STOPW = new Set('the and for with from that this these those about into over under after before amid new says said have has had are was were will its their them they what when where which while than then also not but how why who all any can may our out one two get got via'.split(' '));
// Words that appear in generated story titles without naming anything ("The Rise and Controversy of …").
const GENERIC = new Set('impact rise rises race future global world american america leadership controversy ethical ethics dilemmas usage use using uncovering unveiling journey quest generational building dominance project projects mission status report reports news latest update updates story stories policy policies issue issues crisis debate system systems technology tech security national international government states state public risk risks'.split(' '));
const stem = w => (w.length > 5 ? w.replace(/(ing|ed|es|s)$/, '') : w);
function termSet(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/)) {
    const t = w.replace(/^['-]+|['-]+$/g, '');
    if (!t || STOPW.has(t) || GENERIC.has(t) || (t.length < 3 && !/^[a-z]+\d|^\d+[a-z]/.test(t))) continue;
    if (/^\d+$/.test(t) && t.length < 3) continue;
    out.add(stem(t));
  }
  return out;
}
function topicTerms(ctx) { return termSet(`${ctx.topic || ''} ${ctx.tags || ''}`); }
// How many of the story's terms an article's headline and snippet contain (a longer word may continue a term: "tariffs" for "tariff").
function termOverlap(terms, a) {
  const have = termSet(`${a.title || ''} ${a.snippet || ''}`);
  let n = 0;
  for (const t of terms) { if (have.has(t) || (t.length >= 5 && [...have].some(h => h.startsWith(t)))) n++; }
  return n;
}

// A topic or tag word in the article is enough. Failing that, the story's own summary can vouch for it, but it takes two of its words
// (a title like "Lost City of Central Asia" may be covered as an "Atlantis-like metropolis in Kyrgyzstan").
function contextTerms(ctx, exclude) {
  const out = new Set();
  for (const t of termSet(ctx.ctx || '')) if (!exclude || !exclude.has(t)) out.add(t);
  return out;
}
function isWeakMatch(ctx, a) {
  const terms = topicTerms(ctx);
  if (!terms.size) return false;                                   // nothing to compare against: do not guess
  if (termOverlap(terms, a) > 0) return false;
  return termOverlap(contextTerms(ctx, terms), a) < 2;
}

// ─── Story-level gate (the server's background refresh and sweep use this) ───

// The same context the app builds for a story: its title, a line of summary and its first tags. strict = the guard above is on.
function storyContext(story) {
  return {
    topic: String(story && story.title || '').replace(/\s*\(Prediction\)\s*$/, '').trim(),
    ctx: String(story && story.summary || '').replace(/\s+/g, ' ').slice(0, 280),
    tags: ((story && story.tags) || []).slice(0, 6).join(', '),
    strict: true,
  };
}

// Judges a story's articles. Official items (Civic watches) are never second-guessed; anything not judged is kept (fail open).
// -> { kept, filtered, stats }, where each filtered article carries relevance:{why, topic} like the app's own "Filtered out" list.
async function gateStory(story, articles) {
  const list = Array.isArray(articles) ? articles : [];
  const rctx = storyContext(story);
  const checkable = list.filter(a => a && a.url && a.title && !(a.source && a.source.engine === 'civic'));
  if (!rctx.topic || !checkable.length) return { kept: list, filtered: [], stats: null };
  try {
    const out = await checkArticles(rctx, checkable.map(a => ({ url: a.url, title: a.title, snippet: String(a.snippet || a.summary || '').slice(0, 200), source: (a.source && (a.source.name || a.source.domain)) || '' })));
    const kept = [], filtered = [];
    for (const a of list) {
      const v = a && a.url ? out.verdicts[a.url] : null;
      if (v && v.v === 'off_topic' && !v.manual) filtered.push({ ...a, relevance: { why: v.why || '', topic: rctx.topic } });
      else kept.push(a);
    }
    return { kept, filtered, stats: out.stats };
  } catch (e) { return { kept: list, filtered: [], stats: { error: e.message } }; }
}
// Newly filtered first, then earlier ones that are still filtered (and not since kept), capped.
function mergeFiltered(prev, fresh, kept) {
  const keptUrls = new Set((kept || []).map(a => a.url));
  const out = new Map();
  for (const a of (fresh || [])) if (a && a.url) out.set(a.url, a);
  for (const a of (prev || [])) if (a && a.url && !keptUrls.has(a.url) && !out.has(a.url)) out.set(a.url, a);
  return [...out.values()].slice(0, 80);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * ctx: { topic, ctx?, tags? }   articles: [{ url, title, snippet?, source? }]
 * Returns { verdicts: { [url]: { v, why, cached, manual } }, stats }. A URL missing from `verdicts` was not
 * judged (error, timeout, or skipped by the model) and must be treated as KEPT.
 */
// Requests are queued one at a time. The app can fire the same check several times at once (e.g. the Home feed
// refreshing twice at startup); run in parallel they would all miss the cache together and fight over the GPU.
// Queued, the second request finds the first one's verdicts already cached and returns almost instantly.
let _queue = Promise.resolve();
function checkArticles(ctx, articles) {
  const arrivedAt = Date.now();
  const run = () => checkArticlesNow(ctx, articles, arrivedAt);
  const p = _queue.then(run, run);
  _queue = p.catch(() => {});
  return p;
}

async function checkArticlesNow(ctx, articles, arrivedAt) {
  const t0 = arrivedAt || Date.now(); // the deadline includes time spent waiting in the queue
  const stats = { total: 0, cached: 0, judged: 0, failedOpen: 0, timedOut: 0, errors: [], ms: 0 };
  const verdicts = {};
  const cache = loadCache();
  const list = (Array.isArray(articles) ? articles : []).filter(a => a && a.url).slice(0, MAX_ARTICLES);
  stats.total = list.length;

  const todo = [];
  const seen = new Set();
  for (const a of list) {
    if (seen.has(a.url)) continue;
    seen.add(a.url);
    const k = keyFor(ctx.topic, a.url);
    const hit = cache.entries[k];
    if (hit) { verdicts[a.url] = { v: hit.v, why: hit.why || '', cached: true, manual: !!hit.manual }; stats.cached++; }
    else todo.push({ a, k });
  }

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    if (Date.now() - t0 > DEADLINE_MS) { stats.timedOut += todo.length - i; break; }
    const chunk = todo.slice(i, i + BATCH_SIZE);
    let got = {};
    try { got = await judgeBatch(ctx, chunk.map(x => x.a)); }
    catch (e) { stats.errors.push(e.message); }

    // The model sometimes answers only the first few. Ask once more about just the ones it skipped.
    const missingIdx = chunk.map((_, j) => j).filter(j => !got[j + 1]);
    if (missingIdx.length && missingIdx.length < chunk.length && Date.now() - t0 < DEADLINE_MS) {
      try {
        const retry = await judgeBatch(ctx, missingIdx.map(j => chunk[j].a));
        missingIdx.forEach((j, n) => { if (retry[n + 1]) got[j + 1] = retry[n + 1]; });
      } catch (e) { stats.errors.push(e.message); }
    }

    chunk.forEach((x, j) => {
      const g = got[j + 1];
      if (g) {
        verdicts[x.a.url] = { v: g.v, why: g.why, cached: false };
        cache.entries[x.k] = { v: g.v, why: g.why, at: Date.now() };
        stats.judged++;
      } else {
        stats.failedOpen++;
      }
    });
  }

  // Strict mode (tracked stories): a "related" verdict is only believed when the article actually shares key words with the story.
  // The model is generous with "related"; an article that mentions none of the story's names, places or subjects is not one.
  if (ctx.strict) {
    for (const a of list) {
      const v = verdicts[a.url];
      if (!v || v.v !== 'related' || v.manual) continue;
      if (isWeakMatch(ctx, a)) { verdicts[a.url] = { v: 'off_topic', why: 'Weak match: shares no key terms with this topic', cached: v.cached, guard: true }; stats.guarded = (stats.guarded || 0) + 1; }
    }
  }

  if (stats.judged > 0) saveCache();
  stats.ms = Date.now() - t0;
  stats.errors = [...new Set(stats.errors)].slice(0, 3);
  return { verdicts, stats };
}

// "Restore" from the UI: remembered forever (until the user changes it), and always beats the model.
function setOverride(topic, url, verdict = 'on_topic') {
  if (!topicKey(topic) || !url) return false;
  const v = normalizeVerdict(verdict) || 'on_topic';
  loadCache().entries[keyFor(topic, url)] = { v, why: 'Restored by you', at: Date.now(), manual: true };
  saveCache();
  return true;
}

module.exports = { checkArticles, setOverride, normalizeVerdict, ollamaText, gateStory, mergeFiltered, storyContext, topicTerms, termOverlap, termSet, isWeakMatch };
