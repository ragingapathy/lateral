'use strict';
// Calendar engine, pure code with no network: iCalendar (.ics) parsing, time zones, and recurrence ("every second Tuesday") for both
// imported feeds and events you create. Everything is expressed as wall-clock dates and times in the city's own time zone:
//   { date: 'YYYY-MM-DD', time: 'HH:MM' | '' }   (an empty time is an all-day event)
//
// A recurrence rule is a small object, the same shape whether it came from an RRULE line or from the event editor:
//   { freq: 'DAILY'|'WEEKLY'|'MONTHLY'|'YEARLY', interval: 1, byday: ['MO','2TU','-1FR'], bymonthday: [15], bymonth: [11],
//     bysetpos: [-1], until: 'YYYY-MM-DD', count: 10, wkst: 'MO' }

const DAY = 86400000;
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_LOOP = 4000;                         // periods examined per rule: far more than any real calendar needs
const MAX_OUT = 800;                           // occurrences per event

const toNum = s => { const [y, m, d] = String(s).split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY; };
const fromNum = n => new Date(n * DAY).toISOString().slice(0, 10);
const dowOf = n => new Date(n * DAY).getUTCDay();
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();      // m is 1-based
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const pad = n => String(n).padStart(2, '0');
const minutesOf = (date, time) => toNum(date) * 1440 + (time ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) : 0);
function addMinutes(date, time, min) {
  const t = minutesOf(date, time) + min, d = Math.floor(t / 1440), r = t - d * 1440;
  return { date: fromNum(d), time: time ? `${pad(Math.floor(r / 60))}:${pad(r % 60)}` : '' };
}

// ─── Time zones ──────────────────────────────────────────────────────────────

const WINDOWS_ZONES = {
  'Eastern Standard Time': 'America/New_York', 'US Eastern Standard Time': 'America/Indianapolis', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix', 'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage', 'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax',
};
const zoneCache = new Map();
function validZone(tz) {
  if (!tz) return '';
  tz = WINDOWS_ZONES[tz] || String(tz).replace(/^\/[^/]*\//, '');
  if (zoneCache.has(tz)) return zoneCache.get(tz);
  let ok = '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); ok = tz; } catch { ok = ''; }
  zoneCache.set(tz, ok);
  return ok;
}
// An instant (ms) -> wall-clock { date, time } in a zone.
function wallOf(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}
// Wall-clock in a zone -> instant (ms). Two passes settle the offset across a daylight-saving change.
function instantOf(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number), [h, mi] = (time || '00:00').split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, h, mi);
  let guess = naive;
  for (let i = 0; i < 2; i++) { const w = wallOf(guess, tz); guess += naive - Date.UTC(...w.date.split('-').map((v, k) => (k === 1 ? Number(v) - 1 : Number(v))), ...w.time.split(':').map(Number)); }
  return guess;
}
// A time written in some zone (or UTC, or floating) -> the city's wall-clock.
function toCityWall(date, time, zone, cityTz) {
  if (!time) return { date, time: '' };
  if (zone === 'UTC') return wallOf(instantOf(date, time, 'UTC'), cityTz);
  const z = validZone(zone);
  if (!z || z === cityTz) return { date, time };
  return wallOf(instantOf(date, time, z), cityTz);
}

// ─── Recurrence ──────────────────────────────────────────────────────────────

