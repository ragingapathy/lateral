'use strict';
// The city calendar, step 2: local events from sources you point it at, events you create, and finding city calendars for you.
//
// Lateral reads only what an organisation publishes for exactly this purpose, so a source is one of:
//   ics      an iCalendar feed (.ics / webcal): most city, county, library, parks and school calendars, Google Calendar's public
//            address, CivicPlus and LibCal "subscribe" links
//   jsonld   a public events page whose events are marked up for search engines (schema.org Event in the page)
//   tribe    a WordPress site running The Events Calendar, through its public REST API
// Nothing is scraped from a platform that forbids it (some event hubs do: they are deliberately not supported).
//
// Finding calendars: paste any address and Lateral looks for a feed on that page; or press Find to look through your government
// websites (city, county, schools, state) for feeds. Nothing is added until you tick it.
//
// Your own events live in data/calendar-sources.json beside the sources, with the same recurrence rules imported feeds use.
//
//   GET  calendar/sources/list            { sources, tz, found, foundAt }
//   POST calendar/sources/detect {input}  { candidates:[{kind,url,label,count,sample}] }  look at an address; nothing is added
//   POST calendar/sources/add {kind,url,label,category}
//   POST calendar/sources/remove {id}     POST calendar/sources/refresh {id?}
//   POST calendar/sources/discover        look through your government websites for feeds (a few quick page reads)
//   POST calendar/sources/dismiss {url}   stop suggesting one
//   POST calendar/event/save {...}        create or change one of your own events (optionally recurring)
//   POST calendar/event/remove {id}       POST calendar/event/skip {id,date}   drop one occurrence of a recurring event
//   POST calendar/config {tz}             the time zone every time is shown in

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ical = require('./ical');

const DATA_DIR = process.env.LATERAL_DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'calendar-sources.json');
const CACHE_FILE = path.join(DATA_DIR, 'calendar-cache.json');
const UA = 'Mozilla/5.0 (compatible; Lateral/2.5; +https://github.com/ragingapathy/lateral)';
const TTL = 6 * 3600 * 1000;
const MAX_SOURCES = 25, MAX_MANUAL = 500, MAX_BYTES = 6 * 1024 * 1024;
const CATEGORIES = { event: 'Community events', food: 'Food and drink', meeting: 'Government meetings' };

const civic = () => require('./civic');
let ctx = {};                                   // test hooks: fetchText, now, profile, media
const nowMs = () => (ctx.now ? ctx.now() : Date.now());
// Today in the city's own time zone (the server's clock is UTC, which is already tomorrow on a US evening).
function localToday(ms) { try { return ical.wallOf(ms, cityTz()).date; } catch { return new Date(ms).toISOString().slice(0, 10); } }
const todayStr = () => localToday(nowMs());
const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { s = clean(s); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(v + 'T12:00:00Z'));
const isTime = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const addDays = (day, n) => ical.addMinutes(day, '', n * 1440).date;

// ─── Storage ─────────────────────────────────────────────────────────────────

const STATE_ZONES = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York',
  DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York', MD: 'America/New_York',
  MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago',
  NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago',
  OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York', SD: 'America/Chicago',
  TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York',
  WI: 'America/Chicago', WY: 'America/Denver',
};

let db = (() => {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { tz: j.tz || '', sources: j.sources || [], dismissed: j.dismissed || [], manual: j.manual || [], found: j.found || null, foundAt: j.foundAt || '', placeKey: j.placeKey || '' }; }
  catch { return { tz: '', sources: [], dismissed: [], manual: [], found: null, foundAt: '', placeKey: '' }; }
})();
let cache = (() => { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}; } catch { return {}; } })();
const writeJson = (f, o) => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o)); fs.renameSync(tmp, f); } catch { /* next change */ } };
const save = () => writeJson(FILE, db);
const saveCache = () => writeJson(CACHE_FILE, cache);

function cityTz() {
  if (db.tz && ical.validZone(db.tz)) return db.tz;
  const prof = ctx.profile ? ctx.profile() : civic().profile();
  const abbr = prof && prof.jurisdictions && prof.jurisdictions.state && prof.jurisdictions.state.abbr;
  return STATE_ZONES[abbr] || 'America/New_York';
}
function setTz(tz) {
  const z = ical.validZone(String(tz || ''));
  if (!z) throw new Error('That is not a time zone Lateral knows. Use a name like America/Chicago.');
  db.tz = z; cache = {}; save(); saveCache();
  return z;
}

// ─── Fetching ────────────────────────────────────────────────────────────────

