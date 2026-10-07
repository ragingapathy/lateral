'use strict';
// Civic mode: local media. Links to the newspapers, weekly and alternative papers, TV and radio stations, and news sites that cover
// where you live, built from your profile with no account and no key:
//
//   government sites      the official websites of your city, county, school district, state and its legislature (Wikidata)
//   found automatically   Wikipedia's category pages for your city and county ("Mass media in Toledo, Ohio", television and radio
//                         stations, newspapers), each outlet's website read from Wikidata. Volunteer-edited, so it can miss a small
//                         paper or list a station that has moved; the sidebar says so.
//   added by you          any outlet, with a name, address and kind.
//   found by a search     opt-in, one Tavily credit: the pages a web search returns for "local newspapers and TV stations in <place>";
//                         nothing is saved until you tick it.
//
// You can hide anything you do not want (and bring it back). Boards belong to a place, so a new address starts fresh.
//
//   GET  media/list               the outlets for your profile, grouped, plus a few look-up links
//   POST media/refresh            read Wikipedia again
//   POST media/add {name,url,kind}  · /media/remove {id}  · /media/hide {key}  · /media/restore {key}
//   POST media/search             opt-in web search -> candidates (nothing saved)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.LATERAL_DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'civic-media.json');
const DAY = 24 * 3600 * 1000;
const WP = 'https://en.wikipedia.org/w/api.php?format=json&';
const KINDS = ['paper', 'tv', 'radio', 'online', 'gov'];

const civic = () => require('./civic');
let ctx = {};                                      // test hooks: getJson, tavilySearch
const getJson = (url, opts) => (ctx.getJson || civic().getJson)(url, { timeout: 20000, ...opts });

const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { s = clean(s); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };

// ─── Storage ─────────────────────────────────────────────────────────────────

let db = (() => {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { placeKey: j.placeKey || '', found: j.found || null, added: j.added || [], hidden: j.hidden || [] }; }
  catch { return { placeKey: '', found: null, added: [], hidden: [] }; }
})();
let saveTimer = null;
function saveNow() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, FILE); } catch { /* next change */ } }
function saveSoon() { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 400); }

// ─── Pure helpers ────────────────────────────────────────────────────────────

function normUrl(input) {
  let u = clean(input);
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); if (!x.hostname.includes('.')) return ''; x.hash = ''; return x.toString(); } catch { return ''; }
}
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const keyOf = url => hostOf(url) || sha(url);

const bareName = s => clean(s).replace(/\s+(city|town|village|borough|township|CDP)$/i, '');

// Wikipedia category names for a place: [mass media, newspapers, magazines, television, radio].
function categoriesFor(profile) {
  const j = (profile && profile.jurisdictions) || {};
  const place = bareName(j.place && j.place.name), county = clean(j.county && j.county.name), st = clean(j.state && j.state.name);
  const out = [];
  const add = where => { for (const f of ['Mass media in', 'Newspapers published in', 'Magazines published in', 'Television stations in', 'Radio stations in']) out.push(`Category:${f} ${where}`.replace(/ /g, '_')); };
  if (place && st) add(`${place}, ${st}`);
  if (county && st) add(`${county}, ${st}`);
  return out;
}

