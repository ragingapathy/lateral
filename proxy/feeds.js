'use strict';
// RSS / Atom, both directions.
//
//  OUT  Atom feeds of what Lateral knows, for any feed reader. A secret token in the address stands in for a login:
//         /feed/<token>/activity.xml        everything on the Activity list
//         /feed/<token>/stories.xml         new articles and episodes across your tracked stories
//         /feed/<token>/story/<id>.xml      one story (for a prediction: its evidence and movements)
//         /feed/<token>/lateral.opml        all of the above as an OPML file, to subscribe in one step
//  IN   Feeds you attach to a story. They are read on the server's background refresh and their items join that story's
//       headlines (and its alerts). You can paste a feed address, a site address (the feed is found for you), or an OPML file.
//         POST /feeds/preview {url}              find and check feeds at an address
//         GET  /feeds/subs?storyId=   POST /feeds/subs {storyId,url,title}   POST /feeds/subs/remove {storyId,url}
//         POST /feeds/fetch {storyId}            read this story's feeds right now and return the items
//         POST /feeds/opml {storyId, opml}       attach every feed in an OPML file to a story
//         GET  /feeds/info   POST /feeds/token/reset

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.LATERAL_DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'feeds.json');
const UA = 'Mozilla/5.0 (compatible; Lateral/2.1; +https://github.com/ragingapathy/lateral)';
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_MS = 10 * 60 * 1000;
const MAX_SUBS_PER_STORY = 20;

// ─── Storage ─────────────────────────────────────────────────────────────────

let db = (() => {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { token: j.token || '', subs: j.subs || {} }; }
  catch { return { token: '', subs: {} }; }
})();
if (!db.token) db.token = crypto.randomBytes(12).toString('hex');
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, FILE); } catch { /* next change */ }
  }, 400);
}
save();

