'use strict';
// Saved copies of articles: a readable text snapshot of every article you track, so timelines survive link rot,
// plus full-text search across them. Stored as one JSON file per article under <data>/archive/.
//
//   POST /archive/save      { url, title?, storyId? }        save now (waits, returns a summary)
//   POST /archive/queue     { articles:[{url,title,storyId}] } save in the background
//   POST /archive/backfill                                   queue every article already in your stories and predictions
//   POST /archive/status    { urls:[...] }                   which of these are saved?
//   GET  /archive/get       ?key=… | ?url=…                  one saved article with its text
//   GET  /archive/search    ?q=…&limit=                      full-text search
//   GET  /archive/list      ?storyId=&limit=                 newest first
//   DELETE /archive/item    ?key=…                           forget one
//   GET  /archive/stats
//
// Order of attack for each page: a plain fetch + readable-text extraction (free); Tavily Extract only if the site
// blocks us or yields too little text (shares the daily Extract budget with the image pipeline).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const images = require('./images');

const DATA_DIR = process.env.LATERAL_DATA_DIR || '/data';
const DIR = path.join(DATA_DIR, 'archive');
const INDEX_FILE = path.join(DIR, 'index.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_HTML = 2 * 1024 * 1024;
const MAX_TEXT = 400000;
const MIN_WORDS = 120;                       // fewer than this and we try harder (or give up)
const RETRY_FAILED_MS = 6 * 3600 * 1000;
const CONCURRENCY = 2;

fs.mkdirSync(DIR, { recursive: true });

// ─── Index ───────────────────────────────────────────────────────────────────

let index = (() => {
  try { const j = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); return { items: j.items || {}, alias: j.alias || {}, failed: j.failed || {} }; }
  catch { return { items: {}, alias: {}, failed: {} }; }
})();
let indexTimer = null;
function saveIndexSoon() {
  if (indexTimer) return;
  indexTimer = setTimeout(() => {
    indexTimer = null;
    try { const tmp = INDEX_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(index)); fs.renameSync(tmp, INDEX_FILE); } catch { /* next time */ }
  }, 800);
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|cmpid|ocid|ito|cid|smid|igshid)$/i;
function normalizeUrl(u) {
  try {
    const x = new URL(String(u).trim());
    x.hash = '';
    x.hostname = x.hostname.toLowerCase();
    [...x.searchParams.keys()].forEach(k => { if (TRACKING.test(k)) x.searchParams.delete(k); });
    x.searchParams.sort();
    let s = x.toString();
    if (x.pathname.length > 1) s = s.replace(/\/(\?|$)/, '$1');
    return s;
  } catch { return ''; }
}
function keyFor(u) { const n = normalizeUrl(u); return n ? crypto.createHash('sha1').update(n).digest('hex').slice(0, 16) : ''; }
function resolveKey(u) { const k = keyFor(u); return index.alias[k] || k; }
function docFile(key) { return path.join(DIR, `${key}.json`); }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } }

// ─── Text extraction ─────────────────────────────────────────────────────────

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', copy: '©' };
function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-z]+);/gi, (m, n) => (NAMED[n.toLowerCase()] !== undefined ? NAMED[n.toLowerCase()] : m));
}
// Inline tags vanish without a gap (so "<a>word</a>," stays "word,"); everything else becomes a space. Footnote markers
// like [1] or [a] and "[citation needed]" are dropped, and spaces before punctuation tidied.
function stripTags(s) {
  return decode(String(s || '')
    .replace(/<\/?(a|span|b|i|em|strong|u|sup|sub|small|mark|abbr|cite|time|font|bdi|q|s)\b[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\[\s*(?:[a-z]{1,2}|\d{1,3}|citation needed|note \d+)\s*\]/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .trim();
}
function wordCount(t) { return (String(t).match(/\S+/g) || []).length; }

function metaContent(html, names) {
  for (const n of names) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, 'i');
    const m = html.match(re1) || html.match(re2);
    if (m && m[1].trim()) return decode(m[1]).trim();
  }
  return '';
}

function ldArticle(html) {
  const out = {};
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let j; try { j = JSON.parse(m[1].trim()); } catch { continue; }
    const stack = Array.isArray(j) ? [...j] : [j];
    while (stack.length) {
      const o = stack.shift();
      if (!o || typeof o !== 'object') continue;
      if (Array.isArray(o['@graph'])) stack.push(...o['@graph']);
      const t = [].concat(o['@type'] || []).join(' ');
      if (/Article|BlogPosting|NewsStory|Report/i.test(t)) {
        if (!out.headline && o.headline) out.headline = String(o.headline);
        if (!out.body && typeof o.articleBody === 'string') out.body = o.articleBody;
        if (!out.published && o.datePublished) out.published = String(o.datePublished);
        if (!out.author && o.author) { const a = [].concat(o.author).map(x => (typeof x === 'string' ? x : x && x.name)).filter(Boolean); if (a.length) out.author = a.slice(0, 3).join(', '); }
        if (!out.site && o.publisher && o.publisher.name) out.site = String(o.publisher.name);
      }
    }
  }
  return out;
}