// What kind of outlet is this? From Wikipedia's one-line description and the title (a call sign like WTOL or KSDK-TV).
function classify(title, desc, via) {
  const d = String(desc || '').toLowerCase(), t = String(title || '');
  if (/television|tv station|tv channel|cable channel/.test(d) || /^[KW][A-Z]{2,3}-(TV|DT|CD|LD)\b/.test(t)) return 'tv';
  if (/radio/.test(d)) return 'radio';
  if (/newspaper|magazine|weekly|daily|alternative|journal|gazette|paper\b|periodical|tabloid/.test(d)) return 'paper';
  if (/website|news site|online|blog|digital/.test(d)) return 'online';
  if (/\((magazine|newspaper)\)$/i.test(t)) return 'paper';
  // No usable description (Wikipedia often has none for a small paper): the category it was listed under says what it is.
  if (via) return via;
  return /(paper|press|journal|times|gazette|herald|blade|post|tribune|courier|review|chronicle|news|magazine|weekly|daily)/i.test(t) ? 'paper' : '';
}
// Not worth showing: low-power relay "translators" (W225AM), defunct outlets, the category's own overview page.
function usable(title, desc) {
  if (/^(Mass media in|List of)\b/i.test(title)) return false;
  if (/^[KW]\d{2,3}[A-Z]{2}\b/.test(title) || /^[KW]T\d{2}\b/.test(title)) return false;
  if (/\b(former|defunct|ceased|closed|discontinued|historical)\b|\(\d{4}[–-]\d{4}/i.test(desc || '')) return false;
  return true;
}

// Rows from the pipeline -> grouped, sorted list. A local outlet (its description names the place) sorts first.
function build(rows, placeWords) {
  const seen = new Set(), items = [];
  for (const r of rows) {
    const url = normUrl(r.url);
    if (!url || !usable(r.title, r.desc)) continue;
    const kind = classify(r.title, r.desc, r.via);
    if (!kind) continue;
    const key = keyOf(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const local = placeWords.some(w => w && new RegExp(`\\b${w.replace(/[^A-Za-z ]/g, '')}\\b`, 'i').test(r.desc || ''));
    items.push({ key, name: clip(String(r.title).replace(/\s*\((Toledo|[A-Z][a-z]+)[^)]*\)$/, '').replace(/\s*\((newspaper|magazine)\)$/i, ''), 70), kind, url, desc: clip(r.desc, 90), source: 'wikipedia', local });
  }
  const rank = i => (i.local ? 0 : 1);
  return items.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// ─── Wikipedia + Wikidata ────────────────────────────────────────────────────

async function categoryMembers(cat) {
  const j = await getJson(`${WP}action=query&list=categorymembers&cmtitle=${encodeURIComponent(cat)}&cmlimit=100&cmtype=page`);
  return ((j && j.query && j.query.categorymembers) || []).map(m => m.title).filter(t => !/^(Template|Category|Wikipedia|Portal):/.test(t));
}

async function discoverMedia(profile) {
  const titles = new Set(), via = {};
  let failures = 0;
  await Promise.all(categoriesFor(profile).map(async c => {
    const kind = /^Category:(Newspapers|Magazines)/.test(c) ? 'paper' : /^Category:Television/.test(c) ? 'tv' : /^Category:Radio/.test(c) ? 'radio' : '';
    try { (await categoryMembers(c)).forEach(t => { titles.add(t); if (kind && !via[t]) via[t] = kind; }); } catch { failures++; }   // a missing category is normal; an unreachable Wikipedia is not
  }));
  if (!titles.size && failures) throw new Error('Wikipedia did not answer.');
  const list = [...titles].slice(0, 160);
  if (!list.length) return [];
  const info = {};
  for (let i = 0; i < list.length; i += 40) {
    const j = await getJson(`${WP}action=query&prop=pageprops|description&ppprop=wikibase_item&redirects=1&titles=${encodeURIComponent(list.slice(i, i + 40).join('|'))}`);
    for (const p of Object.values((j && j.query && j.query.pages) || {})) info[p.title] = { qid: p.pageprops && p.pageprops.wikibase_item, desc: p.description || '' };
  }
  const qids = [...new Set(Object.values(info).map(x => x.qid).filter(Boolean))];
  const site = {};
  for (let i = 0; i < qids.length; i += 40) {
    const j = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&ids=${qids.slice(i, i + 40).join('|')}`);
    for (const [id, e] of Object.entries((j && j.entities) || {})) { const c = e.claims && e.claims.P856; site[id] = c && c[0] && c[0].mainsnak && c[0].mainsnak.datavalue && c[0].mainsnak.datavalue.value; }
  }
  const j = (profile && profile.jurisdictions) || {};
  const words = [bareName(j.place && j.place.name), clean(j.county && j.county.name).replace(/\s+County$/i, '')];
  return build(list.map(t => ({ title: t, desc: (info[t] || {}).desc, url: site[(info[t] || {}).qid], via: via[t] })), words);
}

// ─── Government websites ─────────────────────────────────────────────────────

// The official sites of the governments that cover you: city, county, school district, state and its legislature. The page for each
// on Wikipedia names a Wikidata item, and Wikidata holds the official website (a deprecated address is never used).
async function websitesFor(titles) {
  const out = {};
  const pages = {};
  const j = await getJson(`${WP}action=query&prop=pageprops&ppprop=wikibase_item&redirects=1&titles=${encodeURIComponent(titles.join('|'))}`);
  const redirects = {};
  for (const r of (j && j.query && j.query.redirects) || []) redirects[r.from] = r.to;
  for (const p of Object.values((j && j.query && j.query.pages) || {})) if (p.pageprops && p.pageprops.wikibase_item) pages[p.title] = p.pageprops.wikibase_item;
  const ids = [...new Set(Object.values(pages))];
  if (!ids.length) return out;
  const w = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&ids=${ids.join('|')}`);
  const siteOf = {};
  for (const [id, e] of Object.entries((w && w.entities) || {})) {
    const claims = ((e.claims && e.claims.P856) || []).filter(c => c.rank !== 'deprecated' && c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value);
    const best = claims.find(c => c.rank === 'preferred') || claims[0];
    if (best) siteOf[id] = best.mainsnak.datavalue.value;
  }
  for (const t of titles) { const title = redirects[t] || t; const id = pages[title]; if (id && siteOf[id]) out[t] = siteOf[id]; }
  return out;
}

async function governmentLinks(profile) {
  const j = (profile && profile.jurisdictions) || {};
  const place = bareName(j.place && j.place.name), county = clean(j.county && j.county.name), st = clean(j.state && j.state.name);
  const school = clean(j.schoolDistricts && j.schoolDistricts[0] && j.schoolDistricts[0].name);
  if (!st) return [];
  const legis = [`${st} General Assembly`, `${st} Legislature`, `${st} State Legislature`, `${st} Legislative Assembly`, `${st} General Court`];
  const titles = [place && `${place}, ${st}`, county && `${county}, ${st}`, school, st, ...legis].filter(Boolean);
  const site = await websitesFor([...new Set(titles)]);
  const plan = [
    place && { name: `City of ${place}`, url: site[`${place}, ${st}`] },
    county && { name: county, url: site[`${county}, ${st}`] },
    school && { name: school, url: site[school] },
    { name: `State of ${st}`, url: site[st] },
    { name: `${st} legislature`, url: legis.map(t => site[t]).find(Boolean) },
  ].filter(Boolean);
  const out = [];
  for (const x of plan) {
    const url = normUrl(x.url);
    if (!url) continue;
    out.push({ key: keyOf(url), name: x.name, kind: 'gov', url, desc: 'Official website', source: 'wikidata', local: true });
  }
  return out.filter((x, i, arr) => arr.findIndex(y => y.key === x.key) === i);
}

// Government sites first, then the media. Either may fail alone; the whole thing fails only when neither could be read.
async function discover(profile) {
  let gov = [], govError = null, media = null, mediaError = null;
  await Promise.all([
    governmentLinks(profile).then(g => { gov = g; }, e => { govError = e; }),
    discoverMedia(profile).then(m => { media = m; }, e => { mediaError = e; }),
  ]);
  if (media === null && !gov.length) throw mediaError || govError || new Error('Wikipedia did not answer.');
  return [...gov, ...(media || [])];
}

// ─── Public API ──────────────────────────────────────────────────────────────

const placeKeyOf = profile => { const j = (profile && profile.jurisdictions) || {}; return [j.state && (j.state.abbr || j.state.name), j.county && (j.county.geoid || j.county.name), j.place && (j.place.geoid || j.place.name)].filter(Boolean).join('|'); };

function quickLinks(profile) {
  const j = (profile && profile.jurisdictions) || {};
  const place = bareName(j.place && j.place.name) || clean(j.county && j.county.name), st = clean(j.state && j.state.name), abbr = clean(j.state && j.state.abbr);
  if (!place) return [];
  const gn = q => `https://news.google.com/search?q=${encodeURIComponent(q)}`;
  const wiki = `https://en.wikipedia.org/wiki/${encodeURIComponent(`${place}${st ? ', ' + st : ''}`.replace(/ /g, '_')).replace(/%2C/g, ',')}`;
  const ballot = `https://ballotpedia.org/${encodeURIComponent(`${place}${st ? ', ' + st : ''}`.replace(/ /g, '_')).replace(/%2C/g, ',')}`;
  return [
    { name: `Google News: ${place}`, url: gn(`"${place}" ${abbr}`.trim()) },
    { name: `Google News: ${place} government`, url: gn(`"${place}" ${abbr} "city council" OR mayor OR commissioners`.replace(/\s+/g, ' ')) },
    { name: `Elections: Ballotpedia`, url: ballot },
    { name: `About ${place}: Wikipedia`, url: wiki },
  ];
}

async function ensureFound(profile, force) {
  const key = placeKeyOf(profile);
  if (db.placeKey && db.placeKey !== key) { db.found = null; db.added = []; db.hidden = []; }
  db.placeKey = key;
  const f = db.found;
  const due = !f || f.v !== 2 || (f.at === 0 ? Date.now() >= (f.retryAfter || 0) : Date.now() - f.at > 30 * DAY);   // v2: government sites added
  if (force || due) {
    let items = null, error = '';
    try { items = await discover(profile); } catch (e) { error = e.message; }
    if (items) db.found = { v: 2, at: Date.now(), items };
    else db.found = { v: 2, at: 0, retryAfter: Date.now() + 5 * 60000, items: (db.found && db.found.items) || [], error };   // try again in a few minutes
    saveSoon();
  }
}

async function list(profile, { refresh = false } = {}) {
  if (!profile) return { groups: {}, quick: [], hidden: [], at: 0, empty: true };
  await ensureFound(profile, refresh);
  const hiddenSet = new Set(db.hidden);
  const all = [...db.added.map(a => ({ ...a, key: keyOf(a.url), source: a.source || 'manual', manual: true })), ...((db.found && db.found.items) || [])]
    .filter((x, i, arr) => arr.findIndex(y => y.key === x.key) === i);
  const groups = { gov: [], paper: [], tv: [], radio: [], online: [] };
  const hidden = [];
  for (const it of all) (hiddenSet.has(it.key) ? hidden : (groups[it.kind] || groups.online)).push(it);
  return { groups, hidden, quick: quickLinks(profile), at: (db.found && db.found.at) || 0, error: (db.found && db.found.error) || '', place: bareName(profile.jurisdictions && profile.jurisdictions.place && profile.jurisdictions.place.name) };
}

function add(input) {
  const url = normUrl(input.url);
  if (!url) throw new Error('Enter the outlet\'s web address, such as toledojournal.com.');
  const name = clip(input.name, 70) || hostOf(url);
  const kind = KINDS.includes(input.kind) ? input.kind : 'paper';
  const key = keyOf(url);
  db.added = db.added.filter(a => keyOf(a.url) !== key);
  db.added.push({ id: 'm' + sha(key), name, kind, url, source: input.source === 'search' ? 'search' : 'manual', desc: '' });
  db.hidden = db.hidden.filter(k => k !== key);
  saveNow();
  return key;
}
function remove(id) { db.added = db.added.filter(a => a.id !== id); saveNow(); }
function hide(key) { key = String(key || ''); if (key && !db.hidden.includes(key)) db.hidden.push(key); saveNow(); }
function restore(key) { db.hidden = db.hidden.filter(k => k !== String(key || '')); saveNow(); }
function clearAll() { db = { placeKey: '', found: null, added: [], hidden: [] }; saveNow(); }
function placeChanged(jurisdictions) {
  const key = placeKeyOf({ jurisdictions });
  if (db.placeKey && db.placeKey !== key) clearAll();
  db.placeKey = key; saveNow();
}

// Pages that are about local media in general, not an outlet.
const NOT_OUTLETS = /(^|\.)(wikipedia\.org|facebook\.com|instagram\.com|x\.com|twitter\.com|linkedin\.com|youtube\.com|reddit\.com|yelp\.com|tripadvisor\.com|mapquest\.com|usnews\.com|niche\.com|onlinenewspapers\.com|abyznewslinks\.com|4icu\.org|usnpl\.com|newspapers\.com|pinterest\.com|google\.com|bing\.com|amazon\.com|indeed\.com|zillow\.com|nytimes\.com|cnn\.com|foxnews\.com|nbcnews\.com|msn\.com)$/i;
// One Tavily credit. Returns pages that look like outlets, minus ones you already have; saves nothing.
async function search(profile) {
  const j = (profile && profile.jurisdictions) || {};
  const place = bareName(j.place && j.place.name) || clean(j.county && j.county.name), st = clean(j.state && j.state.name);
  if (!place) throw new Error('Look up an address first.');
  const doSearch = ctx.tavilySearch || require('./v2').tavilySearch;
  const res = await doSearch({ query: `local newspapers, weekly and alternative papers, TV news stations and local news websites serving ${place}, ${st}`, maxResults: 12, includeAnswer: false });
  const have = new Set([...db.added.map(a => keyOf(a.url)), ...((db.found && db.found.items) || []).map(i => i.key)]);
  const out = [], seen = new Set();
  for (const r of (res && res.results) || []) {
    const url = normUrl(r.url);
    const host = hostOf(url);
    if (!url || !host || NOT_OUTLETS.test(host) || have.has(host) || seen.has(host)) continue;
    seen.add(host);
    out.push({ name: clip(String(r.title || host).split(/\s+[|–—-]\s+/)[0], 60) || host, url: `https://${host}/`, host, note: clip(r.content, 140), kind: /\b(tv|wtol|channel|station)\b/i.test(`${r.title} ${host}`) ? 'tv' : 'paper' });
  }
  return { candidates: out.slice(0, 10), credits: 1, place };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise(resolve => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n < 100000) chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

async function route(req, reqUrl, res, send) {
  const p = reqUrl.pathname.replace(/^\/api\/lateral/, '');
  if (!p.startsWith('/civic/media')) return false;
  const sub = p.slice('/civic/media'.length).replace(/^\//, '');
  const profile = civic().profile();
  try {
    if (req.method === 'GET' && sub === 'list') return send(res, 200, await list(profile));
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (sub === 'refresh') return send(res, 200, await list(profile, { refresh: true }));
      if (sub === 'add') { add(b); return send(res, 200, await list(profile)); }
      if (sub === 'remove') { remove(String(b.id || '')); return send(res, 200, await list(profile)); }
      if (sub === 'hide') { hide(b.key); return send(res, 200, await list(profile)); }
      if (sub === 'restore') { restore(b.key); return send(res, 200, await list(profile)); }
      if (sub === 'search') return send(res, 200, await search(profile));
    }
  } catch (e) { return send(res, 200, { error: e.message }); }
  return send(res, 404, { error: 'Unknown media route.' });
}

module.exports = {
  route, list, add, remove, hide, restore, search, discover, classify, usable, build, categoriesFor, quickLinks, normUrl, clearAll, placeChanged,
  init: c => { ctx = { ...ctx, ...(c || {}) }; },
  _reset: () => { db = { placeKey: '', found: null, added: [], hidden: [] }; ctx = {}; },
  _db: () => db,
};
