'use strict';
// Civic mode, part 1: one address in, a Civic Profile out. It answers "who represents me?" at every level of
// government, with contact details wherever a free source has them. No API keys are needed.
//
//  Pipeline (every source is free and keyless; the address only ever goes to US Census Bureau servers):
//    1  US Census Geocoder         address -> coordinates + county / place GEOIDs. Its own district layers are stale
//                                  (pre-2022 maps) and are IGNORED.
//    2  TIGERweb (Census)          coordinates -> congressional, state senate, state house and school districts. Layers are
//                                  found by name and year, never by hard-coded id, because the ids shift each release.
//    3  congress-legislators       current members of Congress (public-domain dataset): phone, website, office.
//    4  openstates/people          state legislators and the governor (public dataset on GitHub): email, phone, office.
//    5  Legistar web API           city / county council roster, when the place uses Legistar (many do). Found by guess and
//                                  confirmed by the user, or by pasting a *.legistar.com address.
//
//  Privacy: the street address is resolved and then dropped. Only district identifiers (GEOIDs), the place names and a
//  "City, ST" label are stored, in data/civic.json. Coordinates are never stored or logged.
//
//  Social accounts: members of Congress come from the public-domain legislators-social-media dataset (state legislators
//  from their openstates records, where listed); anything missing can be added by hand, or found with an opt-in web search
//  (uses Tavily credits, and every match is shown for confirmation). Recent YouTube and Mastodon posts are read from their
//  public feeds. Instagram, TikTok, X and Facebook only get links: they offer no free way to read other people's posts.
//  Maps: district outlines come from the same Census service, fetched by district id (no address) and drawn locally.
//
//  Routes:  GET  /civic/profile            the stored profile (or null) plus which sources are available
//           POST /civic/lookup {address}   build a profile from an address
//           POST /civic/legistar {slug|url|confirm}   set or confirm the city's Legistar site
//           POST /civic/refresh            re-check officials from the stored identifiers (no address needed)
//           POST /civic/remove             delete the profile
//           GET  /civic/shapes             district outlines (GeoJSON) for the map, plus whether the new congressional map differs
//           GET  /civic/posts?key=         recent YouTube / Mastodon posts for one official
//           GET  /civic/about?key=         a short Wikipedia bio and link for one official (when a clear match exists)
//           GET  /civic/photo?key=         the official's portrait, fetched and cached by this server (404 when there is none)
//           POST /civic/office/discover {officeId}   web-search for a county / school office (1 Tavily credit; nothing is saved)
//           POST /civic/office/add {officeId|office, people:[...]}   save confirmed or hand-entered local officials
//           POST /civic/office/remove {key}          remove one
//           POST /civic/social/set {key,platform,handle}   add an account by hand (handle or profile address)
//           POST /civic/social/remove {key,platform}       remove an account added by hand
//           POST /civic/social/discover {key,platforms}    web-search for missing accounts (1 Tavily credit per platform)

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const DATA_DIR = process.env.LATERAL_DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'civic.json');
const CACHE_DIR = path.join(DATA_DIR, 'civic-cache');
const UA = 'Mozilla/5.0 (compatible; Lateral/2.2; +https://github.com/ragingapathy/lateral)';
const MAX_BYTES = 8 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

const CENSUS_GEOCODER = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';
const TIGERWEB = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb';
const CONGRESS_DATA = 'https://unitedstates.github.io/congress-legislators/legislators-current.json';
const CONGRESS_SOCIAL = 'https://unitedstates.github.io/congress-legislators/legislators-social-media.json';
const OPENSTATES_API = 'https://api.github.com/repos/openstates/people/contents/data';
const LEGISTAR = 'https://webapi.legistar.com/v1';

// Places whose Legistar site is known to be right (a guess for any other place needs the user's confirmation).
const KNOWN_LEGISTAR = { '3977000': 'toledo' };

const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
const FIPS_TO_ABBR = { '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY' };

// Test hook: lets a test stand in for the web search.
let ctx = {};

// ─── Storage ─────────────────────────────────────────────────────────────────

// profile: the Civic profile. social: accounts added by hand or confirmed from a search, keyed by official ("level|office|name").
// offices: local offices beyond the council (mayor, sheriff, judges, school board...): { entries: [...], dismissed: [office ids the
// person removed, so a refresh does not put an automatic one back] }.
const noOffices = () => ({ entries: [], dismissed: [] });
let db = (() => {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { profile: j.profile || null, social: j.social || {}, offices: { ...noOffices(), ...(j.offices || {}) } }; }
  catch { return { profile: null, social: {}, offices: noOffices() }; }
})();
function save() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ profile: db.profile, social: db.social, offices: db.offices })); fs.renameSync(tmp, FILE); } catch { /* next change */ }
}

function cacheGet(name, ttl) {
  try {
    const f = path.join(CACHE_DIR, name);
    if (Date.now() - fs.statSync(f).mtimeMs > ttl) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { return null; }
}
function cacheSet(name, value) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, name), JSON.stringify(value)); } catch { /* cache is optional */ }
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

function get(urlStr, { timeout = 15000, headers = {}, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('bad URL')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET', timeout, headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Encoding': 'identity', ...headers } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects > 0) {
        r.resume();
        return resolve(get(new URL(r.headers.location, urlStr).href, { timeout, headers, redirects: redirects - 1 }));
      }
      const chunks = []; let size = 0;
      r.on('data', c => { size += c.length; if (size > MAX_BYTES) { req.destroy(new Error('response too large')); } else chunks.push(c); });
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      r.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
// Like get(), but returns the raw bytes (for photos).
function getBuf(urlStr, { timeout = 15000, redirects = 3, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('bad URL')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET', timeout, headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.5', 'Accept-Encoding': 'identity' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects > 0) {
        r.resume();
        return resolve(getBuf(new URL(r.headers.location, urlStr).href, { timeout, maxBytes, redirects: redirects - 1 }));
      }
      const chunks = []; let size = 0;
      r.on('data', c => { size += c.length; if (size > maxBytes) req.destroy(new Error('image too large')); else chunks.push(c); });
      r.on('end', () => resolve({ status: r.statusCode, type: String(r.headers['content-type'] || ''), buf: Buffer.concat(chunks) }));
      r.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
async function getJson(url, opts) {
  const r = await get(url, opts);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  try { return JSON.parse(r.body); } catch { throw new Error('not JSON'); }
}

// Run a stage, record how it went, and never let one failing source sink the whole profile.
async function stage(sources, name, provider, endpoint, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    sources.push({ stage: name, provider, endpoint, ok: true, ms: Date.now() - t0, fetchedAt: new Date().toISOString() });
    return out;
  } catch (e) {
    sources.push({ stage: name, provider, endpoint, ok: false, error: String(e.message || e).slice(0, 140), ms: Date.now() - t0, fetchedAt: new Date().toISOString() });
    return null;
  }
}

// ─── Stage 1: geocode ────────────────────────────────────────────────────────

