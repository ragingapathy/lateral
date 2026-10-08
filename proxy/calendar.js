'use strict';
// The city calendar, step 1: the civic dates Lateral already knows, on one calendar.
//
//   vote       Election Day, early voting opens, and other voting dates for your state (civic-ballot.js)
//   deadline   registration and mail-ballot deadlines, and federal rule comment deadlines you watch
//   meeting    council and board meetings, from Legistar, Granicus and feeds, whether or not you watch them
//   term       the day a term of someone who represents you ends
//
// Each date is a plain event { id, date, endDate?, time?, title, kind, group, url, detail }. Nothing here is a guess: every event comes
// from a source Lateral already reads, and `sources` says which ones answered. Later steps add local events from sources you point
// it at; they will use the same event shape.
//
//   event    local events from calendars you added (and found for you), see calendar-sources.js
//   food     the same, for sources you marked food and drink
//   mine     events you created yourself, one-off or repeating
//
//   GET  calendar/events    { events, sources:[{id,name,ok,error?}], from, to, asOf }
//   GET  /feed/<token>/calendar.ics    the same events as a calendar file to subscribe to (served through feeds.js)

const civic = () => require('./civic');
const ballot = () => require('./civic-ballot');
const watch = () => require('./civic-watch');
const boards = () => require('./civic-boards');
const sources = () => require('./calendar-sources');

let ctx = {};                                   // test hooks: profile, status, fetchKind, boards, now
const nowMs = () => (ctx.now ? ctx.now() : Date.now());
const todayStr = () => { try { return require('./calendar-sources').localToday(nowMs()); } catch { return new Date(nowMs()).toISOString().slice(0, 10); } };
const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const addDays = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// "6:00 PM" / "6:00 p.m." / "18:00" -> "18:00", or ''. Pure.
function clock(v) {
  const m = String(v || '').match(/\b(\d{1,2}):(\d{2})\s*([ap])?\.?m?\.?/i);
  if (!m) return '';
  let h = Number(m[1]); const min = Number(m[2]);
  if (m[3]) { const pm = m[3].toLowerCase() === 'p'; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  if (h > 23 || min > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const stableId = (...p) => p.map(x => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '-')).join(':').slice(0, 120);

// ─── Sources ─────────────────────────────────────────────────────────────────

function votingEvents(st) {
  const s = st && st.schedule;
  if (!s) return [];
  const group = `${s.stateName} elections`;
  const link = (s.links && s.links[0] && s.links[0].url) || '';
  const out = s.items.map(i => ({
    id: stableId('vote', s.electionDay, i.id), date: i.date, title: i.label,
    kind: i.id === 'election' || i.id === 'early' ? 'vote' : 'deadline', group, url: link, detail: i.note || '',
  }));
  // The early-voting window as one span, when the ballot lookup knows it.
  const b = st.ballot;
  if (b && b.early && b.early.length) {
    const starts = b.early.map(e => e.start).filter(isDay).sort(), ends = b.early.map(e => e.end).filter(isDay).sort();
    if (starts.length && ends.length && !out.some(e => e.id.endsWith(':early'))) {
      out.push({ id: stableId('vote', s.electionDay, 'early'), date: starts[0], endDate: ends[ends.length - 1], title: 'Early in-person voting', kind: 'vote', group, url: link, detail: 'Hours and sites vary: see Voting dates and your ballot.' });
    }
  }
  return out;
}

function termEvents(prof) {
  const out = [];
  for (const o of (prof && prof.officials) || []) {
    if (!isDay(o.termEnds)) continue;
    out.push({
      id: stableId('term', o.name, o.office, o.termEnds), date: o.termEnds, title: `${clean(o.name)}'s term ends`, kind: 'term',
      group: clean(o.office), url: o.website || '', detail: [clean(o.office), o.upForElection ? 'On the ballot' : ''].filter(Boolean).join(' · '),
    });
  }
  return out;
}

function meetingEvents(kindName, label, items) {
  const out = [];
  for (const it of items || []) {
    if (!it) continue;
    if (it.kind === 'meeting' && isDay(it.date)) {
      out.push({
        id: stableId('meeting', it.id || (label + it.date)), date: it.date, time: clock(it.time), title: clean(it.bodyName || it.title || 'Meeting'), kind: 'meeting',
        group: label, url: it.url || '', detail: clean(it.snippet),
      });
    } else if (it.kind === 'rule' && isDay(it.deadline)) {
      out.push({ id: stableId('rule', it.id), date: it.deadline, title: `Comments close: ${clean(it.title).slice(0, 110)}`, kind: 'deadline', group: label, url: it.url || '', detail: clean(it.snippet) });
    }
  }
  return out;
}

// All the events within the window, plus which sources answered. Never throws: one broken source does not hide the rest.
async function civicEvents({ from, to } = {}) {
  const prof = ctx.profile ? ctx.profile() : civic().profile();
  const today = todayStr();
  const lo = isDay(from) ? from : addDays(today, -45), hi = isDay(to) ? to : addDays(today, 365);
  const sources = [], events = [];
  const take = async (id, name, fn) => {
    try { const r = await fn(); events.push(...r); sources.push({ id, name, ok: true, count: r.length }); }
    catch (e) { sources.push({ id, name, ok: false, error: String(e.message || e).slice(0, 160) }); }
  };
  if (!prof) return { events: [], sources: [], from: lo, to: hi, asOf: new Date(nowMs()).toISOString(), needsProfile: true };

  await take('voting', 'Voting dates', async () => votingEvents(ctx.status ? ctx.status() : ballot().status()));
  await take('terms', 'Terms of office', async () => termEvents(prof));
  const fetchKind = ctx.fetchKind || ((k, o) => watch().fetchKind(k, o));
  if (prof.local && prof.local.slug && prof.local.confirmed) {
    await take('council', `${prof.local.body || 'City council'}`, async () => meetingEvents('council', prof.local.body || 'City council', (await fetchKind('council')).items));
  }
  const bs = ctx.boards ? ctx.boards() : boards().list();
  await Promise.all(bs.map(b => take('board:' + b.id, b.label, async () => meetingEvents('board', String(b.label || '').replace(/\s*\((Legistar|Granicus)\)$/, ''), (await fetchKind('board:' + b.id)).items))));
  await take('rules', 'Federal rule comments', async () => meetingEvents('rules', 'Federal Register', ((await fetchKind('rules').catch(() => ({ items: [] }))).items)));

  const seen = new Set();
  const out = events.filter(e => {
    const end = e.endDate || e.date;
    if (end < lo || e.date > hi || seen.has(e.id)) return false;
    seen.add(e.id); return true;
  }).sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '') || a.title.localeCompare(b.title));
  return { events: out, sources, from: lo, to: hi, asOf: new Date(nowMs()).toISOString() };
}

