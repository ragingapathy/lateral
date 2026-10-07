'use strict';
// Civic mode: boards and agendas. Local bodies beyond your city council (a county board, a school board, a city that publishes its
// meetings through Granicus, any board with a news or agenda feed) have no one nationwide data source, so you point Lateral at the
// source and it does the rest. Three kinds of source are understood:
//
//   legistar   a Legistar site (keyless web API): upcoming meetings, legislation, and, for a county or school board, its members
//   granicus   a Granicus meetings page (the agenda list a city publishes at https://<name>.granicus.com/ViewPublisher.php?view_id=N)
//   feed       any RSS or Atom feed: a district's news, an agenda feed, a county's announcements (found for you from a site address)
//
// Each board becomes one more watch in civic-watch.js ("board:<id>"), so it gets a story, headlines, a "meets tomorrow" alert and a
// digest line like the council watch does. Nothing is created until you add a board and press Watch. Boards belong to the place in
// your profile: a different address starts without them. BoardDocs and similar portals have no public feed, so they are not
// supported (many districts also publish a feed or news page, which is).
//
//   GET  boards/list                  your boards, and which kinds of source are understood
//   POST boards/suggest               look for a county Legistar site for your profile (a few quick probes; nothing is added)
//   POST boards/preview {input}       what a pasted address would give you: kind, name, a few items (or feeds found on a page)
//   POST boards/add {kind, ...spec}   keep a board ({kind:'legistar',slug,scope}, {kind:'granicus',host,viewId}, {kind:'feed',url}, label?, scope?)
//   POST boards/remove {id}           forget a board (and its watch, and the officials read from it)
//   POST boards/dismiss {id}          stop suggesting one

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.LATERAL_DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'civic-boards.json');
const LEGISTAR = 'https://webapi.legistar.com/v1';
const SCOPES = ['county', 'school', 'city', 'other'];
const MAX_BOARDS = 12;

const civic = () => require('./civic');
const watch = () => require('./civic-watch');
const feeds = () => require('./feeds');
let ctx = {};                                   // test hooks: get, getJson
const getJson = (url, opts) => (ctx.getJson || civic().getJson)(url, opts);
async function getText(url, opts) {
  const r = await (ctx.get || civic().get)(url, { timeout: 20000, ...opts });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return r.body;
}

const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { s = clean(s); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const dayOf = v => { const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ''; };
const today = () => new Date().toISOString().slice(0, 10);

// ─── Storage ─────────────────────────────────────────────────────────────────

let db = (() => {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { boards: j.boards || [], dismissed: j.dismissed || [], placeKey: j.placeKey || '' }; }
  catch { return { boards: [], dismissed: [], placeKey: '' }; }
})();
let saveTimer = null;
function saveSoon() { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 400); }
function saveNow() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, FILE); } catch { /* next change */ } }

const list = () => db.boards.slice();
const get = id => db.boards.find(b => b.id === id) || null;

// ─── Recognising what was pasted ─────────────────────────────────────────────

// Pure. -> { kind:'legistar', slug } | { kind:'granicus', host, viewId } | { kind:'url', url }; throws a plain message otherwise.
function detect(input) {
  const s = clean(input);
  if (!s) throw new Error('Paste the address of a meetings page, a Legistar or Granicus site, or a news or agenda feed.');
  const lg = s.match(/webapi\.legistar\.com\/v1\/([a-z0-9-]+)/i) || s.match(/^(?:https?:\/\/)?([a-z0-9-]+)\.legistar\.com/i);
  if (lg && !/^(www|webapi)$/i.test(lg[1])) return { kind: 'legistar', slug: lg[1].toLowerCase() };
  const gr = s.match(/^(?:https?:)?(?:\/\/)?([a-z0-9-]+)\.granicus\.com\/?([^\s]*)/i);
  if (gr) {
    const vid = (gr[2].match(/view_id=(\d+)/i) || [])[1];
    return { kind: 'granicus', host: `${gr[1].toLowerCase()}.granicus.com`, viewId: vid || '' };
  }
  if (/boarddocs\.com/i.test(s)) throw new Error('BoardDocs has no public feed Lateral can read. Look for a news or agenda feed on the district\'s own website instead, or paste its Legistar or Granicus address if it has one.');
  if (/^[a-z0-9-]{2,40}$/i.test(s)) return { kind: 'legistar', slug: s.toLowerCase() };      // a bare name: try it as a Legistar site
  let url = s;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { const u = new URL(url); if (!u.hostname.includes('.')) throw new Error('x'); } catch { throw new Error('That does not look like a web address.'); }
  return { kind: 'url', url };
}