function normalizeAddress(input) {
  const a = String(input || '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();
  if (a.length < 8 || a.length > 200) throw new Error('Enter a full street address: number, street, city, state and ZIP.');
  if (!/\d/.test(a)) throw new Error('Census needs a street number. Enter a full street address: number, street, city, state and ZIP.');
  return a;
}

async function geocode(address) {
  const url = `${CENSUS_GEOCODER}?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&vintage=Census2020_Current&format=json`;
  let j;
  // The Census service is sometimes slow or briefly unavailable: one retry, then a plain explanation.
  for (let attempt = 0; ; attempt++) {
    try { j = await getJson(url, { timeout: 20000 }); break; }
    catch (e) {
      if (attempt === 0) continue;
      throw new Error('The Census Bureau\'s address service did not answer (it is sometimes slow). Try again in a minute.');
    }
  }
  const m = (j.result && j.result.addressMatches || [])[0];
  if (!m) throw new Error('The Census Bureau could not find that address. Check the street number and spelling, and include city, state and ZIP.');
  const g = m.geographies || {};
  const pick = (re) => { const k = Object.keys(g).find(x => re.test(x)); return k ? (g[k] || [])[0] : null; };
  const incorporated = pick(/^Incorporated Places$/);
  const state = pick(/^States$/), county = pick(/^Counties$/), place = incorporated || pick(/^Census Designated Places$/), sub = pick(/^County Subdivisions$/);
  if (!state || !county) throw new Error('The Census Bureau matched the address but returned no county. Try again with the ZIP code.');
  return {
    x: m.coordinates.x, y: m.coordinates.y, matched: m.matchedAddress,
    state: { name: state.NAME, abbr: FIPS_TO_ABBR[state.GEOID] || '', geoid: state.GEOID },
    county: { name: county.NAME, geoid: county.GEOID },
    place: place ? { name: cleanPlace(place.NAME), geoid: place.GEOID, kind: incorporated ? 'incorporated' : 'cdp' } : null,
    subdivision: sub ? { name: sub.NAME, geoid: sub.GEOID } : null,
  };
}
const cleanPlace = n => String(n || '').replace(/\s+(city|town|village|borough|municipality|CDP|township|charter township|plantation)$/i, '').trim();

// ─── Stage 2: TIGERweb districts ─────────────────────────────────────────────

// The current Congress number (the 119th runs 2025-2026) and the next one.
function congressNumber(d = new Date()) { return Math.floor((d.getFullYear() - 1789) / 2) + 1; }
const ord = n => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;

// Find the layer ids by name. Returns { congress, congressNext, upper, lower, school: [{id,type}], state, incorporated, cdp }.
async function resolveLayers(now = new Date()) {
  const cached = cacheGet('tigerweb-layers-v2.json', 7 * DAY);
  if (cached && cached.congress !== undefined && cached.year === now.getFullYear()) return cached;
  const [leg, sch, sc, pl] = await Promise.all([
    getJson(`${TIGERWEB}/Legislative/MapServer?f=json`), getJson(`${TIGERWEB}/School/MapServer?f=json`),
    getJson(`${TIGERWEB}/State_County/MapServer?f=json`), getJson(`${TIGERWEB}/Places_CouSub_ConCity_SubMCD/MapServer?f=json`),
  ]);
  const L = leg.layers || [], S = sch.layers || [];
  const first = (list, re) => { const x = list.find(l => re.test(l.name)); return x ? x.id : null; };
  const cur = congressNumber(now);
  // Newest "YYYY State Legislative Districts" set that is not in the future.
  const years = [...new Set(L.map(l => (l.name.match(/^(\d{4}) State Legislative Districts - Upper$/) || [])[1]).filter(Boolean))].map(Number).filter(y => y <= now.getFullYear() + 1).sort((a, b) => b - a);
  const y = years[0];
  const out = {
    year: now.getFullYear(), session: cur,
    congress: first(L, new RegExp(`^${ord(cur)} Congressional Districts$`)),
    congressNext: first(L, new RegExp(`^${ord(cur + 1)} Congressional Districts$`)),
    legYear: y || null,
    upper: y ? first(L, new RegExp(`^${y} State Legislative Districts - Upper$`)) : null,
    lower: y ? first(L, new RegExp(`^${y} State Legislative Districts - Lower$`)) : null,
    school: [['unified', 'Unified School Districts'], ['elementary', 'Elementary School Districts'], ['secondary', 'Secondary School Districts']]
      .map(([type, name]) => ({ type, id: first(S, new RegExp(`^${name}$`)) })).filter(x => x.id !== null),
    state: first(sc.layers || [], /^States$/),
    incorporated: first(pl.layers || [], /^Incorporated Places$/),
    cdp: first(pl.layers || [], /^Census Designated Places$/),
  };
  cacheSet('tigerweb-layers-v2.json', out);
  return out;
}

async function pointQuery(service, layerId, x, y) {
  const url = `${TIGERWEB}/${service}/MapServer/${layerId}/query?geometryType=esriGeometryPoint&geometry=${x},${y}&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json`;
  const j = await getJson(url, { timeout: 20000 });
  const f = (j.features || [])[0];
  return f ? f.attributes : null;
}

async function districts(x, y, sources) {
  const L = await stage(sources, 'layers', 'Census TIGERweb', `${TIGERWEB}/Legislative + School (layer list)`, () => resolveLayers());
  if (!L) return {};
  const q = (service, id, label) => id === null || id === undefined ? Promise.resolve(null)
    : stage(sources, label, 'Census TIGERweb', `${TIGERWEB}/${service}/MapServer/${id}/query`, () => pointQuery(service, id, x, y));
  const [cong, congNext, up, low, ...sch] = await Promise.all([
    q('Legislative', L.congress, 'congress'), q('Legislative', L.congressNext, 'congress-next'),
    q('Legislative', L.upper, 'state-senate'), q('Legislative', L.lower, 'state-house'),
    ...L.school.map(s => q('School', s.id, `school-${s.type}`)),
  ]);
  const cd = a => a ? { district: a.BASENAME && /^\d+$/.test(a.BASENAME) ? Number(a.BASENAME) : 0, name: a.NAME, geoid: a.GEOID, atLarge: !/^\d+$/.test(a.BASENAME || '') || Number(a.BASENAME) === 0 } : null;
  const sd = a => a ? { district: a.BASENAME, name: a.NAME, geoid: a.GEOID, lsy: a.LSY || String(L.legYear || '') } : null;
  const schools = L.school.map((s, i) => sch[i] ? { type: s.type, name: sch[i].NAME || sch[i].BASENAME, geoid: sch[i].GEOID } : null).filter(Boolean);
  return {
    congress: cong ? { ...cd(cong), session: L.session } : null,
    congressNext: congNext ? { ...cd(congNext), session: L.session + 1 } : null,
    stateSenate: sd(up), stateHouse: sd(low),
    schoolDistricts: (schools.find(s => s.type === 'unified') ? [schools.find(s => s.type === 'unified')] : schools),
  };
}

// ─── Stage 3: federal officials ──────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);

async function congressRoster() {
  let roster = cacheGet('congress-legislators.json', DAY);
  if (roster) return roster;
  roster = await getJson(CONGRESS_DATA, { timeout: 25000 });
  cacheSet('congress-legislators.json', roster);
  return roster;
}

// A plain YYYY-MM-DD date (the shape every source here uses for term dates).
const validDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));
function electionYearOf(termEnd) { const y = Number(String(termEnd || '').slice(0, 4)); return y ? y - 1 : null; }

function federalOfficials(roster, stateAbbr, district, now = new Date(), socialMap = {}) {
  const out = [], asOf = now.toISOString().slice(0, 10), thisYear = now.getFullYear();
  for (const m of roster || []) {
    const t = (m.terms || [])[m.terms.length - 1];
    if (!t || t.state !== stateAbbr) continue;
    const isSen = t.type === 'sen';
    if (!isSen && Number(t.district) !== Number(district)) continue;
    const ey = electionYearOf(t.end);
    out.push({
      name: (m.name && (m.name.official_full || `${m.name.first} ${m.name.last}`)) || '',
      office: isSen ? 'U.S. Senator' : (stateAbbr === 'DC' || t.type === 'del' ? 'U.S. Delegate' : 'U.S. Representative'),
      level: 'federal', district: isSen ? null : Number(t.district), party: t.party || '',
      phone: t.phone || '', website: t.url || '', contactForm: t.contact_form || '', address: t.address || '',
      bioguide: m.id && m.id.bioguide, wikipedia: (m.id && m.id.wikipedia) || '', socialData: datasetSocial(socialMap[m.id && m.id.bioguide]), termStart: validDay(t.start) ? t.start : '', termEnds: t.end || '', nextElection: ey,
      upForElection: ey === thisYear, sourceUrl: 'https://github.com/unitedstates/congress-legislators', asOf,
    });
  }
  return out.sort((a, b) => (a.office === b.office ? 0 : a.office === 'U.S. Senator' ? 1 : -1) || a.name.localeCompare(b.name));
}

// ─── Stage 4: state officials ────────────────────────────────────────────────