const BOILER_START = /^(advertisement|sponsored|related( stories| articles| coverage)?|read more|read next|also read|share( this)?|sign up|subscribe|follow us|copyright|©|all rights reserved|click here|we use cookies|cookie|newsletter|more from|recommended|trending|most read|up next|watch:|photo:|image:|getty images|associated press|the associated press)/i;
const BOILER_ANY = /(subscribe to our|sign up for our|accept (all )?cookies|privacy policy|terms of (use|service)|log in to comment|enable javascript)/i;

function blocksFrom(container) {
  const out = [];
  const re = /<(h[2-4]|p|blockquote|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(container))) {
    const tag = m[1].toLowerCase();
    const t = stripTags(m[2]);
    if (!t) continue;
    if (tag[0] === 'h') {
      if (t.length >= 3 && t.length <= 140 && !BOILER_START.test(t)) out.push({ h: true, t });
      continue;
    }
    const sentence = /[.!?"”’)…:]$/.test(t);
    if (tag === 'li' ? t.length < 80 : (t.length < 50 && !(t.length >= 25 && sentence))) continue;
    if (BOILER_START.test(t) || BOILER_ANY.test(t)) continue;
    if (out.length && !out[out.length - 1].h && out[out.length - 1].t === t) continue;
    out.push({ h: false, t });
  }
  // A heading with no paragraph after it is page furniture.
  const kept = [];
  for (let i = 0; i < out.length; i++) { if (out[i].h && (i === out.length - 1 || out[i + 1].h)) continue; kept.push(out[i]); }
  return kept;
}

