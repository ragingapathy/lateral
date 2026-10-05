'use strict';
/**
 * Lateral — article image pipeline.
 *
 * Why this exists: ~37% of articles arrive as opaque Google News links (news.google.com/rss/articles/CBMi…).
 * Those can't be fetched, so they never got an image (10% coverage vs 78% for direct links). On top of that, the old
 * fallbacks attached logos, 200px thumbnails, and unrelated stock/art images.
 *
 * Ladder (first candidate that passes every gate wins):
 *   1. Resolve Google News links to the real article URL (cached forever).
 *   2. Read the real page: og:image, twitter:image, JSON-LD, a few large <img>.
 *   3. Pages that block bots: Tavily Extract (budgeted per day, counted for future credit monitoring).
 *   4. Last resort: image search by headline.
 * Every candidate must pass: not a logo/default by name, not a site-wide default (same image on 3+ articles of one
 * domain), a real image of decent size and shape, and a VISION JUDGE — a small local vision model describes the image
 * and the text model decides "real photo?" and "does it fit this headline?".
 * Anything that can't be resolved returns null and the UI shows its fallback card.
 *
 * Fails open everywhere: if the vision models are unavailable the candidate is accepted unjudged.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const DATA_DIR = process.env.LATERAL_DATA_DIR || '/data';
const CACHE_FILE = path.join(DATA_DIR, 'image-cache.json');
const STATS_FILE = path.join(DATA_DIR, 'image-stats.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://vane:8080';
const VISION_MODEL = process.env.LATERAL_VISION_MODEL || 'moondream:latest';
const JUDGE_MODEL = process.env.LATERAL_IMAGE_JUDGE_MODEL || process.env.VALE_CHAT_MODEL || 'qwen3:latest';
const TAVILY_EXTRACT_PER_DAY = Number(process.env.LATERAL_TAVILY_EXTRACT_PER_DAY || 40);
const MIN_W = 300, MIN_H = 160;               // smaller than this looks blurry in a card
const OK_TTL_MS = 45 * 24 * 3600 * 1000;      // a found image is good for six weeks
const MISS_TTL_MS = 12 * 3600 * 1000;         // a miss is retried after half a day
const MAX_ENTRIES = 6000;
const ARTICLE_TIMEOUT_MS = 40000;

// ─── Small utilities ─────────────────────────────────────────────────────────

class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  acquire() { if (this.n > 0) { this.n--; return Promise.resolve(); } return new Promise(r => this.q.push(r)); }
  release() { const next = this.q.shift(); if (next) next(); else this.n++; }
  async run(fn) { await this.acquire(); try { return await fn(); } finally { this.release(); } }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 20);
const todayUtc = () => new Date().toISOString().slice(0, 10);
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } }
function decodeEntities(s) {
  return String(s || '').replace(/&amp;/gi, '&').replace(/&#38;/g, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}
function absUrl(u, base) {
  try { return new URL(decodeEntities(String(u || '').trim()), base).toString(); } catch { return ''; }
}

async function readLimited(res, max) {
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      n += value.length;
    }
  } finally { try { await reader.cancel(); } catch { /* already closed */ } }
  return Buffer.concat(chunks).subarray(0, max);
}

// ─── Persistent cache + stats ────────────────────────────────────────────────

let _cache = null;
function loadCache() {
  if (_cache) return _cache;
  try {
    const p = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    _cache = { entries: p.entries || {}, uses: p.uses || {}, gn: p.gn || {} };
  } catch { _cache = { entries: {}, uses: {}, gn: {} }; }
  return _cache;
}
let _saveTimer = null;
function saveCacheSoon() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const c = loadCache();
    const keys = Object.keys(c.entries);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => (c.entries[a].at || 0) - (c.entries[b].at || 0)).slice(0, Math.ceil(MAX_ENTRIES / 10)).forEach(k => { delete c.entries[k]; });
    }
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(c), 'utf8');
      fs.writeFileSync(STATS_FILE, JSON.stringify(stats), 'utf8');
    } catch (e) { console.warn('[Images] could not save cache:', e.message); }
  }, 4000);
}