function parseRule(str) {
  const r = { freq: '', interval: 1 };
  for (const part of String(str || '').split(';')) {
    const [k, v] = part.split('='); if (!k || v === undefined) continue;
    const K = k.toUpperCase();
    if (K === 'FREQ') r.freq = v.toUpperCase();
    else if (K === 'INTERVAL') r.interval = Math.max(1, parseInt(v, 10) || 1);
    else if (K === 'COUNT') r.count = parseInt(v, 10) || undefined;
    else if (K === 'UNTIL') { const m = v.match(/^(\d{4})(\d{2})(\d{2})/); if (m) r.until = `${m[1]}-${m[2]}-${m[3]}`; }
    else if (K === 'BYDAY') r.byday = v.toUpperCase().split(',').filter(x => /^[+-]?\d{0,2}(SU|MO|TU|WE|TH|FR|SA)$/.test(x));
    else if (K === 'BYMONTHDAY') r.bymonthday = v.split(',').map(Number).filter(n => n && Math.abs(n) <= 31);
    else if (K === 'BYMONTH') r.bymonth = v.split(',').map(Number).filter(n => n >= 1 && n <= 12);
    else if (K === 'BYSETPOS') r.bysetpos = v.split(',').map(Number).filter(Boolean);
    else if (K === 'WKST' && WD.includes(v.toUpperCase())) r.wkst = v.toUpperCase();
  }
  return ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(r.freq) ? r : null;
}
const dayItem = s => { const m = String(s).match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/); return m ? { n: m[1] ? Number(m[1]) : 0, wd: WD.indexOf(m[2]) } : null; };

// The days of month `m` of year `y` that match a BYDAY list (with ordinals) and/or a BYMONTHDAY list.
function monthDays(y, m, byday, bymonthday) {
  const first = Date.UTC(y, m - 1, 1) / DAY, n = dim(y, m), out = new Set();
  for (const bd of byday || []) {
    const it = dayItem(bd); if (!it) continue;
    const all = []; for (let d = 0; d < n; d++) if (dowOf(first + d) === it.wd) all.push(first + d);
    if (!it.n) all.forEach(x => out.add(x));
    else { const x = it.n > 0 ? all[it.n - 1] : all[all.length + it.n]; if (x !== undefined) out.add(x); }
  }
  for (const md of bymonthday || []) { const d = md > 0 ? md : n + md + 1; if (d >= 1 && d <= n) out.add(first + d - 1); }
  return [...out];
}

// The days in the k-th period of a rule (before COUNT/UNTIL), and where that period starts.
function period(rule, start, k) {
  const s = toNum(start), [sy, sm, sd] = start.split('-').map(Number), step = rule.interval * k;
  const wkst = Math.max(0, WD.indexOf(rule.wkst || 'MO'));
  let days = [], anchor = s;
  if (rule.freq === 'DAILY') {
    anchor = s + step; days = [anchor];
    if (rule.byday) days = days.filter(d => rule.byday.some(b => (dayItem(b) || {}).wd === dowOf(d)));
  } else if (rule.freq === 'WEEKLY') {
    anchor = s - ((dowOf(s) - wkst + 7) % 7) + step * 7;
    const wds = rule.byday && rule.byday.length ? rule.byday.map(b => (dayItem(b) || {}).wd).filter(x => x !== undefined) : [dowOf(s)];
    days = wds.map(wd => anchor + ((wd - wkst + 7) % 7));
  } else if (rule.freq === 'MONTHLY') {
    const mi = sm - 1 + step, y = sy + Math.floor(mi / 12), m = (mi % 12) + 1;
    anchor = Date.UTC(y, m - 1, 1) / DAY;
    days = rule.byday || rule.bymonthday ? monthDays(y, m, rule.byday, rule.bymonthday) : (sd <= dim(y, m) ? [anchor + sd - 1] : []);
  } else {
    const y = sy + step; anchor = Date.UTC(y, 0, 1) / DAY;
    const months = rule.bymonth && rule.bymonth.length ? rule.bymonth : [sm];
    for (const m of months) {
      if (rule.byday || rule.bymonthday) days.push(...monthDays(y, m, rule.byday, rule.bymonthday));
      else if (sd <= dim(y, m)) days.push(Date.UTC(y, m - 1, sd) / DAY);
    }
  }
  if (rule.bymonth && rule.bymonth.length && rule.freq !== 'YEARLY') days = days.filter(d => rule.bymonth.includes(new Date(d * DAY).getUTCMonth() + 1));
  days = [...new Set(days)].sort((a, b) => a - b);
  if (rule.bysetpos && rule.bysetpos.length) days = rule.bysetpos.map(p => (p > 0 ? days[p - 1] : days[days.length + p])).filter(x => x !== undefined).sort((a, b) => a - b);
  return { anchor, days };
}