// ─── XML helpers ─────────────────────────────────────────────────────────────

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-z]+);/gi, (m, n) => (NAMED[n.toLowerCase()] !== undefined ? NAMED[n.toLowerCase()] : m));
}
const unCdata = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const plain = s => decode(unCdata(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
// Summaries often arrive as escaped HTML (&lt;p&gt;…): decode first, then strip the tags that appear.
const rich = s => decode(decode(unCdata(s)).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const clip = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function esc(s) { return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const isoOf = v => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : ''; };

function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : '';
}
function attr(tagSrc, name) {
  const m = tagSrc.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decode(m[2] !== undefined ? m[2] : m[3]) : '';
}

// RSS 2.0, Atom 1.0 and RSS 1.0 (RDF) → { title, items:[{ title, url, date, summary }] }
function parseFeed(xml) {
  xml = String(xml || '');
  const atom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const itemRe = atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  const blocks = xml.match(itemRe) || [];
  const firstItem = xml.search(atom ? /<entry[\s>]/i : /<item[\s>]/i);
  const head = firstItem > 0 ? xml.slice(0, firstItem) : xml;
  const title = plain(tagText(head, 'title'));
  const items = [];
  for (const b of blocks) {
    let url = '';
    if (atom) {
      const links = b.match(/<link\b[^>]*>/gi) || [];
      const alt = links.find(l => !/rel\s*=/.test(l) || /rel\s*=\s*["']alternate["']/i.test(l)) || links[0];
      url = alt ? attr(alt, 'href') : '';
    } else {
      url = plain(tagText(b, 'link')) || attr((b.match(/<link\b[^>]*>/i) || [''])[0], 'href') || plain(tagText(b, 'guid'));
    }
    const t = plain(tagText(b, 'title'));
    if (!t || !/^https?:\/\//i.test(url)) continue;
    const dateRaw = plain(tagText(b, atom ? 'published' : 'pubDate') || tagText(b, 'updated') || tagText(b, 'dc:date') || tagText(b, 'pubdate'));
    const summary = rich(tagText(b, atom ? 'summary' : 'description') || tagText(b, 'content:encoded') || tagText(b, 'content'));
    items.push({ title: t, url, date: isoOf(dateRaw), summary: clip(summary, 300) });
  }
  return { title, items };
}

// ─── Fetching and discovery ──────────────────────────────────────────────────

async function readLimited(res, max) {
  const reader = res.body.getReader();
  const chunks = []; let n = 0;
  try { while (n < max) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); n += value.length; } }
  finally { try { await reader.cancel(); } catch { /* closed */ } }
  return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}
async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
  if (!res.ok) { try { await res.body?.cancel(); } catch { /* ignore */ } throw new Error(`HTTP ${res.status}`); }
  return { body: await readLimited(res, MAX_BYTES), finalUrl: res.url || url, type: res.headers.get('content-type') || '' };
}
const looksLikeFeed = body => /<(rss|feed|rdf:RDF)[\s>]/i.test(String(body).slice(0, 3000));

const cache = new Map(); // url -> { at, feed }
async function readFeed(url, { fresh = false } = {}) {
  const hit = cache.get(url);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.feed;
  const r = await fetchText(url);
  if (!looksLikeFeed(r.body)) throw new Error('not a feed');
  const feed = parseFeed(r.body);
  cache.set(url, { at: Date.now(), feed });
  return feed;
}

// Given a feed address or a site address, return the feeds found there (each checked to really parse).
async function discover(input) {
  let url = String(input || '').trim();
  if (!url) throw new Error('Enter a feed or site address.');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  new URL(url);
  const r = await fetchText(url);
  const out = [];
  const add = async (u, known) => {
    if (out.some(o => o.url === u)) return;
    try {
      const feed = known || await readFeed(u, { fresh: true });
      if (feed.items.length) out.push({ url: u, title: feed.title || hostOf(u), count: feed.items.length, sample: feed.items.slice(0, 3).map(i => ({ title: i.title, url: i.url, date: i.date })) });
    } catch { /* not a usable feed */ }
  };
  if (looksLikeFeed(r.body)) { await add(r.finalUrl, parseFeed(r.body)); return out; }
  const links = (r.body.match(/<link\b[^>]*>/gi) || []).filter(l => /rel\s*=\s*["']alternate["']/i.test(l) && /type\s*=\s*["']application\/(rss|atom)\+xml["']/i.test(l));
  for (const l of links.slice(0, 5)) { try { await add(new URL(attr(l, 'href'), r.finalUrl).toString()); } catch { /* bad href */ } }
  if (!out.length) {
    const origin = new URL(r.finalUrl).origin;
    for (const p of ['/feed', '/feed/', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml']) { await add(origin + p); if (out.length) break; }
  }
  return out;
}

// ─── Subscriptions (feeds attached to stories) ───────────────────────────────

const subsFor = storyId => (db.subs[storyId] || []).slice();
function addSub(storyId, url, title) {
  if (!storyId || !/^https?:\/\//i.test(url)) throw new Error('A story and a feed address are required.');
  const list = db.subs[storyId] = db.subs[storyId] || [];
  if (list.some(s => s.url === url)) return list;
  if (list.length >= MAX_SUBS_PER_STORY) throw new Error(`A story can follow up to ${MAX_SUBS_PER_STORY} feeds.`);
  list.push({ url, title: clip(title || hostOf(url), 80), addedAt: new Date().toISOString() });
  save();
  return list;
}
function removeSub(storyId, url) { db.subs[storyId] = (db.subs[storyId] || []).filter(s => s.url !== url); if (!db.subs[storyId].length) delete db.subs[storyId]; save(); }

// Items from a story's feeds, shaped like the app's own headline articles.
async function itemsForStory(storyId, { fresh = false } = {}) {
  const out = [];
  const errors = [];
  for (const s of subsFor(storyId)) {
    try {
      const feed = await readFeed(s.url, { fresh });
      const name = feed.title || s.title || hostOf(s.url);
      for (const i of feed.items.slice(0, 12)) {
        const d = i.date ? i.date.slice(0, 10) : new Date().toISOString().slice(0, 10);
        out.push({ title: i.title, url: i.url, realUrl: i.url, date: d, snippet: i.summary, source: { name, domain: hostOf(i.url) || hostOf(s.url), engine: 'feed' } });
      }
    } catch (e) { errors.push({ url: s.url, error: e.message }); }
  }
  out.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { items: out, errors };
}
const hasFeeds = storyId => (db.subs[storyId] || []).length > 0;

function parseOpml(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<outline\b[^>]*>/gi)) {
    const url = attr(m[0], 'xmlUrl');
    if (/^https?:\/\//i.test(url)) out.push({ url, title: attr(m[0], 'title') || attr(m[0], 'text') || hostOf(url) });
  }
  return out;
}

// ─── Atom output ─────────────────────────────────────────────────────────────

function atom({ title, id, subtitle, link, entries }) {
  const updated = (entries[0] && entries[0].updated) || new Date().toISOString();
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${esc(title)}</title>
  <subtitle>${esc(subtitle || '')}</subtitle>
  <id>${esc(id)}</id>
  <updated>${esc(updated)}</updated>
  <generator>Lateral</generator>
${link ? `  <link rel="alternate" href="${esc(link)}"/>\n` : ''}${entries.map(e => `  <entry>
    <title>${esc(e.title)}</title>
    <id>${esc(e.id)}</id>
    <updated>${esc(e.updated)}</updated>
${e.link ? `    <link rel="alternate" href="${esc(e.link)}"/>\n` : ''}${e.category ? `    <category term="${esc(e.category)}"/>\n` : ''}    <content type="html">${esc(e.html || '')}</content>
  </entry>`).join('\n')}
</feed>
`;
}
const htmlBody = text => String(text || '').split('\n').map(l => esc(l)).join('<br/>');

function readJson(file, fb) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch { return fb; } }
const appBase = () => { try { return String(require('./alerts')._db().config.appUrl || '').replace(/\/+$/, ''); } catch { return ''; } };
const storyLink = id => { const b = appBase(); return b ? `${b}/?story=${encodeURIComponent(id)}` : ''; };

function activityEntries() {
  let events = [];
  try { events = require('./alerts')._db().events; } catch { /* alerts unavailable */ }
  return events.slice(0, 100).map(e => ({
    id: `tag:lateral,2026:event:${e.id}`, title: e.title, updated: e.at, link: storyLink(e.storyId) || appBase(),
    category: e.kind, html: htmlBody(e.body),
  }));
}

// Prediction flips: the moments a prediction's evidence changed direction (the first evidence found counts too).
// One entry per movement; `predictionId` limits it to one prediction and also includes smaller shifts.
function flipEntries(predictionId) {
  let events = [];
  try { events = require('./alerts')._db().events; } catch { /* alerts unavailable */ }
  const out = [];
  for (const e of events) {
    if (e.kind !== 'prediction-move' || (predictionId && e.predictionId !== predictionId)) continue;
    const from = e.data && e.data.from, to = e.data && e.data.to;
    const flip = !!(from && to && from.direction !== to.direction);
    if (!flip && !predictionId) continue;
    out.push({
      id: `tag:lateral,2026:flip:${e.id}`, title: `${flip ? '⚑ ' : ''}${e.title}`, updated: e.at, link: storyLink(e.storyId) || appBase(),
      category: flip ? 'flip' : 'move', html: htmlBody(e.body),
    });
  }
  return out;
}

function storyEntries(story, cacheJson) {
  const out = [];
  const sc = ((cacheJson.storyCache || {})[story.id]) || {};
  for (const ep of story.episodes || []) {
    const when = isoOf(ep.addedAt) || isoOf(ep.date) || new Date().toISOString();
    out.push({
      id: `tag:lateral,2026:episode:${story.id}:${ep.id}`, title: `${story.title}: ${ep.headline}`, updated: when,
      link: ep.sourceUrl || storyLink(story.id), category: story.title,
      html: `${htmlBody(ep.summary)}${ep.framingNote ? `<p><em>${esc(ep.framingNote)}</em></p>` : ''}`,
    });
  }
  for (const a of (sc.headlines && sc.headlines.items) || []) {
    if (!a.url) continue;
    const when = isoOf(a.firstSeenAt) || isoOf(a.date) || new Date().toISOString();
    out.push({
      id: `tag:lateral,2026:headline:${crypto.createHash('sha1').update(a.url).digest('hex').slice(0, 16)}`, title: a.title, updated: when,
      link: a.realUrl || a.url, category: story.title,
      html: `${htmlBody(a.snippet || '')}<p>${esc((a.source && a.source.name) || hostOf(a.url))} · ${esc(story.title)}</p>`,
    });
  }
  return out;
}

function predictionEntries(story) {
  const out = [];
  try {
    const v2 = require('./v2');
    const snap = v2.evidenceSnapshot(story.predictionId);
    if (snap) {
      for (const l of snap.links) {
        if (!['supports', 'contradicts', 'complicates'].includes(l.stance) || !l.item) continue;
        out.push({
          id: `tag:lateral,2026:evidence:${l.id}`, title: `${l.stance === 'supports' ? '▲ Supports' : l.stance === 'contradicts' ? '▼ Contradicts' : '◆ Complicates'}: ${l.item.title}`,
          updated: isoOf(l.scoredAt) || isoOf(l.createdAt) || new Date().toISOString(), link: l.item.url, category: story.title,
          html: `${htmlBody(l.reason || '')}<p>Weight ${esc(l.weight)} · ${esc(l.item.source || hostOf(l.item.url))}</p>`,
        });
      }
    }
  } catch { /* no predictions module data */ }
  try {
    for (const e of require('./alerts')._db().events) {
      if (e.predictionId && story.predictionId === e.predictionId) out.push({ id: `tag:lateral,2026:event:${e.id}`, title: e.title, updated: e.at, link: storyLink(story.id), category: story.title, html: htmlBody(e.body) });
    }
  } catch { /* alerts unavailable */ }
  return out;
}
const newestFirst = list => list.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));

function opml(base, stories) {
  const url = p => `${base}/api/lateral/feed/${db.token}/${p}`;
  const row = (t, p) => `    <outline type="rss" text="${esc(t)}" title="${esc(t)}" xmlUrl="${esc(url(p))}"/>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<opml version="2.0">
  <head><title>Lateral</title></head>
  <body>
    <outline text="Lateral" title="Lateral">
${row('Lateral: activity', 'activity.xml')}
${row('Lateral: all stories', 'stories.xml')}
${row('Lateral: prediction flips', 'flips.xml')}
${stories.map(s => row(`Lateral: ${s.title.replace(' (Prediction)', '')}`, `story/${s.id}.xml`)).join('\n')}
    </outline>
  </body>
</opml>
`;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise(resolve => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n < 2e6) chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function sendXml(res, type, body) { res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' }); res.end(body); }

// Returns false when the path is not a feeds route.
async function route(req, reqUrl, res, send) {
  const p = reqUrl.pathname.replace(/^\/api\/lateral/, '');
  const q = reqUrl.searchParams;

  // Feed output, protected by the secret in the address
  const fm = p.match(/^\/feed\/([0-9a-f]+)\/(.+)$/);
  if (fm) {
    if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
    if (fm[1] !== db.token) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const what = fm[2];
    const stories = (readJson('stories.json', { stories: [] }).stories || []).filter(s => s.status !== 'buried');
    const cacheJson = readJson('cache.json', {});
    if (what === 'activity.xml') return sendXml(res, 'application/atom+xml', atom({ title: 'Lateral: activity', id: 'tag:lateral,2026:activity', subtitle: 'What Lateral has noticed', link: appBase(), entries: activityEntries() }));
    if (what === 'stories.xml') {
      const entries = newestFirst(stories.flatMap(s => s.predictionId ? predictionEntries(s) : storyEntries(s, cacheJson))).slice(0, 150);
      return sendXml(res, 'application/atom+xml', atom({ title: 'Lateral: all stories', id: 'tag:lateral,2026:stories', subtitle: 'New coverage and episodes across the stories you track', link: appBase(), entries }));
    }
    if (what === 'flips.xml') return sendXml(res, 'application/atom+xml', atom({ title: 'Lateral: prediction flips', id: 'tag:lateral,2026:flips', subtitle: "Each time a prediction's evidence changed direction", link: appBase(), entries: newestFirst(flipEntries()).slice(0, 100) }));
    const pm = what.match(/^prediction\/([^/]+)\.xml$/);
    if (pm) {
      const pid = decodeURIComponent(pm[1]);
      const ps = stories.find(x => x.predictionId === pid);
      if (!ps) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('No such prediction'); }
      return sendXml(res, 'application/atom+xml', atom({ title: `Lateral flips: ${ps.title.replace(' (Prediction)', '')}`, id: `tag:lateral,2026:flips:${pid}`, subtitle: "Every time this prediction's evidence moved; ⚑ marks a change of direction", link: storyLink(ps.id) || appBase(), entries: newestFirst(flipEntries(pid)).slice(0, 100) }));
    }
    const sm = what.match(/^story\/([^/]+)\.xml$/);
    if (sm) {
      const s = stories.find(x => x.id === decodeURIComponent(sm[1]));
      if (!s) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('No such story'); }
      const entries = newestFirst(s.predictionId ? predictionEntries(s) : storyEntries(s, cacheJson)).slice(0, 100);
      return sendXml(res, 'application/atom+xml', atom({ title: `Lateral: ${s.title.replace(' (Prediction)', '')}`, id: `tag:lateral,2026:story:${s.id}`, subtitle: s.summary || '', link: storyLink(s.id) || appBase(), entries }));
    }
    if (what === 'lateral.opml') {
      const base = String(q.get('base') || appBase() || '').replace(/\/+$/, '');
      return sendXml(res, 'text/x-opml', opml(base, stories));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
  }

  if (!p.startsWith('/feeds/')) return false;
  const sub = p.slice('/feeds/'.length);

  if (sub === 'info' && req.method === 'GET') return send(res, 200, { token: db.token, subscriptions: Object.values(db.subs).reduce((n, l) => n + l.length, 0) });
  if (sub === 'subs' && req.method === 'GET') return send(res, 200, { subs: subsFor(q.get('storyId') || ''), counts: Object.fromEntries(Object.entries(db.subs).map(([k, v]) => [k, v.length])) });
  if (req.method === 'POST') {
    const body = await readBody(req);
    try {
      if (sub === 'token/reset') { db.token = crypto.randomBytes(12).toString('hex'); save(); return send(res, 200, { token: db.token }); }
      if (sub === 'preview') return send(res, 200, { feeds: await discover(body.url) });
      if (sub === 'subs') return send(res, 200, { subs: addSub(String(body.storyId || ''), String(body.url || ''), body.title) });
      if (sub === 'subs/remove') { removeSub(String(body.storyId || ''), String(body.url || '')); return send(res, 200, { subs: subsFor(String(body.storyId || '')) }); }
      if (sub === 'fetch') return send(res, 200, await itemsForStory(String(body.storyId || ''), { fresh: true }));
      if (sub === 'opml') {
        const found = parseOpml(body.opml);
        let added = 0;
        for (const f of found.slice(0, MAX_SUBS_PER_STORY)) { const before = subsFor(String(body.storyId)).length; try { addSub(String(body.storyId), f.url, f.title); } catch { break; } if (subsFor(String(body.storyId)).length > before) added++; }
        return send(res, 200, { found: found.length, added, subs: subsFor(String(body.storyId)) });
      }
    } catch (e) { return send(res, 200, { error: e.message }); }
  }
  return send(res, 404, { error: 'Unknown feeds route.' });
}

module.exports = { route, itemsForStory, hasFeeds, parseFeed, parseOpml, discover, atom, subsFor };