// ─── Granicus ────────────────────────────────────────────────────────────────

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
const decode = s => String(s || '').replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, m => ENT[m] || m).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const strip = s => clean(decode(String(s || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ')));
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function dateFromText(t) {
  const iso = String(t).match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const m = String(t).match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),\s+(\d{4})\b/i);
  if (m) return new Date(Date.UTC(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]), 12)).toISOString().slice(0, 10);
  return '';
}
const absUrl = (href, host) => { const h = decode(href).trim(); return h.startsWith('//') ? 'https:' + h : /^https?:/i.test(h) ? h : `https://${host}/${h.replace(/^\//, '')}`; };

// Pure. The rows of a Granicus ViewPublisher page -> meeting items (newest first, at most 40).
function parseGranicus(html, host, viewId, now = new Date()) {
  const day0 = now.toISOString().slice(0, 10);
  const items = [], seen = new Set();
  const re = /<tr[^>]*class="[^"]*listingRow[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) && items.length < 400) {
    const row = m[1];
    const nameCell = (row.match(/<td[^>]*headers="Name"[^>]*>([\s\S]*?)<\/td>/i) || [])[1] || (row.match(/<td[^>]*>([\s\S]*?)<\/td>/i) || [])[1] || '';
    const title = clip(strip(nameCell), 200);
    if (!title) continue;
    const agenda = (row.match(/href=["']([^"']*AgendaViewer\.php\?[^"']*)["']/i) || [])[1];
    const minutes = (row.match(/href=["']([^"']*(?:MinutesViewer|Minutes)[^"']*\.php\?[^"']*)["']/i) || [])[1];
    const eventId = (row.match(/event_id=(\d+)/i) || [])[1] || '';
    const date = dateFromText(title) || dateFromText(strip(row));
    const id = `gran:${host}:${eventId || sha(title)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const bodyName = clip(title.split(/\s+on\s+\d{4}-\d{2}-\d{2}|\s+-\s+/)[0], 80) || 'Meeting';
    const upcoming = !!date && date >= day0;
    items.push({
      id, kind: 'meeting', bodyName, time: (title.match(/\b\d{1,2}:\d{2}\s?(?:AM|PM)\b/i) || [''])[0], title,
      url: agenda ? absUrl(agenda, host) : minutes ? absUrl(minutes, host) : `https://${host}/ViewPublisher.php?view_id=${viewId || 1}`,
      date, snippet: [agenda ? 'Agenda posted' : '', minutes ? 'Minutes posted' : ''].filter(Boolean).join(' · '),
      ...(upcoming ? { meetingOn: date } : {}), sig: `${agenda ? 1 : 0}${minutes ? 1 : 0}`,
    });
  }
  items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return items.slice(0, 40);
}

// A page title like "New View" says nothing; the site name does.
const granicusLabel = host => { const n = host.replace(/\.granicus\.com$/, '').replace(/^cityof/, '').replace(/[-_]+/g, ' '); return `${n.charAt(0).toUpperCase()}${n.slice(1)} meetings (Granicus)`; };

async function granicusPage(host, viewId) {
  if (!/^[a-z0-9-]+\.granicus\.com$/.test(host)) throw new Error('That is not a Granicus address.');
  const html = await getText(`https://${host}/ViewPublisher.php?view_id=${encodeURIComponent(viewId || 1)}`, { timeout: 25000 });
  const title = clip(strip((html.match(/<title>([^<]*)/i) || [])[1] || ''), 80).replace(/\s*-\s*Granicus.*$/i, '');
  return { html, title };
}

// ─── Legistar (county, school or any other body) ─────────────────────────────

async function legistarBoard(slug) {
  const bodies = await civic().legistarProbe(slug);
  if (!bodies) throw new Error(`No Legistar site called "${slug}" answered.`);
  const main = bodies.find(b => /primary legislative/i.test(b.BodyTypeName || '')) || bodies.find(b => b.BodyActiveFlag !== 0) || bodies[0];
  return { bodies, label: `${(main && main.BodyName) || slug} (Legistar)` };
}

async function legistarItems(slug, label) {
  const w = watch();
  const [matters, events] = await Promise.all([
    getJson(`${LEGISTAR}/${slug}/matters?$top=30&$orderby=MatterLastModifiedUtc%20desc`, { timeout: 25000 }),
    getJson(`${LEGISTAR}/${slug}/events?$top=60&$orderby=EventDate%20desc`, { timeout: 25000 }).catch(() => []),
  ]);
  const upcoming = (Array.isArray(events) ? events : []).filter(e => dayOf(e.EventDate) >= today()).map(e => w.eventItem(slug, e)).sort((a, b) => a.date.localeCompare(b.date));
  return { name: label, items: [...upcoming, ...(Array.isArray(matters) ? matters : []).map(m => w.matterItem(slug, m))] };
}

// ─── Feeds ───────────────────────────────────────────────────────────────────

async function feedItems(url, label) {
  const body = await getText(url, { timeout: 15000, headers: { Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml, */*' } });
  const f = feeds().parseFeed(body);
  const key = sha(url);
  return {
    name: label || f.title || 'Feed',
    items: (f.items || []).slice(0, 40).map(i => ({ id: `feed:${key}:${sha(i.url)}`, kind: 'article', title: clip(i.title, 220), url: i.url, date: dayOf(i.date), snippet: clip(i.summary, 240), sig: '' })),
  };
}

// ─── Items for a board ───────────────────────────────────────────────────────

async function fetchItems(board) {
  if (board.kind === 'legistar') return legistarItems(board.slug, board.label);
  if (board.kind === 'granicus') {
    const { html } = await granicusPage(board.host, board.viewId);
    const items = parseGranicus(html, board.host, board.viewId);
    if (!items.length) throw new Error('That Granicus page did not list any meetings.');
    return { name: board.label, items };
  }
  if (board.kind === 'feed') return feedItems(board.url, board.label);
  throw new Error('Unknown kind of board.');
}

// ─── Preview, add, remove ────────────────────────────────────────────────────

const sample = items => items.slice(0, 5).map(i => ({ title: i.title, url: i.url, date: i.date || '' }));

async function preview(input) {
  const d = detect(input);
  if (d.kind === 'legistar') {
    const lb = await legistarBoard(d.slug);
    const r = await legistarItems(d.slug, lb.label);
    return { kind: 'legistar', slug: d.slug, label: lb.label, bodies: lb.bodies.length, items: sample(r.items), canListMembers: true };
  }
  if (d.kind === 'granicus') {
    const { html, title } = await granicusPage(d.host, d.viewId);
    const items = parseGranicus(html, d.host, d.viewId);
    if (!items.length) throw new Error(d.viewId ? 'That Granicus page did not list any meetings.' : 'No meetings were listed at the default page of that site. Paste the address of the page that lists them (it contains view_id=).');
    return { kind: 'granicus', host: d.host, viewId: d.viewId || '1', label: granicusLabel(d.host), items: sample(items) };
  }
  const found = await feeds().discover(d.url).catch(() => []);
  if (!found.length) throw new Error('No news or agenda feed was found on that page. Try the district or county\'s news page, or paste the feed address itself (often ending in /feed or .xml).');
  return { kind: 'feed', feeds: found.map(f => ({ url: f.url, title: f.title, count: f.count, items: (f.sample || []).map(i => ({ title: i.title, url: i.url, date: i.date || '' })) })) };
}

// A Legistar board for a county or a school board also fills in who sits on it.
async function syncOfficials(board) {
  if (board.kind !== 'legistar' || !['county', 'school'].includes(board.scope)) return 0;
  const school = board.scope === 'school';
  const r = await civic().legistarOfficials(board.slug, null, new Date(), school ? civic().SCHOOL_BODY : null);
  const entries = (r.officials || []).map(o => ({
    officeId: school ? 'school-board' : 'county-board', office: o.office, name: o.name, body: o.body, email: o.email, phone: o.phone,
    ...(o.termStart ? { termStart: o.termStart } : {}), ...(o.termEnds ? { termEnds: o.termEnds } : {}),
    sourceUrl: o.sourceUrl, sourceNote: 'Read from the board\'s Legistar site.',
  }));
  civic().setBoardOfficials(board.id, entries);
  return entries.length;
}

async function add(spec) {
  const kind = String(spec.kind || '');
  if (db.boards.length >= MAX_BOARDS) throw new Error(`That is the most boards Lateral keeps (${MAX_BOARDS}). Remove one first.`);
  const scope = SCOPES.includes(spec.scope) ? spec.scope : 'other';
  let board;
  if (kind === 'legistar') {
    const slug = String(spec.slug || '').toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) throw new Error('That is not a Legistar site name.');
    const lb = await legistarBoard(slug);
    board = { id: `lg${sha('legistar|' + slug)}`, kind, slug, scope, label: clip(spec.label, 80) || lb.label };
  } else if (kind === 'granicus') {
    const host = String(spec.host || '').toLowerCase();
    const viewId = String(spec.viewId || '1').replace(/\D/g, '') || '1';
    const { html, title } = await granicusPage(host, viewId);
    if (!parseGranicus(html, host, viewId).length) throw new Error('That Granicus page did not list any meetings.');
    board = { id: `gr${sha(`granicus|${host}|${viewId}`)}`, kind, host, viewId, scope, label: clip(spec.label, 80) || granicusLabel(host) };
  } else if (kind === 'feed') {
    const url = String(spec.url || '').trim();
    if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('A feed address should start with https://');
    const r = await feedItems(url, clip(spec.label, 80));
    if (!r.items.length) throw new Error('That feed has no items.');
    board = { id: `fd${sha('feed|' + url)}`, kind, url, scope, label: clip(spec.label, 80) || r.name };
  } else throw new Error('Choose a Legistar, Granicus or feed source.');
  if (get(board.id)) throw new Error('That board is already on your list.');
  board.addedAt = new Date().toISOString();
  db.boards.push(board);
  db.dismissed = db.dismissed.filter(x => x !== board.id);
  saveNow();
  let members = 0, memberNote = '';
  try { members = await syncOfficials(board); } catch (e) { memberNote = e.message; }
  return { boards: list(), added: board, members, memberNote };
}

function remove(id) {
  const b = get(id);
  if (!b) throw new Error('No such board.');
  db.boards = db.boards.filter(x => x.id !== id);
  saveNow();
  try { watch().forget(`board:${id}`); } catch { /* the watch module is optional here */ }
  try { civic().dropBoardOfficials(id); } catch { /* no profile */ }
  return list();
}

function clearAll() {
  for (const b of db.boards.slice()) { try { watch().forget(`board:${b.id}`); } catch { /* ignore */ } try { civic().dropBoardOfficials(b.id); } catch { /* ignore */ } }
  db.boards = []; db.placeKey = ''; saveNow();
}

// Boards belong to a place: a new address in a different county or city starts with none.
const placeKeyOf = j => [j && j.state && (j.state.abbr || j.state.name), j && j.county && (j.county.geoid || j.county.name), j && j.place && (j.place.geoid || j.place.name)].filter(Boolean).join('|');
function placeChanged(jurisdictions) {
  const key = placeKeyOf(jurisdictions);
  if (db.placeKey && db.placeKey !== key) { clearAll(); db.dismissed = []; }
  db.placeKey = key;
  saveNow();
}

// Re-read the members of county and school boards (the profile refresh calls this).
async function refreshOfficials() {
  for (const b of db.boards) { try { await syncOfficials(b); } catch { /* keep the previous entries */ } }
}

// ─── Suggestions: a county Legistar site ─────────────────────────────────────

const countySlugs = (county, st) => {
  const c = String(county || '').replace(/\s+County$/i, '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  if (!c) return [];
  const s = String(st || '').toLowerCase();
  return [...new Set([c + 'county', c + 'county' + s, c + s, 'co' + c, c + 'co'])];
};
let suggestCache = { key: '', at: 0, value: [] };
async function suggest(profile) {
  const j = (profile && profile.jurisdictions) || {};
  if (!j.county) return [];
  const county = String(j.county.name || '').replace(/\s+County$/i, '');
  const key = `${placeKeyOf(j)}|${db.boards.map(b => b.id).join(',')}|${db.dismissed.join(',')}`;
  if (suggestCache.key === key && Date.now() - suggestCache.at < 3600000) return suggestCache.value;
  const slugs = countySlugs(j.county.name, j.state && j.state.abbr).filter(s => !db.boards.some(b => b.kind === 'legistar' && b.slug === s));
  const probed = await Promise.all(slugs.map(async slug => ({ slug, bodies: await civic().legistarProbe(slug).catch(() => null) })));
  const out = [];
  for (const p of probed) {
    if (!p.bodies) continue;
    // a county's own site names the county or a county body; a stranger's slug that happens to exist does not
    if (!p.bodies.some(b => new RegExp(`\\b${county.replace(/[^A-Za-z0-9 ]/g, '')}\\b|\\bcounty\\b`, 'i').test(b.BodyName || ''))) continue;
    const id = `lg${sha('legistar|' + p.slug)}`;
    if (db.dismissed.includes(id)) continue;
    const main = p.bodies.find(b => /primary legislative/i.test(b.BodyTypeName || '')) || p.bodies[0];
    out.push({ id, kind: 'legistar', slug: p.slug, scope: 'county', label: `${(main && main.BodyName) || county + ' County'} (Legistar)`, why: `${p.slug}.legistar.com answered and lists county bodies.` });
    break;
  }
  suggestCache = { key, at: Date.now(), value: out };
  return out;
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
  if (!p.startsWith('/civic/boards')) return false;
  const sub = p.slice('/civic/boards'.length).replace(/^\//, '');
  try {
    if (req.method === 'GET' && sub === 'list') return send(res, 200, { boards: list(), kinds: ['legistar', 'granicus', 'feed'], scopes: SCOPES });
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (sub === 'suggest') return send(res, 200, { suggestions: await suggest(civic().profile()) });
      if (sub === 'preview') return send(res, 200, await preview(b.input));
      if (sub === 'add') return send(res, 200, await add(b));
      if (sub === 'remove') return send(res, 200, { boards: remove(String(b.id || '')) });
      if (sub === 'dismiss') { const id = String(b.id || ''); if (id && !db.dismissed.includes(id)) db.dismissed.push(id); saveNow(); suggestCache = { key: '', at: 0, value: [] }; return send(res, 200, { ok: true }); }
    }
  } catch (e) { return send(res, 200, { error: e.message }); }
  return send(res, 404, { error: 'Unknown boards route.' });
}

module.exports = {
  route, list, get, fetchItems, add, remove, preview, suggest, detect, parseGranicus, clearAll, placeChanged, refreshOfficials, syncOfficials, countySlugs,
  init: c => { ctx = { ...ctx, ...(c || {}) }; },
  _reset: () => { db = { boards: [], dismissed: [], placeKey: '' }; ctx = {}; suggestCache = { key: '', at: 0, value: [] }; },
  _db: () => db,
};