// A small YAML reader: enough for the openstates "people" files (maps, and lists of maps, two levels deep).
function parseYaml(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  let i = 0;
  const indentOf = l => l.match(/^ */)[0].length;
  const scalar = v => {
    v = v.trim();
    if (v === '' || v === 'null' || v === '~') return v === '' ? '' : null;
    if ((v[0] === '"' && v.endsWith('"') && v.length > 1) || (v[0] === "'" && v.endsWith("'") && v.length > 1)) return v.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
    if (v === 'true' || v === 'false') return v === 'true';
    return v;
  };
  function block(indent) { return lines[i] && lines[i].trim().startsWith('-') ? list(indent) : map(indent); }
  function map(indent) {
    const o = {};
    while (i < lines.length && indentOf(lines[i]) === indent && !lines[i].trim().startsWith('-')) {
      const m = lines[i].trim().match(/^([^:]+?):(?:\s+(.*))?$/);
      i++;
      if (!m) continue;
      const key = m[1].trim(), val = m[2] === undefined ? '' : m[2];
      if (val === '' || val === '|' || val === '>') {
        if (i < lines.length && (indentOf(lines[i]) > indent || (indentOf(lines[i]) === indent && lines[i].trim().startsWith('-')))) o[key] = block(indentOf(lines[i]));
        else o[key] = '';
      } else o[key] = scalar(val);
    }
    return o;
  }
  function list(indent) {
    const arr = [];
    while (i < lines.length && indentOf(lines[i]) === indent && lines[i].trim().startsWith('-')) {
      const rest = lines[i].trim().slice(1).trim();
      const kv = rest.match(/^([A-Za-z_][\w -]*):(?:\s+(.*))?$/);
      if (kv) { lines[i] = ' '.repeat(indent + 2) + rest; arr.push(map(indent + 2)); }
      else { arr.push(scalar(rest)); i++; }
    }
    return arr;
  }
  return lines.length ? block(indentOf(lines[0])) : {};
}

const roleIsCurrent = (r, now = today()) => r && (!r.end_date || String(r.end_date) >= now);

// Reduce an openstates person file to what Civic mode shows.
function personRecord(y, now = today()) {
  const roles = (Array.isArray(y.roles) ? y.roles : []).filter(r => roleIsCurrent(r, now));
  if (!roles.length) return null;
  const offices = Array.isArray(y.offices) ? y.offices : [];
  const off = offices.find(o => o.classification === 'capitol') || offices[0] || {};
  const links = Array.isArray(y.links) ? y.links : [];
  // Social accounts: from any social-media link in the record, and from an "ids" block when there is one.
  const social = {};
  for (const l of links) { const s = socialFromUrl(l && l.url); if (s && !social[s.platform]) social[s.platform] = s.handle; }
  if (y.ids && typeof y.ids === 'object') for (const p of ['twitter', 'facebook', 'instagram', 'youtube']) { const h = normalizeHandle(p, y.ids[p]); if (h && !social[p]) social[p] = h; }
  return {
    id: String(y.id || '').replace('ocd-person/', ''), name: y.name || '', social,
    party: (Array.isArray(y.party) && y.party[0] && y.party[0].name) || '',
    email: y.email || '', phone: off.voice || '', address: off.address || '',
    website: (links[0] && links[0].url) || '', image: y.image || '',
    roles: roles.map(r => ({ type: r.type, district: String(r.district == null ? '' : r.district), start: r.start_date || '', end: r.end_date || '' })),
  };
}