// Tavily hands back the whole page as text (menus, cookie banners and all). Keep only sentence-like lines.
const LOOSE_JUNK = /(opens in new window|share (on|this|via)|cookie|tracking technolog|targeted advertising|opt (in|out)|your privacy choices|privacy (policy|settings)|terms of (use|service)|newsletter|subscribe|sign (in|up)|log (in|out)|all rights reserved|advertis|sponsored|follow us|download the app|skip to|accessibility|manage .* preferences|^\s*(image|photo|video) \d+)/i;
function cleanLoose(raw) {
  const lines = String(raw || '').replace(/\r/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').split(/\n+/);
  const out = [];
  for (let l of lines) {
    l = l.replace(/^\s*(#{1,6}|[*>-]+)\s*/, '').replace(/\s+/g, ' ').trim();
    if (l.length < 60) continue;
    if (LOOSE_JUNK.test(l) || BOILER_START.test(l)) continue;
    if (!/[.!?"”’)…:]$/.test(l) && l.length < 140) continue;     // a headline-ish fragment or menu item
    if (out.length && out[out.length - 1] === l) continue;
    out.push(l);
  }
  return out.join('\n\n');
}

const MEDIA_HOST = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|twitch\.tv|spotify\.com|soundcloud\.com|podcasts\.apple\.com|instagram\.com|facebook\.com|x\.com|twitter\.com|reddit\.com)$/i;

function bestContainer(clean) {
  let best = '', bestLen = 0;
  const arts = clean.match(/<article\b[\s\S]*?<\/article>/gi) || [];
  for (const a of arts) { const l = (a.match(/<p\b/gi) || []).length; if (l > bestLen) { best = a; bestLen = l; } }
  if (bestLen >= 3) return best;
  const main = clean.match(/<main\b[\s\S]*?<\/main>/i);
  if (main && (main[0].match(/<p\b/gi) || []).length >= 3) return main[0];
  const body = clean.match(/<body\b[\s\S]*<\/body>/i);
  return body ? body[0] : clean;
}

function extractArticle(html, pageUrl) {
  html = String(html || '').slice(0, MAX_HTML);
  const ld = ldArticle(html);
  const meta = {
    title: decode(ld.headline || metaContent(html, ['og:title', 'twitter:title']) || ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')).replace(/\s+/g, ' ').trim(),
    site: decode(metaContent(html, ['og:site_name']) || ld.site || hostOf(pageUrl)).trim(),
    byline: decode(metaContent(html, ['author', 'article:author']) || ld.author || '').replace(/^by\s+/i, '').trim(),
    publishedAt: metaContent(html, ['article:published_time', 'og:article:published_time', 'date', 'pubdate']) || ld.published || ((html.match(/<time[^>]+datetime=["']([^"']+)["']/i) || [])[1] || ''),
    imageUrl: metaContent(html, ['og:image', 'twitter:image']),
  };
  if (meta.byline.length > 120) meta.byline = '';

  const clean = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|form|template|nav|header|footer|aside|figure|figcaption|button|select|dialog)\b[\s\S]*?<\/\1>/gi, ' ');

  let blocks = blocksFrom(bestContainer(clean));
  let text = blocks.map(b => (b.h ? `## ${b.t}` : b.t)).join('\n\n');
  if (wordCount(text) < MIN_WORDS) {
    // The chosen container may have been too narrow; try the whole body, then structured data.
    const all = blocksFrom(clean);
    const alt = all.map(b => (b.h ? `## ${b.t}` : b.t)).join('\n\n');
    if (wordCount(alt) > wordCount(text)) text = alt;
  }
  if (ld.body && wordCount(ld.body) > Math.max(wordCount(text), MIN_WORDS)) {
    const paras = decode(ld.body.replace(/\r/g, '').replace(/<\/p>|<br\s*\/?>/gi, '\n\n').replace(/<[^>]+>/g, ' '))
      .split(/\n\s*\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    text = paras.join('\n\n');
  }
  return { ...meta, text: text.slice(0, MAX_TEXT), words: wordCount(text) };
}

// ─── Fetching ────────────────────────────────────────────────────────────────

async function readLimited(res, max) {
  const reader = res.body.getReader();
  const chunks = []; let n = 0;
  try { while (n < max) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); n += value.length; } }
  finally { try { await reader.cancel(); } catch { /* closed */ } }
  return Buffer.concat(chunks).subarray(0, max);
}
function decodeBody(buf, contentType) {
  let label = ((contentType || '').match(/charset=([\w-]+)/i) || [])[1];
  if (!label) label = (buf.subarray(0, 3000).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  try { return new TextDecoder(label || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}
async function fetchHtml(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(15000),
    });
    if ([401, 403, 429, 503].includes(res.status)) { try { await res.body?.cancel(); } catch { /* ignore */ } return { blocked: true, status: res.status, finalUrl: res.url }; }
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* ignore */ } return { status: res.status }; }
    const ct = res.headers.get('content-type') || '';
    if (ct && !/html|xml/i.test(ct)) { try { await res.body?.cancel(); } catch { /* ignore */ } return { status: res.status, notHtml: true }; }
    const html = decodeBody(await readLimited(res, MAX_HTML), ct);
    const challenge = /Just a moment\.\.\.|cf-chl|Attention Required|Access Denied|captcha/i.test(html.slice(0, 6000)) && wordCount(html.replace(/<[^>]+>/g, ' ')) < 400;
    if (challenge) return { blocked: true, status: res.status, finalUrl: res.url };
    return { html, status: res.status, finalUrl: res.url };
  } catch (e) { return { status: 0, error: e.name === 'TimeoutError' ? 'timed out' : 'network error' }; }
}

// ─── Saving ──────────────────────────────────────────────────────────────────

function addStory(entry, storyId) {
  if (!storyId) return;
  entry.storyIds = entry.storyIds || [];
  if (!entry.storyIds.includes(storyId)) entry.storyIds.push(storyId);
}

const inflight = new Map();
function saveNow(url, opts = {}) {
  const origKey = keyFor(url);
  if (!origKey) return Promise.resolve({ ok: false, reason: 'bad url' });
  if (inflight.has(origKey)) return inflight.get(origKey);
  const p = doSave(url, opts).finally(() => inflight.delete(origKey));
  inflight.set(origKey, p);
  return p;
}