// Only public https addresses: never one on this computer or network. webcal:// and http:// are read as https://.
function normalizeUrl(input) {
  let s = clean(input);
  if (!s) return '';
  s = s.replace(/^webcals?:\/\//i, 'https://').replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  return civic().safeHttpsUrl(s) || '';
}
async function fetchText(url, { accept = 'text/calendar, text/html;q=0.9, application/json;q=0.8, */*;q=0.5', timeout = 20000 } = {}) {
  if (ctx.fetchText) return ctx.fetchText(url, { accept });
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  const finalUrl = civic().safeHttpsUrl(res.url || url);
  if (!finalUrl) throw new Error('That address redirected somewhere Lateral will not read.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('That file is too large.');
  return { status: res.status, type: String(res.headers.get('content-type') || ''), body: buf.toString('utf8'), url: finalUrl };
}

const decode = s => String(s || '').replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return m; } })
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return m; } })
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const stripTags = s => decode(String(s || '').replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// ─── Parsers: each returns events in ical.js's shape ─────────────────────────

function icsEvents(text) {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That is not a calendar file.');
  return ical.parseIcs(text, cityTz());
}

function asArray(v) { return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]; }
function walkLd(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  if (Array.isArray(node)) { node.forEach(n => walkLd(n, out, depth + 1)); return; }
  const types = asArray(node['@type']).map(String);
  if (types.some(t => /Event$/.test(t))) out.push(node);
  for (const k of ['@graph', 'itemListElement', 'item', 'subEvent', 'event', 'events', 'mainEntity']) if (node[k]) walkLd(node[k], out, depth + 1);
}
// An ISO date or date-time -> { date, time, dateOnly } in the city's wall clock. A time with a zone or offset is converted.
function isoWall(v, tz) {
  const s = clean(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { date: s, time: '', dateOnly: true };
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`, time = `${m[4]}:${m[5]}`;
  if (!m[6]) return { date, time, dateOnly: false };
  let ms;
  if (/^z$/i.test(m[6])) ms = ical.instantOf(date, time, 'UTC');
  else { const sign = m[6][0] === '-' ? -1 : 1, hh = Number(m[6].slice(1, 3)), mm = Number(m[6].slice(-2)); ms = ical.instantOf(date, time, 'UTC') - sign * (hh * 60 + mm) * 60000; }
  return { ...ical.wallOf(ms, tz), dateOnly: false };
}
function placeText(loc) {
  const l = asArray(loc)[0];
  if (!l) return '';
  if (typeof l === 'string') return clip(decode(l), 140);
  const a = l.address;
  const addr = typeof a === 'string' ? a : a ? [a.streetAddress, a.addressLocality].filter(Boolean).join(', ') : '';
  return clip(decode([l.name, addr].filter(Boolean).join(', ')), 140);
}
function jsonLdEvents(html, pageUrl) {
  const tz = cityTz(), found = [];
  for (const m of String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let j; try { j = JSON.parse(m[1].replace(/[\u0000-\u001f]+/g, ' ')); } catch { continue; }
    walkLd(j, found);
  }
  const out = [], seen = new Set();
  for (const n of found) {
    if (/cancel/i.test(String(n.eventStatus || ''))) continue;
    const s = isoWall(n.startDate, tz); if (!s) continue;
    const e = n.endDate ? isoWall(n.endDate, tz) : null;
    const title = clip(decode(clean(n.name)), 140); if (!title) continue;
    let url = ''; try { url = n.url ? new URL(String(n.url), pageUrl).href : ''; } catch { url = ''; }
    const ev = { uid: url || sha(title + s.date + s.time), title, detail: clip(stripTags(n.description), 400), location: placeText(n.location), url, allDay: s.dateOnly, start: { date: s.date, time: s.time }, durMin: 0, spanDays: 1, rule: null, exdates: [], rdates: [], recurrenceId: '' };
    if (e && s.dateOnly) ev.spanDays = Math.max(1, ical.toNum(e.date) - ical.toNum(s.date) + 1);
    else if (e && !s.dateOnly && !e.dateOnly) ev.durMin = Math.max(0, ical.minutesOf(e.date, e.time) - ical.minutesOf(s.date, s.time));
    const key = ev.uid + '|' + ev.start.date + ev.start.time;
    if (!seen.has(key)) { seen.add(key); out.push(ev); }
  }
  return out;
}

async function tribeEvents(origin) {
  const tz = cityTz(), out = [];
  let next = `${origin}/wp-json/tribe/events/v1/events?per_page=50&start_date=${addDays(todayStr(), -1)}`;
  for (let page = 0; page < 4 && next; page++) {
    const r = await fetchText(next, { accept: 'application/json' });
    let j; try { j = JSON.parse(r.body); } catch { throw new Error('That site does not publish an events API.'); }
    if (!Array.isArray(j.events)) throw new Error('That site does not publish an events API.');
    for (const e of j.events) {
      const utc = String(e.utc_start_date || ''), local = String(e.start_date || '');
      const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(utc) ? isoWall(utc.slice(0, 10) + 'T' + utc.slice(11, 16) + 'Z', tz) : isoWall(local.slice(0, 10) + (e.all_day ? '' : 'T' + local.slice(11, 16)), tz);
      if (!s) continue;
      const en = String(e.utc_end_date || '');
      const end = e.all_day ? null : (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(en) ? isoWall(en.slice(0, 10) + 'T' + en.slice(11, 16) + 'Z', tz) : null);
      const v = e.venue && !Array.isArray(e.venue) ? e.venue : null;
      out.push({ uid: String(e.id || e.url || e.title), title: clip(decode(e.title), 140), detail: clip(stripTags(e.description), 400), location: v ? clip(decode([v.venue, v.address, v.city].filter(Boolean).join(', ')), 140) : '', url: e.url || '', allDay: !!e.all_day || s.dateOnly, start: { date: s.date, time: e.all_day ? '' : s.time }, durMin: end && !e.all_day ? Math.max(0, ical.minutesOf(end.date, end.time) - ical.minutesOf(s.date, s.time)) : 0, spanDays: 1, rule: null, exdates: [], rdates: [], recurrenceId: '' });
    }
    next = j.next_rest_url && /^https:/.test(j.next_rest_url) ? j.next_rest_url : '';
  }
  return out;
}

// ─── Respecting publishers: robots.txt ───────────────────────────────────────
// Web pages (not feed addresses you paste, which exist to be subscribed to) are read only where the site's robots.txt allows it.

// Pure. The rules that apply to us: the group naming "lateral", else the "*" group. -> [{allow, pattern}]
function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (cur && (k === 'allow' || k === 'disallow')) cur.rules.push({ allow: k === 'allow', pattern: v });
  }
  const mine = groups.filter(g => g.agents.includes('lateral'));
  const pick = mine.length ? mine : groups.filter(g => g.agents.includes('*'));
  return pick.flatMap(g => g.rules);
}
// Pure. Longest matching pattern wins; Allow wins a tie. An empty Disallow allows everything.
function robotsAllows(rules, pathAndQuery) {
  let best = null;
  for (const r of rules) {
    if (!r.pattern) continue;
    const re = new RegExp('^' + r.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (!re.test(pathAndQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return !best || best.allow;
}
const robotsCache = new Map();
async function robotsOk(url) {
  if (ctx.noRobots) return true;
  let u; try { u = new URL(url); } catch { return false; }
  let ent = robotsCache.get(u.origin);
  if (!ent || nowMs() - ent.at > (ent.short ? 10 * 60000 : 24 * 3600000)) {
    try {
      const r = await fetchText(u.origin + '/robots.txt', { accept: 'text/plain, */*', timeout: 8000 });
      if (r.status >= 500) ent = { at: nowMs(), short: true, rules: [{ allow: false, pattern: '/' }] };        // unreachable robots.txt: assume closed, recheck soon
      else ent = { at: nowMs(), rules: r.status === 200 ? parseRobots(r.body) : [] };                          // none (4xx): everything is allowed
    } catch { ent = { at: nowMs(), short: true, rules: [{ allow: false, pattern: '/' }] }; }
    robotsCache.set(u.origin, ent);
  }
  return robotsAllows(ent.rules, u.pathname + u.search);
}
const ROBOTS_NOTE = 'That site\'s robots.txt asks automated tools not to read that page, so Lateral does not.';

// ─── Sources ─────────────────────────────────────────────────────────────────

const originOf = u => { try { return new URL(u).origin; } catch { return ''; } };

async function loadSource(src) {
  if (src.kind === 'ics') return icsEvents((await fetchText(src.url)).body);
  if (src.kind === 'tribe') return tribeEvents(originOf(src.url));
  if (src.kind === 'jsonld') { if (!(await robotsOk(src.url))) throw new Error(ROBOTS_NOTE); const r = await fetchText(src.url, { accept: 'text/html, */*' }); return jsonLdEvents(r.body, r.url || src.url); }
  throw new Error('Unknown source type.');
}
// The events of one source: cached for a few hours, and the last good copy is kept when the site is down.
async function eventsOf(src, { fresh = false } = {}) {
  const hit = cache[src.id];
  if (hit && !fresh && nowMs() - hit.at < TTL && hit.tz === cityTz()) return hit;
  try {
    const events = (await loadSource(src)).slice(0, 3000);
    cache[src.id] = { at: nowMs(), tz: cityTz(), events, error: '' };
  } catch (e) {
    // Keep the last good copy, show why it is stale, and try again in 15 minutes.
    cache[src.id] = { events: hit ? hit.events : [], tz: cityTz(), error: String(e.message || e).slice(0, 160), at: nowMs() - TTL + 15 * 60000 };
  }
  saveCache();
  return cache[src.id];
}

const KIND = { event: 'event', food: 'food', meeting: 'meeting' };

// Everything from your sources and your own events, as calendar events within [from, to].
async function eventsBetween(from, to) {
  const out = [], status = [];
  await Promise.all(db.sources.map(async src => {
    const c = await eventsOf(src);
    const occ = ical.expandAll(c.events || [], from, to);
    status.push({ id: 'src:' + src.id, name: src.label, ok: !c.error, error: c.error || undefined, count: occ.length });
    for (const o of occ) out.push({ id: `src:${src.id}:${sha(o.uid + o.title)}:${o.date}${o.time || ''}`, date: o.date, endDate: o.endDate, time: o.time || '', endTime: o.endTime || '', title: clip(o.title, 140), kind: KIND[src.category] || 'event', group: src.label, url: o.url || '', location: o.location || '', detail: clip(o.detail, 300) });
  }));
  for (const m of db.manual) {
    const ev = manualToEvent(m);
    for (const o of ical.occurrences(ev, from, to)) {
      out.push({ id: `mine:${m.id}:${o.date}`, date: o.date, endDate: o.endDate, time: o.time || '', endTime: o.endTime || '', title: m.title, kind: m.kind || 'mine', group: 'My events', url: m.url || '', location: m.location || '', detail: m.detail || '', eventId: m.id, recurring: !!m.recur, editable: true });
    }
  }
  // The same event listed by two sources shows once.
  const seen = new Set();
  const deduped = out.filter(e => { const k = [e.date, e.time, e.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()].join('|'); if (seen.has(k)) return false; seen.add(k); return true; });
  return { events: deduped, sources: status.sort((a, b) => a.name.localeCompare(b.name)) };
}

function manualToEvent(m) {
  const allDay = !m.time;
  let spanDays = 1, durMin = 0;
  if (m.endDate && m.endDate >= m.date) {
    if (allDay) spanDays = ical.toNum(m.endDate) - ical.toNum(m.date) + 1;
    else durMin = Math.max(0, ical.minutesOf(m.endDate, m.endTime || m.time) - ical.minutesOf(m.date, m.time));
  } else if (!allDay && m.endTime) durMin = Math.max(0, ical.minutesOf(m.date, m.endTime) - ical.minutesOf(m.date, m.time));
  return { start: { date: m.date, time: m.time || '' }, allDay, spanDays, durMin, rule: m.recur ? { ...m.recur, interval: m.recur.interval || 1 } : null, exdates: m.exdates || [], rdates: [] };
}

// ─── Finding feeds ───────────────────────────────────────────────────────────

const abs = (href, base) => { try { return new URL(decode(href), base).href; } catch { return ''; } };
// Calendar addresses a page points at: <link rel=alternate type=text/calendar>, .ics / webcal / iCalendar links, Google Calendar embeds.
function feedLinks(html, pageUrl) {
  const out = new Set();
  for (const m of String(html).matchAll(/<link[^>]+type=["']text\/calendar["'][^>]*>/gi)) { const h = (m[0].match(/href=["']([^"']+)["']/i) || [])[1]; if (h) out.add(abs(h, pageUrl)); }
  for (const m of String(html).matchAll(/href=["']([^"']+)["']/gi)) {
    const h = decode(m[1]);
    if (/^webcals?:/i.test(h) || /\.ics(\?|#|$)/i.test(h) || /icalendar\.aspx|[?&]ical=|\/ical\/|export\.ics|calendar\/export/i.test(h)) out.add(abs(h.replace(/^webcals?:\/\//i, 'https://'), pageUrl));
  }
  for (const m of String(html).matchAll(/calendar\.google\.com\/calendar\/(?:u\/\d+\/)?(?:embed|ical)[^"'<>\s]*/gi)) {
    const src = (decode(m[0]).match(/[?&]src=([^&"']+)/i) || decode(m[0]).match(/\/ical\/([^/]+)\//i) || [])[1];
    if (src) out.add(`https://calendar.google.com/calendar/ical/${encodeURIComponent(decodeURIComponent(src))}/public/basic.ics`);
  }
  return [...out].filter(u => civic().safeHttpsUrl(u)).slice(0, 8);
}
// The text of each link that points at a feed (CivicPlus lists one per department: "Auditor", "Board of Elections"), by address.
function feedLabels(html, pageUrl) {
  const out = {};
  for (const m of String(html).matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const u = abs(m[1].replace(/^webcals?:\/\//i, 'https://'), pageUrl), text = clean(stripTags(m[2]));
    if (u && text && text.length < 70 && !out[u]) out[u] = text;
  }
  return out;
}
const upcoming = events => { const from = todayStr(), to = addDays(from, 90); return ical.expandAll(events, from, to); };
const sampleOf = occ => occ.slice(0, 3).map(o => ({ date: o.date, time: o.time || '', title: clip(o.title, 70) }));

// A starting guess for what a calendar is, so the person only has to change it when it is wrong. Pure.
function guessCategory(label, sample) {
  const text = clean([label, ...(sample || []).map(x => x.title)].join(' '));
  if (/\b(meetings?|board|council|commission(ers)?|committee|hearing|agenda|trustees)\b/i.test(text)) return 'meeting';
  if (/\b(food|dining|restaurants?|brew\w*|wine|tasting|happy hour|specials?|menu)\b/i.test(text)) return 'food';
  return 'event';
}

// Check one address and report what it would give. Never throws: { candidate } or { error }.
async function verify(kind, url) {
  try {
    const events = await loadSource({ kind, url });
    const occ = upcoming(events);
    return { candidate: { kind, url, count: occ.length, total: events.length, sample: sampleOf(occ) } };
  } catch (e) { return { error: String(e.message || e).slice(0, 120) }; }
}
function pageLabel(html, fallback) {
  const t = clean(decode((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]));
  const parts = t.split(/\s[|•–—-]\s/).map(clean).filter(p => p && !/^(home|calendars?|icalendar|events?|civicengage|civicplus|subscribe)$/i.test(p));
  return clip(parts[0] || fallback, 70) || fallback;
}

// What a pasted or discovered address offers. `deep` also looks at the usual calendar pages of a site's front page.
async function candidatesFor(input, { deep = false } = {}) {
  const url = normalizeUrl(input);
  if (!url) throw new Error('That does not look like a public web address (https://…).');
  const out = [], seen = new Set();
  const add = (c, label) => { if (c && !seen.has(c.url)) { seen.add(c.url); const l = label || c.label; out.push({ ...c, label: l, category: guessCategory(l, c.sample) }); } };
  const host = new URL(url).hostname.replace(/^www\./, '');

  if (!/\.ics(\?|$)|icalendar|[?&]ical=|\/ical\//i.test(url) && !(await robotsOk(url))) throw new Error(ROBOTS_NOTE);
  let first;
  try { first = await fetchText(url); } catch (e) { throw new Error(`Could not read that address (${String(e.message || e).slice(0, 80)}).`); }
  if (first.status >= 400) {
    if ([403, 429, 503].includes(first.status) && /cloudflare|attention required|captcha|access denied|bot/i.test(String(first.body).slice(0, 6000))) {
      throw new Error('That site blocks automated readers (bot protection), so Lateral cannot read it, though your own browser can. Ask the organisation for a calendar (iCal) feed address, or add its events by hand.');
    }
    throw new Error(`That address answered HTTP ${first.status}.`);
  }
  if (/text\/calendar/i.test(first.type) || /^\s*BEGIN:VCALENDAR/i.test(first.body)) {
    const v = await verify('ics', first.url); if (v.error) throw new Error(v.error);
    add(v.candidate, host + ' calendar'); return out;
  }
  const pages = [{ url: first.url, html: first.body }];
  if (deep) {
    const origin = originOf(first.url);
    for (const p of ['/calendar', '/events', '/calendar/', '/events/', '/iCalendar.aspx', '/Calendar.aspx', '/calendars']) {
      if (pages.length >= 5) break;
      try { if (!(await robotsOk(origin + p))) continue; const r = await fetchText(origin + p, { accept: 'text/html, */*' }); if (r.status === 200 && /html/i.test(r.type || 'html') && r.url !== first.url) pages.push({ url: r.url, html: r.body }); } catch { /* no such page */ }
    }
  }
  for (const pg of pages) {
    const label = pageLabel(pg.html, host);
    const names = feedLabels(pg.html, pg.url), links = feedLinks(pg.html, pg.url).filter(l => !seen.has(l)).slice(0, 15);
    for (let i = 0; i < links.length; i += 5) {
      const got = await Promise.all(links.slice(i, i + 5).map(l => verify('ics', l)));
      got.forEach((v, k) => { if (v.candidate) { const nm = names[links[i + k]]; add(v.candidate, nm && !/subscribe|ical|^calendar$|download|add to|\.ics/i.test(nm) ?`${label}: ${nm}` : label + (out.length ? ' (' + (out.length + 1) + ')' : '')); } });
    }
    if (/wp-content|tribe-events|the-events-calendar/i.test(pg.html)) { const v = await verify('tribe', originOf(pg.url) + '/events/'); if (v.candidate) add({ ...v.candidate, url: originOf(pg.url) + '/events/' }, label + ' (events)'); }
    const ld = jsonLdEvents(pg.html, pg.url);
    if (ld.length) { const occ = upcoming(ld); add({ kind: 'jsonld', url: pg.url, count: occ.length, total: ld.length, sample: sampleOf(occ) }, label + ' (events page)'); }
  }
  if (!out.length) throw new Error('No calendar feed or event listing was found on that page. Look for a "Subscribe" or "iCal" link on the calendar page and paste that address.');
  return out;
}

// Look through your government websites for feeds. Quick, bounded, and nothing is added.
async function discover() {
  const prof = ctx.profile ? ctx.profile() : civic().profile();
  if (!prof) throw new Error('Look up your address in Civic first.');
  const media = ctx.media || require('./civic-media');
  let sites = [];
  try { const d = await media.list(prof); sites = ((d && d.groups && d.groups.gov) || []).map(x => ({ name: x.name, url: x.url })); } catch { /* none known */ }
  const have = new Set([...db.sources.map(s => s.url), ...db.dismissed]);
  const results = [];
  const queue = sites.slice(0, 8);
  const started = nowMs();
  const worker = async () => {
    while (queue.length && nowMs() - started < 60000) {
      const site = queue.shift();
      try {
        const cands = (await candidatesFor(site.url, { deep: true })).filter(c => !have.has(c.url) && c.total > 0);
        if (cands.length) results.push({ site, candidates: cands });
      } catch (e) { results.push({ site, candidates: [], note: String(e.message || e).slice(0, 100) }); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  db.found = results.sort((a, b) => a.site.name.localeCompare(b.site.name));
  db.foundAt = new Date(nowMs()).toISOString();
  save();
  return { found: db.found, foundAt: db.foundAt, checked: Math.min(sites.length, 8) };
}

// ─── Editing ─────────────────────────────────────────────────────────────────

function addSource(spec) {
  if (db.sources.length >= MAX_SOURCES) throw new Error(`That is as many calendars as Lateral keeps (${MAX_SOURCES}). Remove one first.`);
  const kind = ['ics', 'jsonld', 'tribe'].includes(spec.kind) ? spec.kind : '';
  const url = normalizeUrl(spec.url);
  if (!kind || !url) throw new Error('Choose one of the calendars that was found.');
  if (db.sources.some(s => s.url === url)) throw new Error('That calendar is already added.');
  const category = CATEGORIES[spec.category] ? spec.category : 'event';
  const src = { id: sha(url), kind, url, label: clip(spec.label, 60) || new URL(url).hostname, category, addedAt: new Date(nowMs()).toISOString() };
  db.sources.push(src);
  db.found = (db.found || []).map(g => ({ ...g, candidates: g.candidates.filter(c => c.url !== url) }));
  save();
  return src;
}
function updateSource(id, patch) {
  const s = db.sources.find(x => x.id === id);
  if (!s) throw new Error('That calendar was removed.');
  if (patch.category && CATEGORIES[patch.category]) s.category = patch.category;
  if (patch.label && clip(patch.label, 60)) s.label = clip(patch.label, 60);
  save();
  return s;
}
function removeSource(id) { db.sources = db.sources.filter(s => s.id !== id); delete cache[id]; save(); saveCache(); }

function cleanRecur(r, startDate) {
  if (!r || !r.freq) return null;
  const freq = String(r.freq).toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) throw new Error('Choose how often the event repeats.');
  const out = { freq, interval: Math.min(52, Math.max(1, parseInt(r.interval, 10) || 1)) };
  const days = asArray(r.byday).map(x => String(x).toUpperCase()).filter(x => /^[+-]?\d{0,1}(SU|MO|TU|WE|TH|FR|SA)$/.test(x));
  if (days.length) out.byday = days.slice(0, 7);
  const md = asArray(r.bymonthday).map(Number).filter(n => n && Math.abs(n) <= 31);
  if (md.length) out.bymonthday = md.slice(0, 5);
  if (r.until) { if (!isDay(r.until) || r.until < startDate) throw new Error('The repeat end date must be on or after the first day.'); out.until = r.until; }
  else if (r.count) out.count = Math.min(500, Math.max(1, parseInt(r.count, 10) || 1));
  if (freq === 'WEEKLY' && !out.byday) out.byday = [ical.WD[new Date(startDate + 'T12:00:00Z').getUTCDay()]];
  return out;
}
function saveEvent(b) {
  const title = clip(b.title, 120);
  if (!title) throw new Error('Give the event a title.');
  const date = clean(b.date);
  if (!isDay(date)) throw new Error('Choose the date.');
  const time = b.time ? clean(b.time) : '', endTime = b.endTime ? clean(b.endTime) : '', endDate = b.endDate ? clean(b.endDate) : '';
  if (time && !isTime(time)) throw new Error('The start time is not valid.');
  if (endTime && (!time || !isTime(endTime))) throw new Error('Set a start time before an end time.');
  if (endDate && (!isDay(endDate) || endDate < date)) throw new Error('The end date cannot be before the start.');
  if (!endDate && endTime && endTime < time) throw new Error('The end time is before the start. Set an end date for an overnight event.');
  let url = ''; if (b.url) { try { const u = new URL(/^https?:\/\//i.test(b.url) ? b.url : 'https://' + b.url); if (/^https?:$/.test(u.protocol)) url = u.href; } catch { throw new Error('That web address is not valid.'); } }
  const rec = { title, date, time, endDate, endTime, location: clip(b.location, 140), url, detail: clip(b.detail, 600), recur: cleanRecur(b.recur, date), kind: ['food', 'event'].includes(b.kind) ? b.kind : 'mine' };
  if (rec.recur && endDate && endDate > date && ical.toNum(endDate) - ical.toNum(date) > 30) throw new Error('A repeating event cannot span more than a month.');
  const existing = b.id ? db.manual.find(m => m.id === b.id) : null;
  if (existing) { const keep = rec.date === existing.date && JSON.stringify(rec.recur) === JSON.stringify(existing.recur) ? existing.exdates : []; Object.assign(existing, rec, { exdates: keep || [] }); save(); return existing; }
  if (db.manual.length >= MAX_MANUAL) throw new Error('That is as many events as Lateral keeps.');
  const ev = { id: crypto.randomBytes(5).toString('hex'), ...rec, exdates: [], createdAt: new Date(nowMs()).toISOString() };
  db.manual.push(ev); save();
  return ev;
}
function removeEvent(id) { const n = db.manual.length; db.manual = db.manual.filter(m => m.id !== id); if (db.manual.length === n) throw new Error('That event is already gone.'); save(); }
function skipOccurrence(id, date) {
  const m = db.manual.find(x => x.id === id);
  if (!m || !isDay(date)) throw new Error('That event is already gone.');
  if (!m.recur) { removeEvent(id); return; }
  m.exdates = [...new Set([...(m.exdates || []), date])]; save();
}
function dismiss(url) { const u = normalizeUrl(url); if (u && !db.dismissed.includes(u)) db.dismissed.push(u); db.found = (db.found || []).map(g => ({ ...g, candidates: g.candidates.filter(c => c.url !== u) })); save(); }

function listView() {
  return { sources: db.sources.map(s => { const c = cache[s.id] || {}; return { ...s, count: (c.events || []).length, error: c.error || '', checkedAt: c.at ? new Date(c.at).toISOString() : '' }; }), tz: cityTz(), tzSet: !!db.tz, found: db.found, foundAt: db.foundAt, mine: db.manual.length, categories: CATEGORIES };
}
function placeChanged(jurisdictions) {
  // A new place: the old sources and discoveries no longer apply (your own events stay).
  const key = JSON.stringify([jurisdictions && jurisdictions.state && jurisdictions.state.geoid, jurisdictions && jurisdictions.place && jurisdictions.place.geoid]);
  if (db.placeKey && db.placeKey !== key) { db.sources = []; db.found = null; db.foundAt = ''; db.dismissed = []; cache = {}; saveCache(); }
  db.placeKey = key; save();
}

// ─── Typing an event in plain words ──────────────────────────────────────────
// "2 for 1 al pastor tacos from Carnales Taqueria every Tuesday" -> a draft event you check and save. The local model only READS the
// sentence into fields (it is never asked to work out dates: small models get weekday arithmetic wrong); the dates are resolved here.

const NL_PROMPT = (text, today) => [
  'Read a short note about an event or a recurring special and fill in the fields below. Use ONLY what the note says. Leave a field blank when the note does not say. Do not calculate dates; copy what the note states.',
  `Today is ${today.weekday}, ${today.date}.`,
  '',
  'Fields (one per line, exactly these names):',
  'TITLE: short title without repeat words, venue first if there is one',
  'KIND: food (a food or drink special, a restaurant or bar event) | event (a community event) | personal (a personal reminder)',
  'PLACE: venue or address, if stated',
  'MONTH: 1-12 only if a calendar date is stated, else blank',
  'DAY: day of month only if stated',
  'YEAR: only if stated',
  'RELATIVE: today or tomorrow, only if the note says so',
  'WEEKDAY: MO TU WE TH FR SA SU, only for a single event on a named weekday ("this Friday")',
  'START: start time as 24-hour HH:MM, only if stated',
  'END: end time as 24-hour HH:MM, only if stated',
  'REPEAT: none | daily | weekly | monthly | yearly',
  'EVERY: 1, or 2 for "every other"',
  'DAYS: weekdays it repeats on, like TU or MO,WE,FR',
  'NTH: for "second Tuesday" use 2; for "last Friday" use -1; else blank',
  'MONTHDAY: day of month for "the 15th of every month", else blank',
  'UNTIL: end date as YYYY-MM-DD only if stated, else blank',
  'COUNT: number of times only if stated, else blank',
  'NOTES: price or special details worth keeping',
  '',
  'Example note: Trivia night at The Pub every Thursday 7 to 9pm',
  'TITLE: The Pub: trivia night\nKIND: event\nPLACE: The Pub\nMONTH:\nDAY:\nYEAR:\nRELATIVE:\nWEEKDAY:\nSTART: 19:00\nEND: 21:00\nREPEAT: weekly\nEVERY: 1\nDAYS: TH\nNTH:\nMONTHDAY:\nUNTIL:\nCOUNT:\nNOTES:',
  '',
  'Example note: farmers market on the first Saturday of the month, 8am to noon, Promenade Park',
  'TITLE: Farmers market\nKIND: event\nPLACE: Promenade Park\nMONTH:\nDAY:\nYEAR:\nRELATIVE:\nWEEKDAY:\nSTART: 08:00\nEND: 12:00\nREPEAT: monthly\nEVERY: 1\nDAYS: SA\nNTH: 1\nMONTHDAY:\nUNTIL:\nCOUNT:\nNOTES:',
  '',
  'Example note: block party October 24 at 2pm on Elm Street',
  'TITLE: Block party\nKIND: event\nPLACE: Elm Street\nMONTH: 10\nDAY: 24\nYEAR:\nRELATIVE:\nWEEKDAY:\nSTART: 14:00\nEND:\nREPEAT: none\nEVERY:\nDAYS:\nNTH:\nMONTHDAY:\nUNTIL:\nCOUNT:\nNOTES:',
  '',
  `Note: ${text}`,
].join('\n');

// "6pm", "6:30 PM", "18:00", "noon" -> "HH:MM" or ''. Pure.
function to24(v) {
  const s = clean(v).toLowerCase();
  if (!s) return '';
  if (s === 'noon') return '12:00';
  if (s === 'midnight') return '00:00';
  let m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?$/);
  if (m) { let h = Number(m[1]); const mi = Number(m[2] || 0); if (h < 1 || h > 12 || mi > 59) return ''; if (m[3] === 'p' && h !== 12) h += 12; if (m[3] === 'a' && h === 12) h = 0; return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`; }
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
  return '';
}
// KEY: value lines -> { KEY: value }. Pure.
function nlFields(text) {
  const out = {};
  for (const line of String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]{3,10})\s*:\s*(.*)$/);
    if (m && !(m[1] in out)) out[m[1]] = clean(m[2]);
  }
  return out;
}
const WDS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WD_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const wdOf = day => new Date(day + 'T12:00:00Z').getUTCDay();
const numOr = v => { const n = parseInt(String(v), 10); return Number.isFinite(n) ? n : null; };
const validYmd = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const ordinal = n => (n === -1 ? 'last' : ['', 'first', 'second', 'third', 'fourth', 'fifth'][n] || n + 'th');

// Checks the model's reading against the words that were actually typed. Small models sometimes do date arithmetic of their own,
// drop a day from "Mon-Fri" or start a series on its end date, so anything that can be read straight from the note is.
const DAY_WORDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];                 // same order as WDS
const MONTH_WORDS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const FOOD_WORDS = /\b(happy hour|specials?|half[- ]?price|2[- ]?for[- ]?1|two[- ]?for[- ]?one|bogo|brunch|tacos?|wings|pizza|burgers?|drinks?|beer|wine|cocktails?|dinner|lunch)\b/i;
const twoForOne = s => String(s).replace(/\b2\s*-?\s*for\s*-?\s*1\b/gi, '2-for-1');

// "Mon-Fri", "Tuesday through Thursday", "weekdays", "weekends" -> ['MO', ...], else []. Pure.
function daysFromText(tx) {
  const t = String(tx || '').toLowerCase();
  if (/\bweekdays?\b/.test(t)) return ['MO', 'TU', 'WE', 'TH', 'FR'];
  if (/\bweekends?\b/.test(t)) return ['SA', 'SU'];
  const name = '(sun|mon|tue|wed|thu|fri|sat)[a-z]*\\.?';
  const m = t.match(new RegExp('\\b' + name + '\\s*(?:-|\u2013|to|through|thru)\\s*' + name + '\\b'));
  if (!m) return [];
  const out = [];
  for (let i = DAY_WORDS.indexOf(m[1]), n = 0; n < 7; n++, i = (i + 1) % 7) { out.push(WDS[i]); if (DAY_WORDS[i] === m[2]) break; }
  return out;
}
// Does the note actually state this month and day? Pure.
function mentionsDate(tx, m, d) {
  const t = String(tx || '').toLowerCase(), mon = MONTH_WORDS[m - 1];
  if (!mon) return false;
  return new RegExp('\\b' + mon + '[a-z]*\\.?\\s*(?:the\\s*)?' + d + '\\b').test(t)
    || new RegExp('\\b' + d + '(?:st|nd|rd|th)?\\s*(?:of\\s*)?' + mon).test(t)
    || new RegExp('\\b0?' + m + '[/.-]0?' + d + '\\b').test(t);
}
const mentionsWeekday = (tx, wd) => new RegExp('\\b' + DAY_WORDS[wd]).test(String(tx || '').toLowerCase());
// "Nov 14-15" starting on Nov 14 -> '2026-11-15'. '' when the note has no such range. Pure.
function rangeEnd(tx, date) {
  const m = String(tx || '').toLowerCase().match(new RegExp('\\b(' + MONTH_WORDS.join('|') + ')[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|\u2013|to|through|thru)\\s*(\\d{1,2})\\b'));
  if (!m) return '';
  const [y, mo, da] = date.split('-').map(Number), d1 = Number(m[2]), d2 = Number(m[3]);
  if (MONTH_WORDS.indexOf(m[1]) + 1 !== mo || d1 !== da || d2 <= d1 || !validYmd(y, mo, d2)) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d2).padStart(2, '0')}`;
}

// Fields -> a draft event for the editor, with plain notes saying how each part was read. Pure given `today` ('YYYY-MM-DD').
function eventFromFields(f, today, text = '') {
  const tx = String(text || '');
  const notes = [];
  const title = twoForOne(clip(f.TITLE, 120));
  if (!title) throw new Error('I could not tell what the event is. Try describing it again.');
  let kind = /food|drink|special|restaurant/i.test(f.KIND || '') ? 'food' : /event|communit/i.test(f.KIND || '') ? 'event' : 'mine';
  if (kind !== 'mine' && FOOD_WORDS.test(tx)) kind = 'food';
  const time = to24(f.START), endTime0 = to24(f.END);
  const endTime = time && endTime0 && endTime0 > time ? endTime0 : '';
  if (endTime0 && !endTime) notes.push('The end time was left out because it is not after the start.');

  // weekday ranges and words ("Mon-Fri", "weekdays") are read from the note itself: small models drop days
  const textDays = daysFromText(tx);
  if (textDays.length && !/month|year/i.test(f.REPEAT || '')) f = { ...f, REPEAT: 'weekly', DAYS: textDays.join(',') };

  // repeat rule
  const rf = String(f.REPEAT || '').toLowerCase();
  const freq = /daily|day/.test(rf) ? 'DAILY' : /week/.test(rf) ? 'WEEKLY' : /month/.test(rf) ? 'MONTHLY' : /year|annual/.test(rf) ? 'YEARLY' : '';
  let rule = null;
  const days = String(f.DAYS || '').toUpperCase().split(/[^A-Z]+/).map(x => x.slice(0, 2)).filter(x => WDS.includes(x));
  if (freq) {
    rule = { freq, interval: Math.min(52, Math.max(1, numOr(f.EVERY) || 1)) };
    const nth = numOr(f.NTH), md = numOr(f.MONTHDAY);
    if (freq === 'WEEKLY' && days.length) rule.byday = [...new Set(days)];
    if (freq === 'DAILY' && days.length) rule.byday = [...new Set(days)];
    if (freq === 'MONTHLY') {
      if (days.length && nth && (nth === -1 || (nth >= 1 && nth <= 5))) rule.byday = [`${nth}${days[0]}`];
      else if (md && md >= 1 && md <= 31) rule.bymonthday = [md];
    }
    const cnt = numOr(f.COUNT); if (cnt && cnt > 0) rule.count = Math.min(500, cnt);
    if (/^\d{4}-\d{2}-\d{2}$/.test(f.UNTIL || '') && isDay(f.UNTIL)) { rule.until = f.UNTIL; delete rule.count; }
  }

  // the first day
  let date = '';
  if (/tomorrow/i.test(f.RELATIVE || '') && /tomorrow/i.test(tx || 'tomorrow')) date = addDays(today, 1);
  else if (/today|tonight/i.test(f.RELATIVE || '') && /today|tonight/i.test(tx || 'today')) date = today;
  let m = numOr(f.MONTH), d = numOr(f.DAY);
  const y = numOr(f.YEAR);
  if (tx && m && d && !mentionsDate(tx, m, d)) { m = null; d = null; }                                   // the model worked it out itself: not trusted
  if (rule && rule.until === `${String(y || today.slice(0, 4))}-${String(m || 0).padStart(2, '0')}-${String(d || 0).padStart(2, '0')}`) { m = null; d = null; }      // "through Dec 16" is the end, not the start
  if (!date && m && d && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
    const ty = Number(today.slice(0, 4));
    if (y && y >= ty && y <= ty + 5 && validYmd(y, m, d)) date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    else if (!y) {
      for (const yy of [ty, ty + 1]) { if (validYmd(yy, m, d)) { const c = `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; if (c >= today || rule) { date = c; break; } } }
    }
  }
  const wd0 = WDS.indexOf(String(f.WEEKDAY || '').toUpperCase().slice(0, 2));
  const wd = wd0 >= 0 && (!tx || mentionsWeekday(tx, wd0)) ? wd0 : -1;
  if (!date && wd >= 0 && !rule) { const diff = (wd - wdOf(today) + 7) % 7; date = addDays(today, diff); }
  if (!date && rule && (rule.byday || rule.bymonthday || rule.freq === 'DAILY')) {
    const first = ical.expandRule({ ...rule, count: undefined, until: undefined }, today, today, addDays(today, 400))[0];
    if (first) date = first;
  }
  // a series starts on its first real occurrence
  if (date && rule && (rule.freq === 'WEEKLY' || rule.freq === 'MONTHLY') && (rule.byday || rule.bymonthday)) {
    const first = ical.expandRule({ ...rule, count: undefined, until: undefined }, date, date, addDays(date, 400))[0];
    if (first && first !== date) date = first;
  }
  let recur = null;
  if (rule) {
    if (!date) notes.push('It repeats, but I could not tell when it starts: pick the first date.');
    else { try { recur = cleanRecur(rule, date); } catch { recur = null; notes.push('The repeat pattern was not valid, so it was left out.'); } }
  }
  if (!date) notes.push('I could not tell when this happens: pick a date.');
  else if (date < today && !recur) notes.push('That date has already passed.');

  let endDate = '';
  if (date && !recur) { const e = rangeEnd(tx, date); if (e) endDate = e; }
  let url = '';
  if (f.LINK) { try { const u = new URL(/^https?:\/\//i.test(f.LINK) ? f.LINK : 'https://' + f.LINK); if (/^https?:$/.test(u.protocol)) url = u.href; } catch { /* no link */ } }
  if (date) {
    const when = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
    notes.unshift(recur ? `Repeats ${describeRule(recur)}, starting ${when}.` : `On ${when}.`);
  }
  if (recur && !time) notes.push('No time was given, so it shows as an all-day event.');
  if (endDate) notes.push(`Runs until ${new Date(endDate + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' })}.`);
  return { title, kind, date, time, endTime, endDate, location: clip(f.PLACE, 140), url, detail: twoForOne(clip(f.NOTES, 600)), recur, notes };
}
function describeRule(r) {
  const every = r.interval > 1 ? `every ${r.interval} ` : 'every ';
  if (r.freq === 'DAILY') return r.interval > 1 ? `every ${r.interval} days` : 'every day';
  if (r.freq === 'YEARLY') return r.interval > 1 ? `every ${r.interval} years` : 'every year';
  if (r.freq === 'WEEKLY') {
    const dn = (r.byday || []).map(x => WD_NAMES[WDS.indexOf(x)]).join(', ');
    if (r.interval === 1) return 'every ' + (dn || 'week');
    return (r.interval === 2 ? 'every other week' : `every ${r.interval} weeks`) + (dn ? ' on ' + dn : '');
  }
  const b = (r.byday || [])[0];
  if (b) { const mm = b.match(/^(-?\d)([A-Z]{2})$/); if (mm) return `on the ${ordinal(Number(mm[1]))} ${WD_NAMES[WDS.indexOf(mm[2])]} of every ${r.interval > 1 ? r.interval + ' months' : 'month'}`; }
  return `on day ${(r.bymonthday || ['?'])[0]} of every ${r.interval > 1 ? r.interval + ' months' : 'month'}`;
}

async function parseNatural(text) {
  const t = clip(text, 400);
  if (t.length < 4) throw new Error('Describe the event in a sentence, such as "trivia at The Pub every Thursday 7pm".');
  const today = { date: todayStr(), weekday: WD_NAMES[wdOf(todayStr())] };
  const ask = ctx.ollamaText || require('./relevance').ollamaText;
  let out;
  try { out = await ask(NL_PROMPT(t, today), { timeoutMs: 60000, numPredict: 400 }); }
  catch { throw new Error('The local model is not answering, so I could not read that. Use + Add event to fill it in by hand.'); }
  const fields = nlFields(out);
  if (!fields.TITLE) throw new Error('I could not make sense of that. Try one clear sentence, or use + Add event.');
  return eventFromFields(fields, todayStr(), t);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise(resolve => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n < 40000) chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
// sub: what follows /calendar/. Returns false when it is not one of these routes.
async function route(sub, req, res, send) {
  try {
    if (req.method === 'GET' && sub === 'sources/list') return send(res, 200, listView());
    if (req.method !== 'POST') return false;
    if (!/^(sources\/|event\/|config$)/.test(sub)) return false;
    const b = await readBody(req);
    if (sub === 'sources/detect') return send(res, 200, { candidates: await candidatesFor(b.input, { deep: !!b.deep }) });
    if (sub === 'sources/add') { addSource(b); return send(res, 200, { ...listView(), added: true }); }
    if (sub === 'sources/update') { updateSource(String(b.id || ''), b); return send(res, 200, listView()); }
    if (sub === 'sources/remove') { removeSource(String(b.id || '')); return send(res, 200, listView()); }
    if (sub === 'sources/refresh') { for (const s of db.sources.filter(x => !b.id || x.id === b.id)) await eventsOf(s, { fresh: true }); return send(res, 200, listView()); }
    if (sub === 'sources/discover') return send(res, 200, { ...(await discover()), ...listView() });
    if (sub === 'sources/dismiss') { dismiss(b.url); return send(res, 200, listView()); }
    if (sub === 'event/get') { const m = db.manual.find(x => x.id === String(b.id || '')); return send(res, 200, m ? { event: m } : { error: 'That event is already gone.' }); }
    if (sub === 'event/parse') return send(res, 200, { event: await parseNatural(b.text) });
    if (sub === 'event/save') return send(res, 200, { event: saveEvent(b), ...listView() });
    if (sub === 'event/remove') { removeEvent(String(b.id || '')); return send(res, 200, listView()); }
    if (sub === 'event/skip') { skipOccurrence(String(b.id || ''), String(b.date || '')); return send(res, 200, listView()); }
    if (sub === 'config') { setTz(b.tz); return send(res, 200, listView()); }
  } catch (e) { return send(res, 200, { error: e.message }); }
  return false;
}

module.exports = {
  route, localToday, eventsBetween, eventsOf, candidatesFor, discover, addSource, removeSource, saveEvent, removeEvent, skipOccurrence, listView, cityTz, setTz, placeChanged,
  // exported for tests
  parseNatural, eventFromFields, daysFromText, rangeEnd, mentionsDate, nlFields, to24, describeRule, jsonLdEvents, tribeEvents, parseRobots, robotsAllows, robotsOk, guessCategory, updateSource, feedLinks, feedLabels, isoWall, normalizeUrl, cleanRecur, manualToEvent, icsEvents, dismiss, STATE_ZONES, CATEGORIES,
  init: c => { ctx = { ...ctx, ...(c || {}) }; },
  _reset: () => { db = { tz: '', sources: [], dismissed: [], manual: [], found: null, foundAt: '' }; cache = {}; },
};