async function stateIndex(abbr, sources) {
  const key = `openstates-${abbr.toLowerCase()}-v2.json`;
  const cached = cacheGet(key, 30 * DAY);
  if (cached) return cached;
  const dirs = ['legislature', 'executive'];
  const out = { legislature: [], executive: [] };
  for (const d of dirs) {
    let listing;
    try { listing = await getJson(`${OPENSTATES_API}/${abbr.toLowerCase()}/${d}`, { timeout: 20000 }); } catch (e) { if (d === 'legislature') throw e; continue; }
    const files = listing.filter(f => /\.ya?ml$/.test(f.name) && f.download_url);
    let n = 0;
    const worker = async () => {
      while (n < files.length) {
        const f = files[n++];
        try { const rec = personRecord(parseYaml((await get(f.download_url, { timeout: 15000 })).body)); if (rec) out[d].push(rec); } catch { /* skip one bad file */ }
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
  }
  if (!out.legislature.length) throw new Error('no legislators found');
  cacheSet(key, out);
  return out;
}

const sameDistrict = (a, b) => {
  a = String(a == null ? '' : a).trim().toLowerCase(); b = String(b == null ? '' : b).trim().toLowerCase();
  if (!a || !b) return false;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) === Number(b);
  return a === b;
};

function stateOfficials(index, stateAbbr, upperDistrict, lowerDistrict, now = new Date()) {
  const asOf = now.toISOString().slice(0, 10), out = [];
  // The District of Columbia has no state legislature: its "upper" seats are the City Council wards.
  const dc = stateAbbr === 'DC';
  const add = (p, role, office) => out.push({
    name: p.name, office: dc && role.type === 'upper' ? `D.C. Councilmember, Ward ${role.district}` : office,
    level: dc ? 'local' : 'state', district: role.district, party: p.party, email: p.email, phone: p.phone, socialData: p.social || {}, osId: p.id ? `ocd-person/${p.id}` : '',
    website: p.website, address: p.address, image: p.image,
    // Open States dates the role, not the term: "since" is when this seat's current role began, and an end date appears only when listed.
    ...(validDay(role.start) ? { termStart: role.start } : {}), ...(validDay(role.end) && role.end > (role.start || '') ? { termEnds: role.end } : {}),
    sourceUrl: `https://github.com/openstates/people/tree/main/data/${stateAbbr.toLowerCase()}`, asOf,
  });
  for (const p of (index && index.legislature) || []) {
    for (const r of p.roles) {
      if (r.type === 'upper' && upperDistrict != null && sameDistrict(r.district, upperDistrict)) add(p, r, 'State Senator');
      if (r.type === 'lower' && lowerDistrict != null && sameDistrict(r.district, lowerDistrict)) add(p, r, 'State Representative');
    }
  }
  for (const p of dc ? [] : (index && index.executive) || []) {
    for (const r of p.roles) {
      if (/^governor$/i.test(r.type)) add(p, r, 'Governor');
      else if (/lieutenant|lt[_ ]?governor/i.test(r.type)) add(p, r, 'Lieutenant Governor');
    }
  }
  const rank = o => ({ Governor: 0, 'Lieutenant Governor': 1, 'State Senator': 2, 'State Representative': 3 }[o.office] ?? 4);
  return out.sort((a, b) => (rank(a) - rank(b)) || a.name.localeCompare(b.name));
}

// ─── Stage 5: Legistar (city / county council) ───────────────────────────────

const slugify = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

function legistarCandidates(place, county, stateAbbr) {
  const p = slugify(place), c = slugify(String(county || '').replace(/\s+County$/i, '')), st = stateAbbr.toLowerCase();
  const list = [];
  if (p) list.push(p, p + st, 'cityof' + p, p + 'city', p + 'council');
  if (c) list.push(c + 'county', c + st, 'co' + c);
  return [...new Set(list)];
}

function legistarSlugFromUrl(input) {
  const s = String(input || '').trim();
  const api = s.match(/webapi\.legistar\.com\/v1\/([a-z0-9-]+)/i);
  if (api) return api[1].toLowerCase();
  const m = s.match(/^(?:https?:\/\/)?([a-z0-9-]+)\.legistar\.com/i);
  if (m && !/^(www|webapi)$/i.test(m[1])) return m[1].toLowerCase();
  return /^[a-z0-9-]{2,40}$/i.test(s) ? s.toLowerCase() : '';
}

async function legistarProbe(slug) {
  try {
    const b = await getJson(`${LEGISTAR}/${slug}/bodies`, { timeout: 7000 });
    return Array.isArray(b) && b.length ? b : null;
  } catch { return null; }
}

async function legistarDiscover(candidates) {
  const results = await Promise.all(candidates.map(async slug => ({ slug, bodies: await legistarProbe(slug) })));
  return results.find(r => r.bodies) || null;
}

const PRIMARY_BODY = /(city|town|village|borough|county|metro|municipal)?\s*(council|board of supervisors|commissioners|board of aldermen|aldermen|board of legislators|legislature|assembly)\b/i;

// Legistar writes dates like 2029-08-25T00:00:00; keep the day.
const termDay = v => { const d = String(v || '').slice(0, 10); return validDay(d) ? d : ''; };
const SCHOOL_BODY = /\b(board of education|school board|board of school (directors|trustees)|board of trustees|school committee)\b/i;

// `bodyPattern` picks the body to list when it is not the main council: a school board's own Legistar site, say.
async function legistarOfficials(slug, bodies, now = new Date(), bodyPattern = null) {
  bodies = bodies || await legistarProbe(slug);
  if (!bodies) throw new Error('Legistar site not reachable');
  // The main legislative body: Legistar marks it, otherwise match on the name.
  const primary = bodies.filter(b => b.BodyActiveFlag !== 0 && (bodyPattern ? bodyPattern.test(b.BodyName || '') : (/primary legislative/i.test(b.BodyTypeName || '') || PRIMARY_BODY.test(b.BodyName || ''))));
  const main = primary.find(b => /primary legislative/i.test(b.BodyTypeName || '')) || primary[0];
  if (!main) return { body: null, officials: [], bodies: bodies.length };
  let all = [], skip = 0;
  for (let page = 0; page < 8; page++) {
    const rows = await getJson(`${LEGISTAR}/${slug}/officeRecords?$top=1000&$skip=${skip}`, { timeout: 25000 });
    all = all.concat(rows);
    if (rows.length < 1000) break;
    skip += 1000;
  }
  const cur = all.filter(r => r.OfficeRecordBodyId === main.BodyId && new Date(r.OfficeRecordStartDate || 0) <= now && (!r.OfficeRecordEndDate || new Date(r.OfficeRecordEndDate) > now));
  const seen = new Set(), asOf = now.toISOString().slice(0, 10), officials = [];
  for (const r of cur) {
    const key = r.OfficeRecordPersonId || r.OfficeRecordFullName;
    if (seen.has(key)) continue;
    seen.add(key);
    officials.push({
      name: r.OfficeRecordFullName || '', office: r.OfficeRecordTitle || `${main.BodyName} member`, level: 'local',
      body: main.BodyName, email: r.OfficeRecordEmail || '', phone: r.OfficeRecordPhone || '',
      ...(termDay(r.OfficeRecordStartDate) ? { termStart: termDay(r.OfficeRecordStartDate) } : {}),
      ...(termDay(r.OfficeRecordEndDate) && termDay(r.OfficeRecordEndDate) > termDay(r.OfficeRecordStartDate) ? { termEnds: termDay(r.OfficeRecordEndDate) } : {}),
      sourceUrl: `https://${slug}.legistar.com/`, asOf,
    });
  }
  return { body: main.BodyName, officials: officials.sort((a, b) => a.name.localeCompare(b.name)), bodies: bodies.length };
}

// ─── Profile assembly ────────────────────────────────────────────────────────

let inFlight = null;

function describeGaps(p) {
  const got = [], missing = [];
  (p.officials.some(o => o.level === 'federal') ? got : missing).push('federal');
  (p.officials.some(o => o.level === 'state') ? got : missing).push('state');
  (p.jurisdictions.schoolDistricts && p.jurisdictions.schoolDistricts.length ? got : missing).push('school district');
  (p.local && p.local.officials && p.local.officials.length ? got : missing).push(p.jurisdictions.place ? 'city council' : 'city');
  return { got, missing };
}

async function buildFromIdentifiers(ident, sources, prevLocal) {
  const j = ident.jurisdictions;
  const [roster, sIndex, socialMap] = await Promise.all([
    stage(sources, 'federal-officials', 'congress-legislators', CONGRESS_DATA, () => congressRoster()),
    j.state.abbr ? stage(sources, 'state-officials', 'openstates/people (GitHub)', `${OPENSTATES_API}/${j.state.abbr.toLowerCase()}`, () => stateIndex(j.state.abbr, sources)) : null,
    stage(sources, 'federal-social', 'congress-legislators (social media)', CONGRESS_SOCIAL, () => socialRoster()),
  ]);
  const officials = [];
  if (roster && j.congress) officials.push(...federalOfficials(roster, j.state.abbr, j.congress.district, new Date(), socialMap || {}));
  if (sIndex) officials.push(...stateOfficials(sIndex, j.state.abbr, j.stateSenate && j.stateSenate.district, j.stateHouse && j.stateHouse.district));

  // Local: a confirmed (or known) Legistar site first, else try to find one.
  let local = prevLocal && prevLocal.slug ? { ...prevLocal } : null;
  if (!local && j.place) {
    const known = KNOWN_LEGISTAR[j.place.geoid];
    const found = await stage(sources, 'local-discovery', 'Legistar web API', `${LEGISTAR}/{city}/bodies`, () => legistarDiscover(known ? [known] : legistarCandidates(j.place.name, j.county.name, j.state.abbr)));
    if (found) local = { type: 'legistar', slug: found.slug, confirmed: !!known, guessedFrom: j.place.name };
  }
  if (local && local.slug) {
    const res = await stage(sources, 'local-officials', 'Legistar web API', `${LEGISTAR}/${local.slug}/officeRecords`, () => legistarOfficials(local.slug));
    if (res) { local.body = res.body; local.officials = res.officials; local.url = `https://${local.slug}.legistar.com/`; }
    else local.officials = [];
  }
  return { officials, local };
}

function publicLocal(local) {
  if (!local) return null;
  return { type: local.type, slug: local.slug, confirmed: !!local.confirmed, guessedFrom: local.guessedFrom || '', body: local.body || '', url: local.url || '', officialCount: (local.officials || []).length };
}

function assemble(label, jurisdictions, officials, local, sources) {
  const all = officials.concat((local && local.officials) || []).concat(db.offices.entries);
  const p = {
    version: 3, label, asOf: new Date().toISOString(), jurisdictions, officials: all,
    local: local ? { ...publicLocal(local), officials: local.officials || [] } : null,
    sources, stories: [],
  };
  p.coverage = describeGaps(p);
  return p;
}

async function lookup(rawAddress) {
  if (inFlight) throw new Error('A lookup is already running. Try again in a moment.');
  inFlight = true;
  try {
    const address = normalizeAddress(rawAddress);
    const sources = [];
    const geo = await stage(sources, 'geocode', 'US Census Geocoder', CENSUS_GEOCODER, () => geocode(address));
    if (!geo) throw new Error((sources[0] && sources[0].error) || 'Address lookup failed.');
    const d = await districts(geo.x, geo.y, sources);
    const jurisdictions = {
      state: geo.state, county: geo.county, place: geo.place, subdivision: geo.subdivision,
      congress: d.congress || null, congressNext: d.congressNext || null,
      stateSenate: d.stateSenate || null, stateHouse: d.stateHouse || null, schoolDistricts: d.schoolDistricts || [],
    };
    // A new address is a new place: the local offices from the old one do not carry over. (Wikidata can take several seconds the
    // first time it is asked about a place, so the mayor is looked up alongside everything else, not after it.)
    db.offices = noOffices();
    db.social = {};
    const mayor = autoMayor({ jurisdictions }, sources).catch(() => {});
    const { officials, local } = await buildFromIdentifiers({ jurisdictions }, sources, null);
    await mayor;
    const label = `${geo.place ? geo.place.name : geo.county.name}, ${geo.state.abbr || geo.state.name}`;
    // The coordinates and the street address end here: they are not part of the profile.
    db.profile = assemble(label, jurisdictions, officials, local, sources);
    save();
    // Boards belong to a place: a different address starts without the old ones.
    try { require('./civic-boards').placeChanged(jurisdictions); } catch { /* boards are optional */ }
    return db.profile;
  } finally { inFlight = null; }
}

async function refresh() {
  if (!db.profile) throw new Error('No Civic profile yet.');
  const p = db.profile, sources = [];
  const mayor = autoMayor(p, sources).catch(() => {});
  const { officials, local } = await buildFromIdentifiers({ jurisdictions: p.jurisdictions }, sources, p.local && p.local.slug ? { ...p.local, officials: undefined } : null);
  await mayor;
  db.profile = { ...assemble(p.label, p.jurisdictions, officials, local, sources), stories: p.stories || [] };
  save();
  try { await require('./civic-boards').refreshOfficials(); } catch { /* boards are optional */ }
  return db.profile;
}

async function setLegistar(input) {
  if (!db.profile) throw new Error('Look up an address first.');
  const slug = legistarSlugFromUrl(input);
  if (!slug) throw new Error('Paste the city\'s Legistar address (something like https://yourcity.legistar.com).');
  const bodies = await legistarProbe(slug);
  if (!bodies) throw new Error(`No Legistar site called "${slug}" answered.`);
  const p = db.profile, sources = [];
  const prev = { type: 'legistar', slug, confirmed: true, guessedFrom: (p.local && p.local.guessedFrom) || '' };
  const res = await stage(sources, 'local-officials', 'Legistar web API', `${LEGISTAR}/${slug}/officeRecords`, () => legistarOfficials(slug, bodies));
  prev.body = res ? res.body : ''; prev.officials = res ? res.officials : []; prev.url = `https://${slug}.legistar.com/`;
  const base = p.officials.filter(o => o.level !== 'local');
  db.profile = { ...assemble(p.label, p.jurisdictions, base, prev, p.sources.filter(s => !/^local-/.test(s.stage)).concat(sources)), stories: p.stories || [] };
  save();
  return db.profile;
}

function remove() { db.profile = null; db.social = {}; db.offices = noOffices(); try { require('./civic-boards').clearAll(); } catch { /* boards are optional */ } save(); }

// ─── Local offices (see civic-offices.js) ────────────────────────────────────

const offices = () => require('./civic-offices');
const OFFICE_SOURCES = new Set(['wikidata', 'search', 'manual', 'board']);

// The mayor comes from Wikidata with no account and no cost. A mayor the person removed, or entered by hand, is left alone.
async function autoMayor(p, sources) {
  const have = db.offices.entries.find(e => e.officeId === 'mayor' || /^mayor$/i.test(e.office));
  if (have && have.source !== 'wikidata') return;
  if (db.offices.dismissed.includes('mayor')) return;
  const found = await stage(sources, 'local-mayor', 'Wikidata', 'https://query.wikidata.org/sparql', () => offices().wikidataMayor(ctx.getJson || getJson, p));
  db.offices.entries = db.offices.entries.filter(e => e.source !== 'wikidata' || e.officeId !== 'mayor');
  if (found) db.offices.entries.push({ ...found, asOf: today() });
}

// What the Civic page shows: each office, who is on file for it, and how they can be filled in.
function officesView(p) {
  const cat = offices().catalogFor(p);
  return {
    catalog: cat.map(c => ({
      id: c.id, office: c.office, title: c.title, available: c.available, via: c.via, hint: c.hint, multi: c.multi, body: c.body,
      dismissed: db.offices.dismissed.includes(c.id),
      people: db.offices.entries.filter(e => e.officeId === c.id).map(okey),
    })),
    presets: offices().PRESET_OFFICES,
  };
}

// Officials read from a board's own site (see civic-boards.js) replace that board's earlier entries. A person you removed stays removed.
function setBoardOfficials(boardId, entries) {
  if (!db.profile) return;
  const gone = new Set(db.offices.dismissedKeys || []);
  db.offices.entries = db.offices.entries.filter(e => e.boardId !== boardId)
    .concat((entries || []).map(e => ({ ...e, boardId, source: 'board', level: 'local', asOf: today() })).filter(e => !gone.has(okey(e))));
  syncOffices();
}
function dropBoardOfficials(boardId) {
  if (!db.profile) return;
  db.offices.entries = db.offices.entries.filter(e => e.boardId !== boardId);
  syncOffices();
}

function syncOffices() {
  if (!db.profile) return;
  db.profile.officials = db.profile.officials.filter(o => !OFFICE_SOURCES.has(o.source)).concat(db.offices.entries);
  save();
}

async function discoverOffice(officeId) {
  if (!db.profile) throw new Error('Look up an address first.');
  const search = ctx.tavilySearch || require('./v2').tavilySearch;
  const llmJson = ctx.llmJson || require('./v2').ollamaJson;
  return offices().discover(db.profile, String(officeId || ''), { search, llmJson });
}

// people: [{name, role?, sourceUrl?, email?, phone?, website?}] confirmed by the person, or one hand-entered person.
function addOffices(input) {
  if (!db.profile) throw new Error('Look up an address first.');
  const cat = offices().catalogFor(db.profile);
  const list = Array.isArray(input.people) && input.people.length ? input.people : [input];
  if (list.length > 25) throw new Error('That is more people than one office should have.');
  const made = list.map(x => offices().cleanEntry({ ...x, officeId: input.officeId || x.officeId, office: input.office || x.office, source: input.source || x.source, body: x.body || input.body }, cat));
  for (const e of made) {
    const k = okey(e);
    db.offices.entries = db.offices.entries.filter(x => okey(x) !== k);
    db.offices.entries.push({ ...e, asOf: today() });
    if (e.officeId) db.offices.dismissed = db.offices.dismissed.filter(id => id !== e.officeId);
  }
  syncOffices();
  return decorate(db.profile);
}

async function restoreOffice(id) {
  if (!db.profile) throw new Error('Look up an address first.');
  db.offices.dismissed = db.offices.dismissed.filter(x => x !== id);
  if (id === 'mayor') await autoMayor(db.profile, []);
  syncOffices();
  return decorate(db.profile);
}

function removeOffice(key) {
  const e = db.offices.entries.find(x => okey(x) === key);
  if (!e) throw new Error('That person is not one of your local offices.');
  db.offices.entries = db.offices.entries.filter(x => x !== e);
  // an automatic entry must not come back with the next refresh
  if (e.source === 'wikidata' && e.officeId && !db.offices.dismissed.includes(e.officeId)) db.offices.dismissed.push(e.officeId);
  if (e.source === 'board') { db.offices.dismissedKeys = (db.offices.dismissedKeys || []).concat(okey(e)).slice(-200); }
  delete db.social[key];
  syncOffices();
  return decorate(db.profile);
}

// ─── Social accounts ─────────────────────────────────────────────────────────

const SOCIAL = {
  instagram: { label: 'Instagram', re: /^[A-Za-z0-9._]{1,30}$/ },
  tiktok: { label: 'TikTok', re: /^[A-Za-z0-9._]{2,24}$/ },
  twitter: { label: 'X', re: /^[A-Za-z0-9_]{1,15}$/ },
  facebook: { label: 'Facebook', re: /^[A-Za-z0-9.\-]{3,80}$/ },
  youtube: { label: 'YouTube', re: /^[A-Za-z0-9._\-]{2,60}$/ },
  mastodon: { label: 'Mastodon', re: /^@?[A-Za-z0-9_]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/ },
};
const SOCIAL_ORDER = ['instagram', 'tiktok', 'twitter', 'facebook', 'youtube', 'mastodon'];
const SOCIAL_RESERVED = {
  instagram: ['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'tv', 'direct', 'about', 'web'],
  twitter: ['home', 'i', 'intent', 'share', 'search', 'hashtag', 'explore', 'login', 'settings', 'messages', 'notifications'],
  facebook: ['profile.php', 'pages', 'people', 'groups', 'watch', 'sharer', 'sharer.php', 'share.php', 'events', 'public', 'login', 'plugins', 'tr'],
  youtube: ['watch', 'results', 'feed', 'playlist', 'shorts', 'channel', 'user', 'c'],
};
const SOCIAL_URL = {
  instagram: /(?:^|\/\/)(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)/i,
  tiktok: /(?:^|\/\/)(?:www\.|vm\.)?tiktok\.com\/@([A-Za-z0-9._]+)/i,
  twitter: /(?:^|\/\/)(?:www\.|mobile\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]+)/i,
  facebook: /(?:^|\/\/)(?:www\.|m\.)?facebook\.com\/(?:pg\/)?([A-Za-z0-9.\-]+)/i,
  youtube: /(?:^|\/\/)(?:www\.|m\.)?youtube\.com\/(?:@|channel\/|user\/|c\/)([A-Za-z0-9._\-]+)/i,
};

// An account address -> { platform, handle }, or null when it is not a profile address.
function socialFromUrl(url) {
  const s = String(url || '').trim();
  for (const p of Object.keys(SOCIAL_URL)) {
    const m = s.match(SOCIAL_URL[p]);
    if (!m) continue;
    const h = m[1];
    if ((SOCIAL_RESERVED[p] || []).includes(h.toLowerCase())) continue;
    if (SOCIAL[p].re.test(h)) return { platform: p, handle: h };
  }
  return null;
}
// A Mastodon profile address looks like https://some.instance/@name. Any site can use that shape (Medium does), so this is
// only read when the person said the account is on Mastodon.
function mastodonFromUrl(url) {
  const mm = String(url || '').trim().match(/^https?:\/\/([A-Za-z0-9.\-]+\.[A-Za-z]{2,})\/@([A-Za-z0-9_]+)\/?$/);
  return mm ? `@${mm[2]}@${mm[1]}` : '';
}
// What a person typed (a handle, an @handle or a profile address) -> a clean handle for that platform, or ''.
function normalizeHandle(platform, input) {
  let s = String(input == null ? '' : input).trim();
  if (!SOCIAL[platform] || !s) return '';
  if (/^https?:\/\//i.test(s) && platform === 'mastodon') return mastodonFromUrl(s);
  if (/^https?:\/\/|\.com\//i.test(s)) { const r = socialFromUrl(/^https?:\/\//i.test(s) ? s : 'https://' + s); return r && r.platform === platform ? r.handle : ''; }
  if (platform !== 'mastodon') s = s.replace(/^@/, '');
  else if (!s.startsWith('@')) s = '@' + s;
  return SOCIAL[platform].re.test(s) ? s : '';
}
function socialUrl(platform, handle, youtubeId) {
  switch (platform) {
    case 'instagram': return `https://www.instagram.com/${handle}/`;
    case 'tiktok': return `https://www.tiktok.com/@${handle}`;
    case 'twitter': return `https://x.com/${handle}`;
    case 'facebook': return `https://www.facebook.com/${handle}`;
    case 'youtube': return youtubeId ? `https://www.youtube.com/channel/${youtubeId}` : /^UC[\w-]{22}$/.test(handle) ? `https://www.youtube.com/channel/${handle}` : `https://www.youtube.com/@${handle}`;
    case 'mastodon': { const m = handle.replace(/^@/, '').split('@'); return `https://${m[1]}/@${m[0]}`; }
    default: return '';
  }
}

// One entry of the legislators-social-media dataset -> { instagram, twitter, facebook, youtube, youtubeId, mastodon }.
function datasetSocial(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const p of ['instagram', 'twitter', 'facebook', 'youtube']) { const h = normalizeHandle(p, raw[p]); if (h) out[p] = h; }
  if (raw.youtube_id && /^UC[\w-]{22}$/.test(raw.youtube_id)) { out.youtubeId = raw.youtube_id; if (!out.youtube) out.youtube = raw.youtube_id; }
  const m = normalizeHandle('mastodon', raw.mastodon);
  if (m) out.mastodon = m;
  return out;
}

async function socialRoster() {
  let map = cacheGet('congress-social.json', DAY);
  if (map) return map;
  const rows = await getJson(CONGRESS_SOCIAL, { timeout: 25000 });
  map = {};
  for (const r of rows) { const b = r.id && r.id.bioguide; if (b && r.social) map[b] = r.social; }
  cacheSet('congress-social.json', map);
  return map;
}

const okey = o => `${o.level}|${o.office}|${o.name}`;
const findOfficial = key => ((db.profile && db.profile.officials) || []).find(o => okey(o) === key) || null;

// Every account for an official: what the datasets list, with anything added by hand taking precedence.
function accountsOf(o) {
  const data = o.socialData || {}, ov = db.social[okey(o)] || {};
  const out = [];
  for (const p of SOCIAL_ORDER) {
    const manual = ov[p], handle = manual ? manual.handle : data[p];
    if (!handle) continue;
    out.push({ platform: p, label: SOCIAL[p].label, handle, url: socialUrl(p, handle, !manual && p === 'youtube' ? data.youtubeId : ''), source: manual ? manual.source : 'dataset' });
  }
  return out;
}
const decorate = p => p ? { ...p, officials: p.officials.map(o => ({ ...o, social: accountsOf(o) })), offices: officesView(p) } : p;

function setSocial(key, platform, input, source = 'manual') {
  const o = findOfficial(key);
  if (!o) throw new Error('That official is not in your profile.');
  if (!SOCIAL[platform]) throw new Error('Unknown platform.');
  const handle = normalizeHandle(platform, input);
  if (!handle) throw new Error(`That does not look like a valid ${SOCIAL[platform].label} account. Paste the handle or the profile address.`);
  db.social[key] = { ...(db.social[key] || {}), [platform]: { handle, source: source === 'search' ? 'search' : 'manual', at: new Date().toISOString() } };
  save();
  return decorate(db.profile);
}
function removeSocial(key, platform) {
  if (db.social[key]) {
    delete db.social[key][platform];
    if (!Object.keys(db.social[key]).length) delete db.social[key];
    save();
  }
  return decorate(db.profile);
}

// Opt-in web search for accounts the datasets do not have. Costs one Tavily credit per platform; nothing is saved until the
// person confirms a match.
const SEARCH_DOMAINS = { tiktok: ['tiktok.com'], instagram: ['instagram.com'], twitter: ['x.com', 'twitter.com'], facebook: ['facebook.com'], youtube: ['youtube.com'] };
async function discoverSocial(key, platforms) {
  const o = findOfficial(key);
  if (!o) throw new Error('That official is not in your profile.');
  const have = new Set(accountsOf(o).map(a => a.platform));
  const want = (Array.isArray(platforms) && platforms.length ? platforms : ['tiktok', 'instagram']).filter(p => SEARCH_DOMAINS[p] && !have.has(p));
  if (!want.length) return { candidates: [], searched: [], credits: 0, note: 'Nothing to look for: those accounts are already on file.' };
  const search = ctx.tavilySearch || require('./v2').tavilySearch;
  const stateName = (db.profile.jurisdictions.state || {}).name || '';
  const parts = o.name.split(/\s+/).filter(Boolean).map(w => w.toLowerCase().replace(/[^a-z]/g, '')).filter(Boolean);
  const last = parts[parts.length - 1] || '', first = parts[0] || '';
  const role = o.office.replace(/^D\.C\. /, '');
  // A handle that contains the person's name is far more likely to be their own account than one that only talks about them.
  const handleMatches = h => { const x = h.toLowerCase().replace(/[^a-z]/g, ''); return !!x && ((last.length >= 4 && x.includes(last)) || (first.length >= 4 && last.length >= 3 && x.includes(first) && x.includes(last.slice(0, 3)))); };
  const candidates = [];
  for (const platform of want) {
    const res = await search({ query: `"${o.name}" ${role} ${stateName}`.trim(), maxResults: 8, includeDomains: SEARCH_DOMAINS[platform] });
    const by = new Map();
    for (const r of (res && res.results) || []) {
      const s = socialFromUrl(r.url);
      if (!s || s.platform !== platform) continue;
      const k = s.handle.toLowerCase(), text = `${r.title || ''} ${r.content || ''} ${s.handle}`.toLowerCase();
      const e = by.get(k) || { platform, label: SOCIAL[platform].label, handle: s.handle, url: socialUrl(platform, s.handle), title: r.title || '', snippet: String(r.content || '').replace(/\s+/g, ' ').slice(0, 160), handleMatch: handleMatches(s.handle), nameMatch: false, hits: 0 };
      e.hits++;
      if (last && text.includes(last)) e.nameMatch = true;
      if (!e.title && r.title) e.title = r.title;
      by.set(k, e);
    }
    candidates.push(...[...by.values()].sort((a, b) => (b.handleMatch - a.handleMatch) || (b.nameMatch - a.nameMatch) || (b.hits - a.hits)).slice(0, 3));
  }
  return { candidates, searched: want, credits: want.length };
}

// ─── Recent posts (YouTube and Mastodon publish free public feeds) ───────────

const feedCache = new Map();
async function feedItems(url) {
  const hit = feedCache.get(url);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.items;
  const r = await get(url, { timeout: 12000, headers: { Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml, */*' } });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const items = require('./feeds').parseFeed(r.body).items || [];
  feedCache.set(url, { at: Date.now(), items });
  return items;
}

async function youtubeChannelId(handle, knownId) {
  if (knownId && /^UC[\w-]{22}$/.test(knownId)) return knownId;
  if (/^UC[\w-]{22}$/.test(handle)) return handle;
  const map = cacheGet('youtube-channels.json', 90 * DAY) || {};
  if (map[handle]) return map[handle];
  const r = await get(`https://www.youtube.com/@${encodeURIComponent(handle)}`, { timeout: 12000, headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
  const m = r.body.match(/"channelId":"(UC[\w-]{22})"/) || r.body.match(/channel\/(UC[\w-]{22})/);
  if (!m) throw new Error('could not find that YouTube channel');
  map[handle] = m[1];
  cacheSet('youtube-channels.json', map);
  return m[1];
}

async function postsFor(key) {
  const o = findOfficial(key);
  if (!o) throw new Error('That official is not in your profile.');
  const acc = accountsOf(o), items = [], notes = [];
  const yt = acc.find(a => a.platform === 'youtube');
  if (yt) {
    try {
      const id = await youtubeChannelId(yt.handle, yt.source === 'dataset' ? (o.socialData || {}).youtubeId : '');
      for (const it of (await feedItems(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`)).slice(0, 6)) {
        const v = ((it.url.match(/[?&]v=([\w-]{11})/) || it.url.match(/\/shorts\/([\w-]{11})/)) || [])[1];
        items.push({ platform: 'youtube', title: it.title, url: it.url, date: it.date, thumb: v ? `https://i.ytimg.com/vi/${v}/mqdefault.jpg` : '' });
      }
    } catch (e) { notes.push(`YouTube: ${e.message}`); }
  }
  const ma = acc.find(a => a.platform === 'mastodon');
  if (ma) {
    try {
      const [user, host] = ma.handle.replace(/^@/, '').split('@');
      for (const it of (await feedItems(`https://${host}/@${user}.rss`)).slice(0, 6)) items.push({ platform: 'mastodon', title: it.summary || it.title, url: it.url, date: it.date, thumb: '' });
    } catch (e) { notes.push(`Mastodon: ${e.message}`); }
  }
  items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return { items, notes, has: { youtube: !!yt, mastodon: !!ma } };
}

// ─── Wikipedia: a short bio, a link, and a fallback photo ────────────────────

const WIKI = 'https://en.wikipedia.org';
const POLITICS = /politician|legislator|senator|representative|congress|governor|mayor|council|assembly|member of|lawmaker|commissioner|state house|state senate|sheriff|judge|county executive|school board|board of education|prosecutor/i;

// Does a Wikipedia summary clearly describe this official, and not a namesake? (Pure, so it can be tested.)
function wikiMatches(o, s, stateName, placeName) {
  if (!s || s.type === 'disambiguation') return false;
  const title = String(s.title || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z ]/g, ' ');
  const parts = String(o.name || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  const last = parts[parts.length - 1] || '', first = parts[0] || '';
  if (!last || !title.includes(last)) return false;
  if (first.length > 2 && !title.includes(first) && !title.includes(first.slice(0, 3))) return false;   // allows Jon / Jonathan
  const text = `${s.description || ''} ${s.extract || ''}`;
  if (!POLITICS.test(text)) return false;
  const hay = text.toLowerCase(), places = [stateName, placeName].filter(Boolean).map(x => x.toLowerCase());
  return !places.length || places.some(x => hay.includes(x)) || (o.level === 'federal' && /united states|u\.s\./i.test(text));
}

const wikiSummary = title => getJson(`${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(String(title).replace(/ /g, '_'))}?redirect=true`, { timeout: 12000 });
const clipText = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };

// { found, title, description, extract, url, thumb }. Members of Congress carry their exact Wikipedia title in the dataset;
// everyone else is searched for, and only a clear match is accepted.
async function aboutFor(key) {
  const o = findOfficial(key);
  if (!o) throw new Error('That official is not in your profile.');
  const name = `about-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}.json`;
  const cached = cacheGet(name, 30 * DAY);
  if (cached) return cached;
  const j = db.profile.jurisdictions, stateName = j.state && j.state.name, placeName = j.place && j.place.name;
  let summary = null;
  if (o.wikipedia) { try { summary = await wikiSummary(o.wikipedia); } catch { /* fall back to a search */ } }
  if (!summary) {
    const q = `${o.name} ${stateName || ''} politician`.trim();
    const res = await getJson(`${WIKI}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=5&format=json`, { timeout: 12000 });
    for (const hit of (res.query && res.query.search) || []) {
      try { const s = await wikiSummary(hit.title); if (wikiMatches(o, s, stateName, placeName)) { summary = s; break; } } catch { /* next hit */ }
    }
  }
  const out = summary ? {
    found: true, title: summary.title, description: summary.description || '', extract: clipText(summary.extract, 420),
    url: (summary.content_urls && summary.content_urls.desktop && summary.content_urls.desktop.page) || `${WIKI}/wiki/${encodeURIComponent(String(summary.title).replace(/ /g, '_'))}`,
    thumb: (summary.thumbnail && summary.thumbnail.source) || '',
  } : { found: false };
  cacheSet(name, out);
  return out;
}

// ─── Photos (fetched by Lateral's server and cached, so the browser never contacts a third-party host) ───

// Only public https addresses are fetched: never an address on this computer or network.
function safeHttpsUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:') return null;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(h) || /\.(local|internal|lan|home)$/.test(h) || !h.includes('.')) return null;
    return x.href;
  } catch { return null; }
}
async function tryImage(u) {
  try {
    const r = await getBuf(u);
    if (r.status === 200 && /^image\//i.test(r.type) && r.buf.length > 800) return { type: r.type.split(';')[0], buf: r.buf };
  } catch { /* try the next source */ }
  return null;
}
// Order: the Congress portrait sets, the legislature's own headshot, then Wikipedia. Null when there is none.
async function photoFor(key) {
  const o = findOfficial(key);
  if (!o) return null;
  const id = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16), dir = path.join(CACHE_DIR, 'photos');
  const imgFile = path.join(dir, id + '.img'), metaFile = path.join(dir, id + '.json');
  try {
    const m = JSON.parse(fs.readFileSync(metaFile, 'utf8')), age = Date.now() - m.at;
    if (m.none ? age < DAY : age < 30 * DAY) return m.none ? null : { type: m.type, buf: fs.readFileSync(imgFile) };
  } catch { /* not cached yet */ }
  const urls = [];
  if (o.bioguide) urls.push(`https://unitedstates.github.io/images/congress/450x550/${o.bioguide}.jpg`, `https://bioguide.congress.gov/bioguide/photo/${o.bioguide[0]}/${o.bioguide}.jpg`);
  if (o.image) { const s = safeHttpsUrl(o.image); if (s) urls.push(s); }
  let found = null;
  for (const u of urls) { found = await tryImage(u); if (found) break; }
  if (!found) { try { const a = await aboutFor(key); const s = a.found && a.thumb && safeHttpsUrl(a.thumb); if (s) found = await tryImage(s); } catch { /* no Wikipedia photo */ } }
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (found) { fs.writeFileSync(imgFile, found.buf); fs.writeFileSync(metaFile, JSON.stringify({ at: Date.now(), type: found.type })); }
    else fs.writeFileSync(metaFile, JSON.stringify({ at: Date.now(), none: true }));
  } catch { /* the cache is optional */ }
  return found;
}