// Days (YYYY-MM-DD) a rule produces from `start`, within [from, to]. COUNT is honoured from the very first occurrence.
function expandRule(rule, start, from, to) {
  const out = [], s = toNum(start), lo = toNum(from), hi = Math.min(toNum(to), rule.until ? toNum(rule.until) : Infinity);
  let counted = 0;
  for (let k = 0; k < MAX_LOOP; k++) {
    const { anchor, days } = period(rule, start, k);
    if (anchor > hi && days.every(d => d > hi)) break;
    for (const d of days) {
      if (d < s) continue;
      counted++;
      if (rule.count && counted > rule.count) return out;
      if (d >= lo && d <= hi) { out.push(fromNum(d)); if (out.length >= MAX_OUT) return out; }
    }
    if (rule.count && counted >= rule.count) break;
  }
  return out;
}

// ─── Events: one shape for imported and created events ──────────────────────

// An event { start:{date,time}, durMin, allDay, spanDays, rule, exdates, rdates } -> its occurrences within [from, to].
function occurrences(ev, from, to) {
  const days = new Set();
  const isIn = d => d >= from && d <= to;
  if (ev.rule) expandRule(ev.rule, ev.start.date, ev.start.date < from ? addMinutes(from, '', -(Math.max(1, ev.spanDays || 1)) * 1440).date : from, to).forEach(d => days.add(d));
  else days.add(ev.start.date);
  for (const d of ev.rdates || []) days.add(d);
  for (const d of ev.exdates || []) days.delete(d);
  const out = [];
  for (const d of [...days].sort()) {
    const end = ev.allDay ? addMinutes(d, '', ((ev.spanDays || 1) - 1) * 1440).date : addMinutes(d, ev.start.time, ev.durMin || 0).date;
    if (!(isIn(d) || (end >= from && d <= to))) continue;
    const o = { date: d, time: ev.allDay ? '' : ev.start.time };
    if (ev.allDay) { if (end > d) o.endDate = end; }
    else {
      const e = addMinutes(d, ev.start.time, ev.durMin || 0);
      if (ev.durMin) { o.endTime = e.time; if (e.date > d) o.endDate = e.date; }
    }
    out.push(o);
  }
  return out;
}

// ─── iCalendar parsing ───────────────────────────────────────────────────────

const unescapeText = s => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
function lines(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n').map(l => {
    const i = (() => { let q = false; for (let k = 0; k < l.length; k++) { if (l[k] === '"') q = !q; else if (l[k] === ':' && !q) return k; } return -1; })();
    if (i < 1) return null;
    const head = l.slice(0, i).split(';'), params = {};
    for (const p of head.slice(1)) { const [k, ...v] = p.split('='); params[k.toUpperCase()] = v.join('=').replace(/^"|"$/g, ''); }
    return { name: head[0].toUpperCase(), params, value: l.slice(i + 1) };
  }).filter(Boolean);
}
// "20261103T180000Z" / "20261103" / "20261103T180000" -> { date, time, zone: 'UTC' | tzid | '' , dateOnly }
function icsDate(value, params) {
  const m = String(value || '').trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4] || (params && params.VALUE === 'DATE')) return { date, time: '', zone: '', dateOnly: true };
  return { date, time: `${m[4]}:${m[5]}`, zone: m[7] ? 'UTC' : (params && params.TZID) || '', dateOnly: false };
}
function durationMin(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m) return 0;
  return ((m[1] === '-' ? -1 : 1)) * ((Number(m[2] || 0) * 7 + Number(m[3] || 0)) * 1440 + Number(m[4] || 0) * 60 + Number(m[5] || 0));
}