async function doSave(url, { title = '', storyId = '' } = {}) {
  const origKey = keyFor(url);
  let real = url;
  if (images.isGoogleWrapper(url)) {
    real = await images.resolveGoogleNews(url);
    if (!real) return fail(origKey, url, 'could not open the Google News link');
  }
  if (MEDIA_HOST.test(hostOf(real))) return fail(origKey, url, 'video, audio and social pages are not saved as articles');
  const key = keyFor(real);
  if (origKey !== key) index.alias[origKey] = key;

  const have = index.items[key];
  if (have) { addStory(have, storyId); saveIndexSoon(); return { ok: true, cached: true, key, words: have.words, title: have.title }; }

  let method = 'fetch', got = null, finalUrl = real;
  const page = await fetchHtml(real);
  if (page.html) { finalUrl = page.finalUrl || real; got = extractArticle(page.html, finalUrl); }
  if (!got || got.words < MIN_WORDS) {
    const tv = await images.tavilyExtractText(real);
    const loose = tv ? cleanLoose(tv.text) : '';
    if (tv && wordCount(loose) >= MIN_WORDS && wordCount(loose) > (got ? got.words : 0)) {
      const text = loose.slice(0, MAX_TEXT);
      got = { ...(got || { title: '', site: hostOf(real), byline: '', publishedAt: '', imageUrl: '' }), text, words: wordCount(text), imageUrl: (got && got.imageUrl) || tv.image || '' };
      method = 'tavily';
    }
  }
  if (!got || got.words < 40) {
    return fail(origKey, url, page.blocked ? 'the site blocks automated readers' : page.status ? `the page returned HTTP ${page.status}` : (page.error || 'no readable text found'));
  }

  const doc = {
    key, url: real, finalUrl, title: got.title || title || hostOf(real), site: got.site || hostOf(real), byline: got.byline,
    publishedAt: got.publishedAt || '', savedAt: new Date().toISOString(), method, words: got.words,
    imageUrl: got.imageUrl || '', headline: title || '', text: got.text,
  };
  fs.writeFileSync(docFile(key), JSON.stringify(doc));
  const entry = { key, url: doc.url, title: doc.title, site: doc.site, publishedAt: doc.publishedAt, savedAt: doc.savedAt, words: doc.words, method };
  addStory(entry, storyId);
  index.items[key] = entry;
  delete index.failed[origKey]; delete index.failed[key];
  docCache.delete(key);
  saveIndexSoon();
  return { ok: true, key, words: doc.words, title: doc.title, method };
}

function fail(key, url, reason) {
  index.failed[key] = { url, reason, at: Date.now() };
  saveIndexSoon();
  return { ok: false, reason };
}

// ─── Background queue ────────────────────────────────────────────────────────

const queue = [];
const queued = new Set();
let running = 0;
function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift();
    queued.delete(job.key);
    running++;
    saveNow(job.url, job).catch(() => {}).finally(() => { running--; pump(); });
  }
}
// A prediction is tracked as a story of its own (story.predictionId); evidence saved for it belongs to that story.
function storyIdForPrediction(predictionId) {
  if (!predictionId) return '';
  try {
    const stories = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'stories.json'), 'utf8')).stories || [];
    const st = stories.find(x => x.predictionId === predictionId);
    return st ? st.id : '';
  } catch { return ''; }
}