// ─── Calendar file ───────────────────────────────────────────────────────────

const icsText = s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
// RFC 5545: lines longer than 75 octets are folded with CRLF + one space (never in the middle of a multi-byte character).
function fold(line) {
  const out = []; let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const ymd = d => d.replace(/-/g, '');
const stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// Pure. Meetings with a time are "floating" local times (they happen where you live); everything else is an all-day event.
function toIcs(events, name, nowMillis) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lateral//Civic calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(name || 'Lateral: civic calendar')}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT6H'];
  const dtstamp = stamp(nowMillis || Date.now());
  for (const e of events) {
    L.push('BEGIN:VEVENT', `UID:${e.id}@lateral`, `DTSTAMP:${dtstamp}`);
    if (e.time) {
      const t = e.time.replace(':', '') + '00';
      L.push(`DTSTART:${ymd(e.date)}T${t}`);
      const endH = String((Number(e.time.slice(0, 2)) + 2) % 24).padStart(2, '0');
      if (e.endTime) L.push(`DTEND:${ymd(e.endDate || e.date)}T${e.endTime.replace(':', '')}00`);
      else L.push(Number(e.time.slice(0, 2)) + 2 < 24 ? `DTEND:${ymd(e.date)}T${endH}${e.time.slice(3)}00` : `DURATION:PT2H`);
    } else {
      L.push(`DTSTART;VALUE=DATE:${ymd(e.date)}`, `DTEND;VALUE=DATE:${ymd(addDays(e.endDate || e.date, 1))}`);
    }
    L.push(`SUMMARY:${icsText(e.title)}`);
    const desc = [e.group, e.detail].filter(Boolean).join(' · ');
    if (desc) L.push(`DESCRIPTION:${icsText(desc)}`);
    if (e.location) L.push(`LOCATION:${icsText(e.location)}`);
    if (e.url) L.push(`URL:${e.url}`);
    L.push(`CATEGORIES:${icsText(e.kind)}`, 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
// The civic dates plus your calendars and your own events, merged and de-duplicated.
async function allEvents(opts = {}) {
  const r = await civicEvents(opts);
  if (r.needsProfile) return r;
  let extra = { events: [], sources: [] };
  try { extra = await (ctx.sources ? ctx.sources(r.from, r.to) : sources().eventsBetween(r.from, r.to)); } catch (e) { extra = { events: [], sources: [{ id: 'local', name: 'Local events', ok: false, error: String(e.message || e).slice(0, 160) }] }; }
  const seen = new Set(r.events.map(e => e.id));
  const merged = [...r.events, ...extra.events.filter(e => !seen.has(e.id))].sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '') || a.title.localeCompare(b.title));
  return { ...r, events: merged, sources: [...r.sources, ...extra.sources] };
}
async function icsFile() { const r = await allEvents({}); return toIcs(r.events, 'Lateral: city calendar', nowMs()); }

// ─── Routes ──────────────────────────────────────────────────────────────────

let cache = null;                               // events are rebuilt at most every few minutes
async function cached(opts) {
  if (!opts.from && !opts.to && cache && nowMs() - cache.at < 5 * 60000) return cache.value;
  const value = await allEvents(opts);
  if (!opts.from && !opts.to) cache = { at: nowMs(), value };
  return value;
}

async function route(req, reqUrl, res, send) {
  const sub = reqUrl.pathname.replace(/^\/api\/lateral/, '').replace(/^\/calendar\/?/, '');
  if (req.method === 'GET' && sub === 'events') {
    try { return send(res, 200, await cached({ from: reqUrl.searchParams.get('from') || '', to: reqUrl.searchParams.get('to') || '' })); }
    catch (e) { return send(res, 200, { error: e.message, events: [], sources: [] }); }
  }
  const r = await sources().route(sub, req, res, send);
  if (r !== false) { cache = null; return r; }
  return send(res, 404, { error: 'Unknown calendar route.' });
}

module.exports = {
  route, civicEvents, allEvents, icsFile, toIcs, clock, votingEvents, termEvents, meetingEvents, fold,
  init: c => { ctx = { ...ctx, ...(c || {}) }; cache = null; },
};