// ─── District shapes for the map ─────────────────────────────────────────────

// Planar area of a GeoJSON Polygon / MultiPolygon in square degrees (holes subtract). Only for comparing two outlines.
function ringArea(r) { let a = 0; for (let i = 0, n = r.length; i < n; i++) { const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % n]; a += x1 * y2 - x2 * y1; } return Math.abs(a / 2); }
function areaOf(g) {
  if (!g) return 0;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.reduce((s, p) => s + p.reduce((t, ring, i) => t + (i === 0 ? 1 : -1) * ringArea(ring), 0), 0);
}
function boundsOf(g) {
  const pts = !g ? [] : (g.type === 'Polygon' ? g.coordinates.flat() : g.type === 'MultiPolygon' ? g.coordinates.flat(2) : []);
  if (!pts.length) return null;
  return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
}
// Do two outlines of "the same district" differ materially? (a different map, not just different simplification)
function outlinesDiffer(a, b) {
  const A = areaOf(a), B = areaOf(b);
  if (!A || !B) return false;
  if (Math.abs(A - B) / Math.max(A, B) > 0.005) return true;
  const ba = boundsOf(a), bb = boundsOf(b);
  return !!(ba && bb && ba.some((v, i) => Math.abs(v - bb[i]) > 0.005));
}