function freshStats() {
  return {
    day: todayUtc(), resolved: 0, cacheHits: 0,
    google: { ok: 0, fail: 0 },
    pages: { ok: 0, blocked: 0, fail: 0 },
    probes: { ok: 0, tooSmall: 0, badShape: 0, notImage: 0, error: 0 },
    rejected: { pattern: 0, siteDefault: 0, vision: 0 },
    vision: { judged: 0, unavailable: 0 },
    accepted: {}, misses: 0,
    // Tavily Extract usage. Counted here so credit monitoring can be built on top later (basic extract ≈ 1 credit / 5 URLs).
    tavily: { day: todayUtc(), extractCallsToday: 0, extractCallsTotal: 0, estCreditsTotal: 0, skippedBudget: 0 },
    search: { used: 0 },
  };
}
let stats = (() => { try { return Object.assign(freshStats(), JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'))); } catch { return freshStats(); } })();
function rollDay() {
  const d = todayUtc();
  if (stats.tavily.day !== d) { stats.tavily.day = d; stats.tavily.extractCallsToday = 0; }
}

// ─── Step 1: Google News link resolution ─────────────────────────────────────

const GN_RE = /^https?:\/\/news\.google\.com\/(?:rss\/)?articles\/([^?/#]+)/i;
function isGoogleWrapper(u) { return GN_RE.test(String(u || '')); }

// Older tokens embed the URL directly; the newer opaque ones ("AU_yqL…") must be asked of Google.
function decodeLegacyGoogleId(id) {
  try {
    const buf = Buffer.from(id.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const s = buf.toString('latin1');
    if (s.includes('AU_yqL')) return null;
    const m = s.match(/https?:\/\/[\x21-\x7e]+/);
    return m ? m[0].replace(/[\x00-\x1f].*$/, '') : null;
  } catch { return null; }
}

const gnSem = new Semaphore(2);
let _lastGn = 0;
async function resolveGoogleNewsUncached(url) {
  const id = (url.match(GN_RE) || [])[1];
  if (!id) return null;
  const legacy = decodeLegacyGoogleId(id);
  if (legacy) return legacy;
  const wait = _lastGn + 180 - Date.now();           // gentle pacing so Google doesn't throttle us
  if (wait > 0) await sleep(wait);
  _lastGn = Date.now();
  const page = await fetch(`https://news.google.com/rss/articles/${id}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  const html = await page.text();
  const sg = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1];
  const ts = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
  if (!sg || !ts) throw new Error(`Google gave no signature (HTTP ${page.status})`);
  const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sg}"]`;
  const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));
  const r = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': UA }, body, signal: AbortSignal.timeout(10000),
  });
  if (r.status !== 200) throw new Error(`Google batchexecute HTTP ${r.status}`);
  const text = await r.text();
  const part = text.split('\n\n')[1] || '';
  let parsed;
  try { parsed = JSON.parse(part.slice(0, -2)); } catch { parsed = JSON.parse(part.trim().replace(/,?\s*\d+\s*$/, '')); }
  const real = JSON.parse(parsed[0][2])[1];
  if (!/^https?:\/\//i.test(real)) throw new Error('Google returned no URL');
  return real;
}

// Cached forever (an article's real URL never changes); failures are remembered briefly so we don't hammer Google.
async function resolveGoogleNews(url) {
  const id = (url.match(GN_RE) || [])[1];
  if (!id) return null;
  const c = loadCache();
  const hit = c.gn[id];
  if (hit && hit.real) return hit.real;
  if (hit && !hit.real && Date.now() - hit.at < 6 * 3600 * 1000) return null;
  try {
    const real = await gnSem.run(() => resolveGoogleNewsUncached(url));
    c.gn[id] = { real, at: Date.now() };
    if (real) stats.google.ok++;
    saveCacheSoon();
    return real;
  } catch (e) {
    stats.google.fail++;
    c.gn[id] = { real: null, at: Date.now(), err: String(e.message).slice(0, 80) };
    saveCacheSoon();
    return null;
  }
}

// ─── Step 2: reading the page ────────────────────────────────────────────────

const BAD_NAME_RE = /(?:^|[\/_.-])(?:logo|logos|icon|icons|favicon|sprite|avatar|pixel|spacer|blank|placeholder|noimage|no-image|fallback|generic|badge|chevron|glyph)(?:[\/_.-]|$)/i;
const DEFAULT_NAME_RE = /(?:^|[-_.])(?:default|facebook-default|share-default|social-default|og-default)(?:[-_.]|$)/i;
const STOCK_RE = /(pinterest|pinimg|shutterstock|gettyimages|istockphoto|alamy|dreamstime|depositphotos|123rf|freepik|flaticon|iconfinder|gravatar|gstatic|ui-avatars)/i;

function badImageUrl(u) {
  const s = String(u || '');
  if (!/^https?:\/\//i.test(s)) return true;
  let p;
  try { p = new URL(s); } catch { return true; }
  const pathname = p.pathname.toLowerCase();
  const base = pathname.split('/').pop() || '';
  if (/\.(svg|ico)$/.test(pathname)) return true;
  if (BAD_NAME_RE.test(base) || DEFAULT_NAME_RE.test(base)) return true;
  if (STOCK_RE.test(p.hostname)) return true;
  if (/J6_coFbogxhRI9iM864NL_liGXvsQp2AupsKei7z0cNNfDvGUmWUy20nuUhkREQyrpY4bEeIBuc/.test(s)) return true;   // Google News placeholder
  return false;
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(10000),
    });
    if ([401, 403, 429, 503].includes(res.status)) { try { await res.body?.cancel(); } catch { /* ignore */ } stats.pages.blocked++; return { blocked: true, status: res.status, finalUrl: res.url }; }
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* ignore */ } stats.pages.fail++; return { status: res.status }; }
    const ct = res.headers.get('content-type') || '';
    if (ct && !/html|xml/i.test(ct)) { try { await res.body?.cancel(); } catch { /* ignore */ } return { status: res.status }; }
    const buf = await readLimited(res, 700000);
    const html = buf.toString('utf8');
    const challenge = /Just a moment\.\.\.|cf-chl|Attention Required|Access Denied|captcha/i.test(html.slice(0, 6000)) && !/og:image/i.test(html);
    if (challenge) { stats.pages.blocked++; return { blocked: true, status: res.status, finalUrl: res.url }; }
    stats.pages.ok++;
    return { html, status: res.status, finalUrl: res.url };
  } catch { stats.pages.fail++; return { status: 0 }; }
}

function extractCandidates(html, base) {
  const out = [];
  const add = (u, src) => { const a = absUrl(u, base); if (a && !out.some(x => x.url === a)) out.push({ url: a, src }); };
  const metaPats = [
    [/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/gi, 'og'],
    [/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/gi, 'og'],
    [/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/gi, 'twitter'],
    [/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/gi, 'twitter'],
    [/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/gi, 'link'],
    [/<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["']/gi, 'itemprop'],
  ];
  for (const [re, src] of metaPats) { let m; while ((m = re.exec(html)) !== null) add(m[1], src); }
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let lm;
  while ((lm = ldRe.exec(html)) !== null) {
    try {
      const stack = [JSON.parse(lm[1].trim())];
      let guard = 0;
      while (stack.length && guard++ < 400) {
        const n = stack.pop();
        if (!n || typeof n !== 'object') continue;
        if (Array.isArray(n)) { stack.push(...n); continue; }
        const im = n.image || n.thumbnailUrl;
        if (typeof im === 'string') add(im, 'ldjson');
        else if (Array.isArray(im)) im.forEach(v => add(typeof v === 'string' ? v : (v && (v.url || v.contentUrl)) || '', 'ldjson'));
        else if (im && typeof im === 'object') add(im.url || im.contentUrl || '', 'ldjson');
        Object.values(n).forEach(v => { if (v && typeof v === 'object') stack.push(v); });
      }
    } catch { /* malformed JSON-LD */ }
  }
  // A few large in-body images (skipping obvious chrome).
  let imgCount = 0, im;
  const imgRe = /<img\b[^>]*>/gi;
  while ((im = imgRe.exec(html)) !== null && imgCount < 4) {
    const tag = im[0];
    if (/(logo|icon|avatar|sprite|ad-|banner|tracking|pixel)/i.test(tag)) continue;
    const w = Number((tag.match(/\bwidth=["']?(\d+)/i) || [])[1] || 0);
    const srcset = (tag.match(/\bsrcset=["']([^"']+)["']/i) || [])[1];
    let src = (tag.match(/\b(?:data-src|data-lazy-src|src)=["']([^"']+)["']/i) || [])[1];
    if (srcset) {
      const best = srcset.split(',').map(s => s.trim().split(/\s+/)).map(([u, d]) => ({ u, w: parseInt(d || '0', 10) || 0 })).sort((a, b) => b.w - a.w)[0];
      if (best && best.w >= 500) src = best.u;
    } else if (w && w < 400) continue;
    if (src) { add(src, 'img'); imgCount++; }
  }
  return out;
}

// ─── Image validation (dimensions from the first bytes — no image library needed) ───

function imageSize(b) {
  try {
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };             // PNG
    if (b.length > 10 && b.toString('latin1', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };          // GIF
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {                                                                       // JPEG
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker === 0xff) { i++; continue; }
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
    if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {                        // WebP
      const fmt = b.toString('latin1', 12, 16);
      if (fmt === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
      if (fmt === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
  } catch { /* fall through */ }
  return null;
}

async function probeImage(url, referer) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8', Referer: referer || '', Range: 'bytes=0-65535' }, redirect: 'follow', signal: AbortSignal.timeout(9000) });
  } catch { stats.probes.error++; return { ok: false, reason: 'fetch-error' }; }
  if (res.status !== 200 && res.status !== 206) { try { await res.body?.cancel(); } catch { /* ignore */ } stats.probes.error++; return { ok: false, reason: `http-${res.status}` }; }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('image/') || ct.includes('svg')) { try { await res.body?.cancel(); } catch { /* ignore */ } stats.probes.notImage++; return { ok: false, reason: 'not-an-image' }; }
  const buf = await readLimited(res, 65536);
  const total = Number((res.headers.get('content-range') || '').split('/')[1]) || Number(res.headers.get('content-length')) || buf.length;
  const dim = imageSize(buf);
  if (dim && dim.w && dim.h) {
    if (dim.w < MIN_W || dim.h < MIN_H) { stats.probes.tooSmall++; return { ok: false, reason: `too-small ${dim.w}x${dim.h}`, w: dim.w, h: dim.h }; }
    const ar = dim.w / dim.h;
    if (ar > 3.5 || ar < 0.5) { stats.probes.badShape++; return { ok: false, reason: `bad-shape ${dim.w}x${dim.h}`, w: dim.w, h: dim.h }; }
  } else if (total < 15000) { stats.probes.tooSmall++; return { ok: false, reason: 'unknown-size-small' }; }
  stats.probes.ok++;
  return { ok: true, w: dim ? dim.w : 0, h: dim ? dim.h : 0, bytes: total };
}

async function downloadImage(url, referer, max = 2500000) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/*', Referer: referer || '' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* ignore */ } return null; }
    const len = Number(res.headers.get('content-length')) || 0;
    if (len > max) { try { await res.body?.cancel(); } catch { /* ignore */ } return null; }
    return await readLimited(res, max);
  } catch { return null; }
}

// Same image on 3+ articles of ONE domain = that site's default/share graphic, not a story photo.
function noteUse(imgUrl, domain, articleKey) {
  const c = loadCache();
  const u = (c.uses[imgUrl] = c.uses[imgUrl] || {});
  const arr = (u[domain] = u[domain] || []);
  if (!arr.includes(articleKey)) arr.push(articleKey);
  if (arr.length > 6) arr.length = 6;
}
function isSiteDefault(imgUrl, domain, articleKey) {
  const arr = ((loadCache().uses[imgUrl] || {})[domain]) || [];
  return arr.filter(k => k !== articleKey).length >= 2;
}

// ─── Vision judge: describe (small VLM) → decide (text model) ────────────────

const visionSem = new Semaphore(1);          // one GPU job at a time
function ollamaChat(model, content, { images, think, numPredict = 90, timeoutMs = 45000 } = {}) {
  const base = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  const url = new URL('/api/chat', base);
  const msg = { role: 'user', content };
  if (images) msg.images = images;
  const payload = { model, stream: false, messages: [msg], options: { temperature: 0, num_predict: numPredict } };
  if (think === false) payload.think = false;      // never send `think` to moondream — it garbles the output
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Ollama HTTP ${res.statusCode}`));
        try { resolve(String(JSON.parse(Buffer.concat(chunks).toString('utf8'))?.message?.content || '').trim()); } catch { reject(new Error('bad response')); }
      });
    });
    req.on('error', e => reject(new Error('Ollama unreachable')));
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timed out')); });
    req.write(body); req.end();
  });
}

// Returns { kind, fit, caption } or null when the judge couldn't run (caller then accepts the image unjudged).
async function judgeImage(buf, headline) {
  try {
    return await visionSem.run(async () => {
      const caption = await ollamaChat(VISION_MODEL, 'What does this picture show? Mention any text, logos, or graphics you can see.', { images: [buf.toString('base64')], numPredict: 90 });
      if (!caption || caption.replace(/[^a-z]/gi, '').length < 12) return null;
      const prompt = `You are choosing a thumbnail for a news article.
HEADLINE: "${String(headline || '').slice(0, 220)}"
WHAT THE IMAGE SHOWS (described by a vision model): "${caption.slice(0, 400)}"

Reply with exactly one line in the form KIND|FIT and nothing else.
KIND is one of:
  photo = a real photograph of people, places, objects or events
  illustration = editorial artwork, a chart, a diagram, or a map
  logo = a brand logo, icon, emblem, mascot or app badge
  graphic = text on a plain background, a generic banner, a placeholder, an advertisement, or a screenshot of a website or app
FIT is one of:
  match = clearly illustrates the headline
  related = plausibly the same general subject
  unrelated = shows something else entirely
Example: photo|related`;
      const out = await ollamaChat(JUDGE_MODEL, prompt, { think: false, numPredict: 14 });
      const m = out.match(/(photo|illustration|logo|graphic)\s*[|,:\-]\s*(match|related|unrelated)/i);
      if (!m) return null;
      return { kind: m[1].toLowerCase(), fit: m[2].toLowerCase(), caption: caption.slice(0, 160) };
    });
  } catch { return null; }
}

// ─── Step 3: Tavily Extract for pages that block us ──────────────────────────

function getTavilyKey() {
  try {
    const f = path.join(DATA_DIR, 'llm-secrets.json');
    if (fs.existsSync(f)) {
      const k = String(JSON.parse(fs.readFileSync(f, 'utf8') || '{}').tavilyApiKey || '').trim();
      if (k) return k;
    }
  } catch { /* fall through */ }
  return String(process.env.TAVILY_API_KEY || '').trim();
}

async function tavilyExtractImages(pageUrl) {
  const key = getTavilyKey();
  if (!key) return [];
  rollDay();
  if (stats.tavily.extractCallsToday >= TAVILY_EXTRACT_PER_DAY) { stats.tavily.skippedBudget++; return []; }
  stats.tavily.extractCallsToday++; stats.tavily.extractCallsTotal++; stats.tavily.estCreditsTotal = Math.round((stats.tavily.estCreditsTotal + 0.2) * 100) / 100;
  try {
    const r = await fetch('https://api.tavily.com/extract', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ urls: [pageUrl], include_images: true, extract_depth: 'basic' }), signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    const first = (j.results || [])[0] || {};
    return (first.images || []).filter(u => !badImageUrl(u)).slice(0, 6).map(u => ({ url: u, src: 'tavily' }));
  } catch { return []; }
}

// ─── Step 4: image search by headline (last resort; always vision-judged) ────

async function searchImageCandidates(article, domain) {
  try {
    const q = [article.title, article.source && article.source.name].filter(Boolean).join(' ').slice(0, 200);
    if (!q) return [];
    stats.search.used++;
    const params = new URLSearchParams({ q, categories: 'images', format: 'json', language: 'en-US', safesearch: '0' });
    const r = await fetch(`${SEARXNG_URL}/search?${params}`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return [];
    const rows = (await r.json()).results || [];
    return rows
      .map(row => ({ url: String(row.img_src || '').trim(), same: domain && hostOf(row.url) === domain }))
      .filter(x => /^https?:\/\//i.test(x.url) && !badImageUrl(x.url) && !/imgs\.search\.brave\.com/.test(x.url))
      .sort((a, b) => Number(b.same) - Number(a.same))
      .slice(0, 5).map(x => ({ url: x.url, src: 'search' }));
  } catch { return []; }
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

// Walks a candidate list and returns the first that passes every gate.
async function tryCandidates(cands, article, ctx) {
  let n = 0;
  for (const c of cands) {
    if (n >= 5) break;
    if (ctx.tried.has(c.url)) continue;
    ctx.tried.add(c.url);
    if (badImageUrl(c.url)) { stats.rejected.pattern++; continue; }
    if (isSiteDefault(c.url, ctx.domain, ctx.key)) { stats.rejected.siteDefault++; continue; }
    n++;
    const probe = await probeImage(c.url, ctx.referer);
    if (!probe.ok) { ctx.notes.push(`${c.src}: ${probe.reason}`); continue; }
    // Vision judge. Skipped (accepted unjudged) if the image is too large to download or the models aren't available.
    let verdict = null;
    const buf = await downloadImage(c.url, ctx.referer);
    if (buf) verdict = await judgeImage(buf, article.title);
    if (verdict) {
      stats.vision.judged++;
      const goodKind = verdict.kind === 'photo' || verdict.kind === 'illustration';
      if (!goodKind || verdict.fit === 'unrelated') {
        stats.rejected.vision++;
        ctx.notes.push(`${c.src}: judged ${verdict.kind}|${verdict.fit} — ${verdict.caption.slice(0, 60)}`);
        continue;
      }
    } else { stats.vision.unavailable++; }
    noteUse(c.url, ctx.domain, ctx.key);
    return { imageUrl: c.url, via: c.src, w: probe.w, h: probe.h, judged: verdict ? `${verdict.kind}|${verdict.fit}` : null };
  }
  return null;
}

const _inflight = new Map();
function resolveOne(article, { force = false } = {}) {
  const key = sha(article.url);
  if (_inflight.has(key)) return _inflight.get(key);
  const p = Promise.race([
    resolveOneNow(article, key, force),
    sleep(ARTICLE_TIMEOUT_MS).then(() => ({ url: article.url, realUrl: article.url, imageUrl: null, via: null, why: 'timed out' })),
  ]).finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

async function resolveOneNow(article, key, force) {
  const c = loadCache();
  const hit = c.entries[key];
  if (hit && !force) {
    const age = Date.now() - (hit.at || 0);
    if ((hit.img && age < OK_TTL_MS) || (!hit.img && age < MISS_TTL_MS)) {
      stats.cacheHits++;
      return { url: article.url, realUrl: hit.real || article.url, imageUrl: hit.img || null, via: hit.via || null, w: hit.w, h: hit.h, judged: hit.j || null, cached: true };
    }
  }
  stats.resolved++;
  rollDay();

  const out = { url: article.url, realUrl: article.url, imageUrl: null, via: null, w: 0, h: 0, judged: null };
  const notes = [];

  // 1. Real URL
  if (isGoogleWrapper(article.url)) {
    const real = await resolveGoogleNews(article.url);
    if (real) out.realUrl = real; else notes.push('google link not resolved');
  }
  const pageUrl = isGoogleWrapper(out.realUrl) ? null : out.realUrl;
  const domain = hostOf(pageUrl) || hostOf('https://' + String((article.source && article.source.domain) || ''));
  const ctx = { key, domain, referer: pageUrl || '', tried: new Set(), notes };

  let found = null;
  let blocked = false, pageCands = [];

  // 2. The real page
  if (pageUrl) {
    const pg = await fetchPage(pageUrl);
    blocked = !!pg.blocked;
    if (pg.finalUrl && !isGoogleWrapper(pg.finalUrl)) out.realUrl = pg.finalUrl;
    if (pg.html) pageCands = extractCandidates(pg.html, pg.finalUrl || pageUrl);
    if (article.imageUrl && !badImageUrl(article.imageUrl)) pageCands.push({ url: article.imageUrl, src: 'thumb' });
    found = await tryCandidates(pageCands, article, ctx);
  }

  // 3. Blocked (or empty) pages: Tavily Extract, within the daily budget
  if (!found && pageUrl && (blocked || !pageCands.length)) {
    found = await tryCandidates(await tavilyExtractImages(pageUrl), article, ctx);
  }

  // 4. Image search by headline
  if (!found) found = await tryCandidates(await searchImageCandidates(article, domain), article, ctx);

  if (found) { Object.assign(out, found); stats.accepted[found.via] = (stats.accepted[found.via] || 0) + 1; }
  else { stats.misses++; out.why = notes.slice(0, 4).join('; ') || 'no usable image'; }

  c.entries[key] = { u: article.url, real: out.realUrl, img: out.imageUrl, via: out.via, w: out.w, h: out.h, j: out.judged, why: out.why || undefined, at: Date.now() };
  saveCacheSoon();
  return out;
}

/**
 * Resolve many articles. Returns once everything is done or `budgetMs` has passed; work that is still running keeps going
 * (and is cached), so a follow-up call picks it up instantly.
 */
async function resolveBatch(articles, { budgetMs = 40000, force = false } = {}) {
  const list = (Array.isArray(articles) ? articles : []).filter(a => a && /^https?:\/\//i.test(a.url || '')).slice(0, 24);
  const results = {};
  const pool = new Semaphore(4);
  const tasks = list.map(a => pool.run(() => resolveOne(a, { force })).then(r => { results[a.url] = r; }).catch(e => { results[a.url] = { url: a.url, imageUrl: null, error: e.message }; }));
  await Promise.race([Promise.allSettled(tasks), sleep(budgetMs)]);
  return { results, pending: list.filter(a => !results[a.url]).length };
}

function getStats() {
  rollDay();
  const c = loadCache();
  return { ...stats, cacheEntries: Object.keys(c.entries).length, googleLinksResolved: Object.values(c.gn).filter(x => x.real).length, tavilyDailyBudget: TAVILY_EXTRACT_PER_DAY };
}

module.exports = { resolveBatch, resolveOne, getStats, isGoogleWrapper, resolveGoogleNews };