function enqueue(articles) {
  let n = 0, skipped = 0;
  for (let a of articles || []) {
    if (a && a.predictionId && !a.storyId) a = { ...a, storyId: storyIdForPrediction(a.predictionId) };
    const url = String(a && a.url || '').trim();
    if (!/^https?:\/\//i.test(url)) { skipped++; continue; }
    const key = resolveKey(url);
    const f = index.failed[keyFor(url)];
    if (index.items[key] || queued.has(key) || inflight.has(keyFor(url)) || (f && Date.now() - f.at < RETRY_FAILED_MS)) {
      if (index.items[key] && a.storyId) { addStory(index.items[key], a.storyId); saveIndexSoon(); }
      skipped++; continue;
    }
    queued.add(key);
    queue.push({ key, url, title: a.title || '', storyId: a.storyId || '' });
    n++;
  }
  pump();
  return { queued: n, skipped, pending: queue.length + running };
}

// Used by automatic hooks (new episode / new prediction evidence); respects the "keep saved copies" setting.
let _auto = { at: 0, on: true };
function autoEnabled() {
  if (Date.now() - _auto.at > 20000) {
    try { _auto = { at: Date.now(), on: JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8')).archiveAuto !== false }; }
    catch { _auto = { at: Date.now(), on: true }; }
  }
  return _auto.on;
}
function enqueueAuto(articles) { return autoEnabled() ? enqueue(articles) : { queued: 0, skipped: (articles || []).length, pending: queue.length + running, off: true }; }

function backfill() {
  const arts = [];
  try {
    const stories = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'stories.json'), 'utf8')).stories || [];
    for (const s of stories) for (const e of s.episodes || []) if (e.sourceUrl) arts.push({ url: e.sourceUrl, title: e.headline || '', storyId: s.id });
  } catch { /* no stories yet */ }
  try {
    const v2 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'v2.json'), 'utf8'));
    const byItem = new Map();
    for (const l of v2.links || []) {
      // Only articles that bear on a prediction (not the irrelevant search results) are worth keeping.
      if (!['supports', 'contradicts', 'complicates'].includes(l.stance) && l.tagger !== 'user') continue;
      if (!byItem.has(l.itemId)) byItem.set(l.itemId, []);
      byItem.get(l.itemId).push(l.predictionId);
    }
    for (const i of v2.items || []) {
      if (!i.url || !byItem.has(i.id)) continue;
      for (const pid of byItem.get(i.id)) arts.push({ url: i.url, title: i.title || '', predictionId: pid });
    }
  } catch { /* no predictions yet */ }
  // Several entries may share one URL (an article under two stories): keep them all so each story gets linked; dedupe by url + story.
  const seen = new Set();
  const uniq = arts.map(a => (a.predictionId && !a.storyId ? { ...a, storyId: storyIdForPrediction(a.predictionId) } : a))
    .filter(a => { const k = keyFor(a.url) + '|' + (a.storyId || ''); if (!keyFor(a.url) || seen.has(k)) return false; seen.add(k); return true; });
  const distinct = new Set(uniq.map(a => keyFor(a.url))).size;
  return { found: distinct, ...enqueue(uniq) };
}

// ─── Reading and search ──────────────────────────────────────────────────────

const docCache = new Map(); // key -> { title, text, lower }
function loadDoc(key) {
  try { return JSON.parse(fs.readFileSync(docFile(key), 'utf8')); } catch { return null; }
}
function searchable(key) {
  let d = docCache.get(key);
  if (!d) {
    const full = loadDoc(key);
    if (!full) return null;
    d = { title: String(full.title || '').toLowerCase(), lower: String(full.text || '').toLowerCase(), text: full.text || '' };
    docCache.set(key, d);
    if (docCache.size > 1500) docCache.delete(docCache.keys().next().value);
  }
  return d;
}