async function shapeFor(service, layerId, geoid, offsets) {
  const cacheName = `shape-${service}-${layerId}-${geoid}.json`;
  const cached = cacheGet(cacheName, 30 * DAY);
  if (cached) return cached;
  let geometry = null;
  for (let i = 0; i < offsets.length; i++) {
    const url = `${TIGERWEB}/${service}/MapServer/${layerId}/query?where=${encodeURIComponent(`GEOID='${geoid}'`)}&outFields=GEOID,NAME&returnGeometry=true&outSR=4326&maxAllowableOffset=${offsets[i]}&f=geojson`;
    const r = await get(url, { timeout: 25000 });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const f = (JSON.parse(r.body).features || [])[0];
    if (!f || !f.geometry) throw new Error('no outline for that district');
    geometry = f.geometry;
    if (r.body.length <= 40 * 1024) break;
  }
  cacheSet(cacheName, geometry);
  return geometry;
}

async function shapes() {
  if (!db.profile) throw new Error('No Civic profile yet.');
  const j = db.profile.jurisdictions, L = await resolveLayers();
  const school = (j.schoolDistricts || [])[0];
  const schoolLayer = school && (L.school.find(s => s.type === school.type) || {}).id;
  const fine = [0.0005, 0.002, 0.006];
  const defs = [
    ['state', j.state && `${j.state.name}`, 'State_County', L.state, j.state && j.state.geoid, [0.01, 0.03]],
    ['school', school && school.name, 'School', schoolLayer, school && school.geoid, fine],
    ['place', j.place && j.place.name, 'Places_CouSub_ConCity_SubMCD', j.place && (j.place.kind === 'cdp' ? L.cdp : L.incorporated), j.place && j.place.geoid, fine],
    ['stateSenate', j.stateSenate && j.stateSenate.name, 'Legislative', L.upper, j.stateSenate && j.stateSenate.geoid, fine],
    ['stateHouse', j.stateHouse && j.stateHouse.name, 'Legislative', L.lower, j.stateHouse && j.stateHouse.geoid, fine],
    ['congress', j.congress && `${j.congress.name} (${ord(j.congress.session)} Congress)`, 'Legislative', L.congress, j.congress && j.congress.geoid, fine],
    ['congressNext', j.congressNext && `${j.congressNext.name} (${ord(j.congressNext.session)} Congress, new map)`, 'Legislative', L.congressNext, j.congressNext && j.congressNext.geoid, fine],
  ].filter(d => d[1] && d[3] !== null && d[3] !== undefined && d[4]);
  const layers = (await Promise.all(defs.map(async ([id, label, service, layerId, geoid, offsets]) => {
    try { return { id, label, geoid, geometry: await shapeFor(service, layerId, geoid, offsets) }; } catch { return null; }
  }))).filter(Boolean);
  const cur = layers.find(l => l.id === 'congress'), next = layers.find(l => l.id === 'congressNext');
  return { layers, boundaryChange: !!(cur && next && outlinesDiffer(cur.geometry, next.geometry)) };
}