// Parse a calendar file into events. cityTz: the zone every time is converted into (floating times are taken as they are).
function parseIcs(text, cityTz) {
  const out = [];
  let cur = null;
  for (const l of lines(text)) {
    if (l.name === 'BEGIN' && l.value.toUpperCase() === 'VEVENT') { cur = { props: [] }; continue; }
    if (l.name === 'END' && l.value.toUpperCase() === 'VEVENT') { if (cur) { const ev = buildEvent(cur.props, cityTz); if (ev) out.push(ev); } cur = null; continue; }
    if (cur) cur.props.push(l);
  }
  return out;
}
function buildEvent(props, cityTz) {
  const get = n => props.find(p => p.name === n);
  const all = n => props.filter(p => p.name === n);
  const ds = get('DTSTART'); if (!ds) return null;
  const s = icsDate(ds.value, ds.params); if (!s) return null;
  const status = (get('STATUS') || {}).value || '';
  if (/cancel/i.test(status)) return { cancelled: true, uid: (get('UID') || {}).value || '', recurrenceId: (get('RECURRENCE-ID') || {}).value || '' };
  const start = toCityWall(s.date, s.time, s.zone, cityTz);
  const ev = { uid: clean((get('UID') || {}).value), title: unescapeText((get('SUMMARY') || {}).value) || '(untitled)', detail: unescapeText((get('DESCRIPTION') || {}).value), location: unescapeText((get('LOCATION') || {}).value), url: clean((get('URL') || {}).value), allDay: s.dateOnly, start: { date: start.date, time: s.dateOnly ? '' : start.time }, durMin: 0, spanDays: 1, rule: null, exdates: [], rdates: [], recurrenceId: '' };
  const de = get('DTEND'), du = get('DURATION');
  if (de) {
    const e = icsDate(de.value, de.params);
    if (e) {
      if (s.dateOnly) ev.spanDays = Math.max(1, toNum(e.date) - toNum(s.date));
      else { const ew = toCityWall(e.date, e.time, e.zone, cityTz); ev.durMin = Math.max(0, minutesOf(ew.date, e.dateOnly ? '' : ew.time) - minutesOf(start.date, start.time)); }
    }
  } else if (du) {
    const m = durationMin(du.value);
    if (s.dateOnly) ev.spanDays = Math.max(1, Math.round(m / 1440)); else ev.durMin = Math.max(0, m);
  }
  const rr = get('RRULE'); if (rr) ev.rule = parseRule(rr.value);
  for (const p of all('EXDATE')) for (const v of p.value.split(',')) { const d = icsDate(v, p.params); if (d) ev.exdates.push(toCityWall(d.date, d.time, d.zone, cityTz).date); }
  for (const p of all('RDATE')) for (const v of p.value.split(',')) { const d = icsDate(v.split('/')[0], p.params); if (d) ev.rdates.push(toCityWall(d.date, d.time, d.zone, cityTz).date); }
  const rid = get('RECURRENCE-ID');
  if (rid) { const d = icsDate(rid.value, rid.params); if (d) ev.recurrenceId = toCityWall(d.date, d.time, d.zone, cityTz).date; }
  return ev;
}
const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

// Parsed events -> flat occurrences within the window. Cancelled instances and replaced instances are handled.
function expandAll(events, from, to) {
  const cancelled = new Map(), replaced = new Map();
  for (const e of events) {
    if (e.cancelled && e.recurrenceId) { const d = icsDate(e.recurrenceId, {}); if (d) { (cancelled.get(e.uid) || cancelled.set(e.uid, new Set()).get(e.uid)).add(d.date); } }
    else if (e.recurrenceId && e.uid) (replaced.get(e.uid) || replaced.set(e.uid, new Set()).get(e.uid)).add(e.recurrenceId);
  }
  const out = [];
  for (const e of events) {
    if (e.cancelled) continue;
    const skip = new Set([...(cancelled.get(e.uid) || []), ...(e.recurrenceId ? [] : (replaced.get(e.uid) || []))]);
    const ev = skip.size ? { ...e, exdates: [...e.exdates, ...skip] } : e;
    for (const o of occurrences(ev, from, to)) out.push({ uid: e.uid, title: e.title, detail: e.detail, location: e.location, url: e.url, ...o });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date) || (x.time || '').localeCompare(y.time || ''));
}

module.exports = {
  toNum, fromNum, addMinutes, minutesOf, validZone, wallOf, instantOf, toCityWall,
  parseRule, expandRule, occurrences, parseIcs, expandAll, icsDate, durationMin, monthDays, WD,
};