function parseQuery(q) {
  const terms = [];
  String(q || '').replace(/"([^"]+)"|(\S+)/g, (_, phrase, word) => { const t = String(phrase || word).toLowerCase().trim(); if (t.length >= 2) terms.push(t); return ''; });
  return terms.slice(0, 8);
}
// Terms match at the start of a word ("amy" finds "Amy", not "Pamyra"), case-insensitively; hay is already lower-cased.
function termRe(t) { return new RegExp(`(?<![\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gu'); }
function firstAt(hay, re) { re.lastIndex = 0; const m = re.exec(hay); return m ? m.index : -1; }
function countOf(hay, re, cap) { let n = 0; re.lastIndex = 0; while (n < cap && re.exec(hay)) n++; return n; }

function search(q, limit = 20, storyId = '') {
  const terms = parseQuery(q);
  if (!terms.length) return [];
  const hits = [];
  const res = terms.map(termRe);
  for (const [key, meta] of Object.entries(index.items)) {
    if (!inStory(meta, storyId)) continue;
    const d = searchable(key);
    if (!d) continue;
    let score = 0, ok = true;
    for (const re of res) {
      const inTitle = countOf(d.title, re, 3), inText = countOf(d.lower, re, 10);
      if (!inTitle && !inText) { ok = false; break; }
      score += inTitle * 6 + inText;
    }
    if (!ok) continue;
    const at = firstAt(d.lower, res[0]);
    let snippet = '';
    if (at >= 0) {
      const from = Math.max(0, at - 140), to = Math.min(d.text.length, at + terms[0].length + 200);
      snippet = (from > 0 ? '…' : '') + d.text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < d.text.length ? '…' : '');
    } else snippet = d.text.slice(0, 220).replace(/\s+/g, ' ').trim() + '…';
    hits.push({ ...meta, score, snippet });
  }
  hits.sort((a, b) => b.score - a.score || String(b.savedAt).localeCompare(String(a.savedAt)));
  return hits.slice(0, limit);
}

// storyId '' = everything; '_none' = not linked to any tracked story; otherwise that story.
function inStory(m, storyId) {
  if (!storyId) return true;
  if (storyId === '_none') return !(m.storyIds && m.storyIds.length);
  return (m.storyIds || []).includes(storyId);
}

function list({ storyId = '', limit = 100 } = {}) {
  return Object.values(index.items)
    .filter(m => inStory(m, storyId))
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
    .slice(0, limit);
}

function get(key) { return typeof key === "string" && /^[a-f0-9]{16}$/.test(key) && index.items[key] ? loadDoc(key) : null; }

function remove(key) {
  if (!index.items[key]) return false;
  require("./article-audio").forget(key);
  delete index.items[key];
  for (const [a, k] of Object.entries(index.alias)) if (k === key) delete index.alias[a];
  docCache.delete(key);
  try { fs.unlinkSync(docFile(key)); } catch { /* already gone */ }
  saveIndexSoon();
  return true;
}

function stats() {
  const items = Object.values(index.items);
  return {
    saved: items.length, words: items.reduce((n, i) => n + (i.words || 0), 0),
    viaTavily: items.filter(i => i.method === 'tavily').length,
    failed: Object.keys(index.failed).length, pending: queue.length + running, auto: autoEnabled(),
  };
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

// Returns false if the path is not an archive route.
async function route(req, reqUrl, res, send) {
  const p = reqUrl.pathname.replace(/^\/api\/lateral/, '');
  if (!p.startsWith('/archive/')) return false;
  const sub = p.slice('/archive/'.length);
  const q = reqUrl.searchParams;

  if (sub === 'search' && req.method === 'GET') return send(res, 200, { results: search(q.get('q'), Math.min(100, Number(q.get('limit')) || 20), q.get('storyId') || '') });
  if (sub === 'list' && req.method === 'GET') return send(res, 200, { items: list({ storyId: q.get('storyId') || '', limit: Math.min(500, Number(q.get('limit')) || 100) }) });
  if (sub === 'stats' && req.method === 'GET') return send(res, 200, stats());
  if (sub === 'get' && req.method === 'GET') {
    const key = q.get('key') || (q.get('url') ? resolveKey(q.get('url')) : '');
    const doc = key && index.items[key] ? loadDoc(key) : null;
    return doc ? send(res, 200, { ...doc, storyIds: (index.items[key].storyIds || []) }) : send(res, 404, { error: 'No saved copy of that article.' });
  }
  if (sub === 'item' && req.method === 'DELETE') return send(res, 200, { ok: remove(q.get('key') || '') });
  if (req.method === 'POST') {
    const body = await readBody(req);
    if (sub === 'save') {
      if (!/^https?:\/\//i.test(String(body.url || ''))) return send(res, 400, { error: 'A valid http(s) url is required.' });
      return send(res, 200, await saveNow(String(body.url), { title: body.title || '', storyId: body.storyId || '' }));
    }
    if (sub === 'queue') return send(res, 200, enqueue(Array.isArray(body.articles) ? body.articles.slice(0, 200) : []));
    if (sub === 'backfill') return send(res, 200, backfill());
    if (sub === 'tag') {
      // { key, storyId, remove? } link a saved article to a tracked story, or unlink it
      const m = index.items[String(body.key || '')];
      if (!m || !body.storyId) return send(res, 404, { error: 'No such saved article.' });
      if (body.remove) m.storyIds = (m.storyIds || []).filter(x => x !== body.storyId); else addStory(m, String(body.storyId));
      saveIndexSoon();
      return send(res, 200, { ok: true, storyIds: m.storyIds || [] });
    }
    if (sub === 'status') {
      const out = {};
      for (const u of Array.isArray(body.urls) ? body.urls.slice(0, 300) : []) {
        const key = resolveKey(u), m = index.items[key], f = index.failed[keyFor(u)];
        out[u] = m ? { saved: true, key, words: m.words } : { saved: false, pending: queued.has(key) || inflight.has(keyFor(u)), failed: f ? f.reason : '' };
      }
      return send(res, 200, { status: out });
    }
  }
  return send(res, 404, { error: 'Unknown archive route.' });
}

module.exports = { get, route, enqueue, enqueueAuto, saveNow, search, list, stats, backfill, extractArticle, cleanLoose };