function keysInfo() {
  // Everything above is keyless. These optional keys only unlock more detail in later Civic features.
  return { required: [], optional: [{ id: 'congress', label: 'Congress.gov key', unlocks: 'bill and vote detail without the shared demo rate limit' }, { id: 'openstates', label: 'Open States key', unlocks: 'state bill and vote detail' }] };
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

// Returns false when the path is not a civic route.
async function route(req, reqUrl, res, send) {
  const p = reqUrl.pathname.replace(/^\/api\/lateral/, '');
  if (!p.startsWith('/civic/')) return false;
  const sub = p.slice('/civic/'.length);
  if (sub === 'watch' || sub.startsWith('watch/')) return require('./civic-watch').route(req, reqUrl, res, send);
  if (sub === 'track' || sub.startsWith('track/')) return require('./civic-track').route(req, reqUrl, res, send);
  if (sub === 'boards' || sub.startsWith('boards/')) return require('./civic-boards').route(req, reqUrl, res, send);
  if (req.method === 'GET') {
    try {
      // A profile saved by an older version lacks newer details (such as social accounts): rebuild it from the stored district
      // identifiers. No address is needed for that.
      if (sub === 'profile' && db.profile && (db.profile.version || 1) < 3) { try { await refresh(); } catch { /* show what is stored */ } }
      if (sub === 'profile') return send(res, 200, { profile: decorate(db.profile), keys: keysInfo() });
      if (sub === 'shapes') return send(res, 200, await shapes());
      if (sub === 'posts') return send(res, 200, await postsFor(String(reqUrl.searchParams.get('key') || '')));
      if (sub === 'about') return send(res, 200, await aboutFor(String(reqUrl.searchParams.get('key') || '')));
      if (sub === 'photo') {
        const ph = await photoFor(String(reqUrl.searchParams.get('key') || ''));
        if (!ph) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('No photo'); }
        res.writeHead(200, { 'Content-Type': ph.type, 'Cache-Control': 'private, max-age=86400' });
        return res.end(ph.buf);
      }
    } catch (e) { return send(res, 200, { error: e.message }); }
  }
  if (req.method === 'POST') {
    const body = await readBody(req);
    try {
      if (sub === 'lookup') return send(res, 200, { profile: decorate(await lookup(body.address)) });
      if (sub === 'legistar') return send(res, 200, { profile: decorate(await setLegistar(body.url || body.slug)) });
      if (sub === 'refresh') return send(res, 200, { profile: decorate(await refresh()) });
      if (sub === 'remove') { remove(); return send(res, 200, { profile: null }); }
      if (sub === 'office/discover') return send(res, 200, await discoverOffice(body.officeId));
      if (sub === 'office/add') return send(res, 200, { profile: addOffices(body) });
      if (sub === 'office/restore') return send(res, 200, { profile: await restoreOffice(String(body.officeId || '')) });
      if (sub === 'office/remove') return send(res, 200, { profile: removeOffice(String(body.key || '')) });
      if (sub === 'social/set') return send(res, 200, { profile: setSocial(String(body.key || ''), String(body.platform || ''), body.handle, body.source) });
      if (sub === 'social/remove') return send(res, 200, { profile: removeSocial(String(body.key || ''), String(body.platform || '')) });
      if (sub === 'social/discover') return send(res, 200, await discoverSocial(String(body.key || ''), body.platforms));
    } catch (e) { return send(res, 200, { error: e.message }); }
  }
  return send(res, 404, { error: 'Unknown civic route.' });
}

module.exports = {
  route, lookup, refresh, setLegistar, remove, profile: () => decorate(db.profile), getJson, get, setBoardOfficials, dropBoardOfficials,
  init: c => { ctx = { ...ctx, ...(c || {}) }; },
  // exported for tests
  parseYaml, personRecord, stateOfficials, federalOfficials, legistarCandidates, legistarSlugFromUrl, normalizeAddress,
  congressNumber, ord, sameDistrict, legistarOfficials, legistarProbe, SCHOOL_BODY, cleanPlace, slugify, electionYearOf, validDay,
  socialFromUrl, normalizeHandle, socialUrl, datasetSocial, accountsOf, setSocial, removeSocial, discoverSocial, okey,
  areaOf, outlinesDiffer, wikiMatches, safeHttpsUrl, aboutFor, photoFor, addOffices, removeOffice, restoreOffice, discoverOffice, officesView, autoMayor, _setProfileForTest: p => { db.profile = p; db.social = {}; db.offices = noOffices(); },
};
