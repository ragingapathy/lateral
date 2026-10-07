'use strict';
// Civic mode, part 3: follow one bill as a prediction.
//
// A bill shown in a Civic watch (a federal bill, a state bill, or a city ordinance) gets a "Track this bill" button. It creates an
// ordinary Lateral prediction ("H.R. 123 will become law by Jan 3, 2027") with a sensible starting confidence, and then keeps an
// official record of the bill beside it:
//
//   * the official actions (introduced, committee, floor votes with their tallies, signed...) are a TIMELINE on the prediction.
//     They are the primary record, not evidence: they are never added to the articles that move the evidence balance.
//   * when the official record settles the question (it became law, the chamber passed it, the council adopted it or rejected it,
//     the date passed without it happening) the prediction is resolved yes or no, once, and an alert says so.
//
// Sources, as in the watches: Congress.gov (works on the shared demo key, which allows about 10 requests an hour, so checks are
// sparse), Open States (needs the optional key) and Legistar (keyless).
//
// Routes (all under /api/lateral/civic/):
//   GET  track/preview?item=     what tracking this bill would create: statement, targets, date, starting confidence
//   POST track/start {item,target,confidence,resolveBy}   create the prediction and begin following the record
//   GET  track/get?predictionId= the official record for one tracked prediction
//   GET  track/list              the tracked predictions
//   POST track/refresh {predictionId}   check the official record now
//   POST track/stop {predictionId}      stop following the record (the prediction stays)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.LATERAL_DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'civic-track.json');
const LEGISTAR = 'https://webapi.legistar.com/v1';
const CONGRESS = 'https://api.congress.gov/v3';
const OPENSTATES = 'https://v3.openstates.org';
const HOUR = 3600000;

const civic = () => require('./civic');
const watch = () => require('./civic-watch');
const v2 = () => require('./v2');
// Test hook: stand-ins for the network and the clock.
let ctx = {};
const getJson = (url, opts) => (ctx.getJson || civic().getJson)(url, opts);
const nowMs = () => (ctx.now ? ctx.now() : Date.now());
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Storage ─────────────────────────────────────────────────────────────────
// tracks: { predictionId: { ref, label, title, url, target, origin, resolveBy, actions[], status, checkedAt, ... } }

let db = (() => {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { tracks: j.tracks || {} }; } catch { return { tracks: {} }; }
})();
let saveTimer = null;
function saveSoon() { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 500); }
function saveNow() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, FILE); } catch { /* next change */ }
}

const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const dayOf = v => { const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ''; };
const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const niceDay = day => { try { return new Date(day + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return day; } };

// ─── Referring to a bill ─────────────────────────────────────────────────────

const BILL_LABEL = { HR: 'H.R.', S: 'S.', HRES: 'H.Res.', SRES: 'S.Res.', HJRES: 'H.J.Res.', SJRES: 'S.J.Res.', HCONRES: 'H.Con.Res.', SCONRES: 'S.Con.Res.' };
const BILL_PATH = { HR: 'house-bill', S: 'senate-bill', HRES: 'house-resolution', SRES: 'senate-resolution', HJRES: 'house-joint-resolution', SJRES: 'senate-joint-resolution', HCONRES: 'house-concurrent-resolution', SCONRES: 'senate-concurrent-resolution' };
const MAKES_LAW = new Set(['HR', 'S', 'HJRES', 'SJRES']);   // simple and concurrent resolutions never become law

// A watch item id -> where the bill lives. (Item ids are made by civic-watch: bill:<congress>-<TYPE>-<n>, os:<openstates id>, matter:<id>.)
function refFromItem(item, profile) {
  let m;
  if ((m = /^bill:(\d{2,3})-([A-Z]+)-(\d+)$/.exec(item))) return { source: 'congress', congress: Number(m[1]), type: m[2], number: m[3] };
  if ((m = /^os:(ocd-bill\/[0-9a-f-]{20,})$/i.exec(item))) return { source: 'openstates', id: m[1] };
  if ((m = /^matter:(\d{1,9})$/.exec(item))) {
    const loc = profile && profile.local;
    if (!loc || !loc.slug || !loc.confirmed) throw new Error('Confirm your city council on the Civic page first.');
    return { source: 'legistar', slug: loc.slug, matterId: m[1], body: loc.body || 'City council', place: (profile.jurisdictions && profile.jurisdictions.place && profile.jurisdictions.place.name) || '' };
  }
  throw new Error('That item cannot be tracked as a bill.');
}
const refKey = ref => ref.source === 'congress' ? `congress:${ref.congress}-${ref.type}-${ref.number}` : ref.source === 'openstates' ? `os:${ref.id}` : `legistar:${ref.slug}:${ref.matterId}`;

// ─── Reading the official record ─────────────────────────────────────────────
// Each reader returns { label, title, url, origin, actions[], extra }. An action is
//   { key, date, text, chamber, milestone, vote?: {tally, roll, url}, kind?: 'enacted'|'chamber'|'veto'|'presented'|'failed'|'committee' }

const ENACTED = /^(became (public|private) law|signed by (the )?(president|governor)|approved by (the )?governor)/i;
const VETO = /^(pocket )?vetoed by (the )?(president|governor)/i;
const PRESENTED = /^presented to (the )?president/i;
const CHAMBER_PASS = [
  /^passed\/agreed to in (house|senate)/i,
  /^passed (house|senate)\b/i,
  /^(resolution|bill|joint resolution|concurrent resolution) (passed|agreed to) (in )?(house|senate)\b/i,
  /^(resolution|concurrent resolution) agreed to in (house|senate)\b/i,
  /^agreed to in (house|senate)\b/i,
  /^on (passage|motion to suspend the rules and pass)\b.*\bpassed\b/i,
  /^on agreeing to the (resolution|concurrent resolution|joint resolution)\b.*\bagreed to\b/i,
];
const CHAMBER_FAIL = /^(on passage\b.*\bfailed|motion to (pass|suspend the rules and pass)\b.*\bfailed|failed of passage|rejected in (house|senate)|cloture\b.*\bnot invoked)/i;
const COMMITTEE = /ordered to be reported|^reported (by|with|without)|^committee on .* (discharged|reported)/i;

function tallyOf(text) {
  const t = /(\d{1,3})\s*-\s*(\d{1,3})/.exec(text || '');
  const r = /(?:roll no\.?|record vote number:?|roll call)\s*(\d+)/i.exec(text || '');
  return t || r ? { tally: t ? `${t[1]}-${t[2]}` : '', roll: r ? r[1] : '' } : null;
}
function chamberFromText(text) { const m = /\b(house|senate)\b/i.exec(text || ''); return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : ''; }

function congressAction(a) {
  const text = clip(a.text, 400), rv = (a.recordedVotes || [])[0];
  const src = a.sourceSystem && a.sourceSystem.name || '';
  const chamber = (rv && rv.chamber) || (/house/i.test(src) ? 'House' : /senate/i.test(src) ? 'Senate' : '') || chamberFromText(text);
  let kind = '';
  if (ENACTED.test(text)) kind = 'enacted';
  else if (VETO.test(text)) kind = 'veto';
  else if (PRESENTED.test(text)) kind = 'presented';
  else if (CHAMBER_FAIL.test(text)) kind = 'failed';
  else if (CHAMBER_PASS.some(re => re.test(text))) kind = 'chamber';
  else if (COMMITTEE.test(text)) kind = 'committee';
  const v = tallyOf(text);
  const vote = (v || rv) ? { tally: v ? v.tally : '', roll: (v && v.roll) || (rv && rv.rollNumber ? String(rv.rollNumber) : ''), url: rv && rv.url || '' } : null;
  const date = dayOf(a.actionDate);
  return { key: sha(date + '|' + text), date, text, chamber, kind, vote: vote && (vote.tally || vote.roll) ? vote : null, milestone: !!(kind || (vote && vote.tally)) };
}

async function readCongress(ref) {
  const key = watch().keyFor('congress') || 'DEMO_KEY';
  const base = `${CONGRESS}/bill/${ref.congress}/${ref.type.toLowerCase()}/${ref.number}`;
  const q = `format=json&api_key=${encodeURIComponent(key)}`;
  const [bill, acts] = await Promise.all([
    getJson(`${base}?${q}`, { timeout: 25000 }),
    getJson(`${base}/actions?${q}&limit=250`, { timeout: 25000 }),
  ]);
  // A long bill can have more than one page of actions; read up to three more, so the newest are never cut off whichever end the
  // service lists first.
  const total = Number(acts.pagination && acts.pagination.count) || 0;
  for (let off = 250; acts.actions && off < Math.min(total, 1000); off += 250) {
    try { const more = await getJson(`${base}/actions?${q}&limit=250&offset=${off}`, { timeout: 25000 }); acts.actions.push(...(more.actions || [])); } catch { break; }
  }
  const b = bill.bill || {};
  const label = `${BILL_LABEL[ref.type] || ref.type} ${ref.number}`;
  const origin = ref.type[0] === 'H' ? 'House' : 'Senate';
  const actions = (acts.actions || []).map(congressAction).sort((x, y) => x.date.localeCompare(y.date) || 0);
  return {
    label, title: clip(b.title || label, 300), origin,
    url: BILL_PATH[ref.type] ? `https://www.congress.gov/bill/${ordinal(ref.congress)}-congress/${BILL_PATH[ref.type]}/${ref.number}` : 'https://www.congress.gov',
    actions, extra: { sponsor: b.sponsors && b.sponsors[0] && b.sponsors[0].fullName || '' },
  };
}

const OS_MILESTONE = new Set(['passage', 'failure', 'became-law', 'executive-signature', 'executive-veto', 'veto-override-passage', 'veto-override-failure', 'committee-passage', 'executive-receipt']);
const OS_KIND = c => c.includes('became-law') || c.includes('executive-signature') ? 'enacted' : c.includes('executive-veto') ? 'veto'
  : c.includes('executive-receipt') ? 'presented' : c.includes('failure') ? 'failed' : c.includes('passage') && !c.includes('committee-passage') ? 'chamber' : c.includes('committee-passage') ? 'committee' : '';
const osChamber = o => { const c = o && o.classification; return c === 'upper' ? 'Senate' : c === 'lower' ? 'House' : c === 'executive' ? 'Governor' : ''; };

async function readOpenStates(ref) {
  const key = watch().keyFor('openstates');
  if (!key) { const e = new Error('Tracking a state bill needs a free Open States key.'); e.needsKey = 'openstates'; throw e; }
  const b = await getJson(`${OPENSTATES}/bills/${ref.id}?include=actions&include=votes`, { timeout: 25000, headers: { 'X-API-KEY': key } });
  const votes = b.votes || [];
  const actions = (b.actions || []).map(a => {
    const cls = a.classification || [], kind = OS_KIND(cls), date = dayOf(a.date), chamber = osChamber(a.organization);
    let vote = null;
    if (kind === 'chamber' || kind === 'failed') {
      const v = votes.find(x => dayOf(x.start_date) === date && osChamber(x.organization) === chamber);
      if (v) {
        const n = o => ((v.counts || []).find(c => c.option === o) || {}).value;
        if (n('yes') != null && n('no') != null) vote = { tally: `${n('yes')}-${n('no')}`, roll: '', url: '' };
      }
    }
    return { key: sha(date + '|' + a.description), date, text: clip(a.description, 400), chamber, kind, vote, milestone: cls.some(c => OS_MILESTONE.has(c)) };
  }).sort((x, y) => x.date.localeCompare(y.date));
  const origin = osChamber(b.from_organization) || (actions[0] && actions[0].chamber) || '';
  return { label: b.identifier || 'State bill', title: clip(b.title, 300), origin, url: b.openstates_url || '', actions, extra: { session: b.session || '' } };
}

const LEG_DONE = /^(passed|adopted|approved|enacted|signed|finally passed|ordained|effective|resolution adopted|ordinance passed)\b/i;
const LEG_FAIL = /^(failed|defeated|withdrawn|vetoed|died|lost|not adopted|rejected)\b/i;

async function readLegistar(ref) {
  const [m, h] = await Promise.all([
    getJson(`${LEGISTAR}/${ref.slug}/matters/${ref.matterId}`, { timeout: 25000 }),
    getJson(`${LEGISTAR}/${ref.slug}/matters/${ref.matterId}/histories`, { timeout: 25000 }).catch(() => []),
  ]);
  const actions = (Array.isArray(h) ? h : []).map(x => {
    const flag = x.MatterHistoryPassedFlagName || '', name = x.MatterHistoryActionName || '', body = x.MatterHistoryActionBodyName || '';
    const text = clip([name, body && `(${body})`, flag && `— ${flag}`].filter(Boolean).join(' '), 300), date = dayOf(x.MatterHistoryActionDate);
    const tallyRaw = String(x.MatterHistoryTally || '').trim();
    const kind = /^fail/i.test(flag) || LEG_FAIL.test(name) ? 'failed' : /^pass/i.test(flag) || LEG_DONE.test(name) ? 'chamber' : '';
    return { key: sha(`${x.MatterHistoryId}|${date}|${text}`), date, text, chamber: body, kind, vote: tallyRaw && /\d/.test(tallyRaw) ? { tally: tallyRaw.replace(/\s+/g, ''), roll: '', url: '' } : null, milestone: !!kind };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const file = m.MatterFile || `File ${ref.matterId}`;
  return {
    label: file, title: clip(m.MatterTitle || m.MatterName || file, 300), origin: ref.body,
    url: `https://${ref.slug}.legistar.com/LegislationDetail.aspx?ID=${m.MatterId}&GUID=${m.MatterGuid}`,
    actions, extra: { status: m.MatterStatusName || '', passedDate: dayOf(m.MatterPassedDate), enactedDate: dayOf(m.MatterEnactmentDate) },
  };
}

const readers = { congress: readCongress, openstates: readOpenStates, legistar: readLegistar };
async function read(ref) { return readers[ref.source](ref); }

// A short-lived copy, so previewing and then starting costs one round of requests (Congress.gov's demo key is scarce).
const detailCache = new Map();
async function readCached(ref, fresh) {
  const k = refKey(ref), hit = detailCache.get(k);
  if (hit && !fresh && nowMs() - hit.at < 10 * 60000) return hit.d;
  const d = await read(ref);
  detailCache.set(k, { at: nowMs(), d });
  if (detailCache.size > 40) detailCache.delete(detailCache.keys().next().value);
  return d;
}
function nowIso() { return new Date(nowMs()).toISOString(); }

// ─── What would settle the question ──────────────────────────────────────────

function targetsFor(ref) {
  if (ref.source === 'congress') {
    const origin = ref.type[0] === 'H' ? 'House' : 'Senate';
    const t = [];
    if (MAKES_LAW.has(ref.type)) t.push({ id: 'law', label: 'Becomes law', blurb: 'Both chambers pass it and it is signed (or the veto is overridden).' });
    t.push({ id: 'chamber', label: `Passes the ${origin}`, blurb: `A roll-call or voice vote passes it in the ${origin}, where it was introduced.` });
    return t;
  }
  if (ref.source === 'openstates') return [
    { id: 'law', label: 'Becomes law', blurb: 'It passes and the governor signs it, or it otherwise becomes law.' },
    { id: 'chamber', label: 'Passes its first chamber', blurb: 'The chamber where it was introduced passes it.' },
  ];
  return [{ id: 'adopt', label: 'Is adopted', blurb: 'The council passes or adopts it.' }];
}

// The first official action that makes the target true / false for good, or null.
function evaluate(track, detail, now) {
  const acts = detail.actions || [];
  const t = track.target, origin = track.origin || detail.origin || '';
  if (track.ref.source === 'legistar') {
    const x = detail.extra || {};
    // A final-passage action recorded in the item's history counts too, because the status field can lag it (a Toledo ordinance can
    // still read "Second Reading" after its Passage vote). Committee and commission votes are not final.
    const done = acts.slice().reverse().find(a => a.kind === 'chamber' && /^(final passage|passage|adopt|approv|enact|sign|ordain)/i.test(a.text) && !/committee|commission|board/i.test(a.chamber || '')) || null;
    // A "passed date" alone is not proof: some cities stamp it when an item passes to a later reading (Toledo does), so a status that
    // still says "Second Reading" is open. The date counts only when the city gives no status at all.
    if (x.enactedDate || LEG_DONE.test(x.status || '') || done || (!x.status && x.passedDate)) return { yes: { date: x.passedDate || x.enactedDate || (done && done.date) || isoDay(now), text: (done && done.text) || `Status: ${x.status || 'passed'}` } };
    if (LEG_FAIL.test(x.status || '')) return { no: { date: isoDay(now), text: `Status: ${x.status}`, final: true } };
    return {};
  }
  if (t === 'law') {
    const a = acts.find(x => x.kind === 'enacted');
    if (a) return { yes: { date: a.date, text: a.text } };
    return {};
  }
  // chamber passage: by the chamber the bill started in
  const a = acts.find(x => x.kind === 'chamber' && (!origin || !x.chamber || x.chamber === origin));
  if (a) return { yes: { date: a.date, text: a.text } };
  return {};
}

// ─── Starting confidence ─────────────────────────────────────────────────────
// An honest base rate, nudged by how far the bill has already come. The person can change it.

function startingConfidence(track, detail) {
  const acts = detail.actions || [];
  const has = k => acts.some(a => a.kind === k);
  const passedChambers = new Set(acts.filter(a => a.kind === 'chamber').map(a => a.chamber || '?')).size;
  const src = track.ref.source;
  if (src === 'legistar') return { pct: 65, why: 'Most items that reach a council vote pass; the rest stall in committee or are withdrawn.' };
  if (track.target === 'law') {
    if (has('presented')) return { pct: 92, why: 'It has been sent to the executive for signature.' };
    if (passedChambers >= 2) return { pct: 85, why: 'Both chambers have passed it.' };
    if (passedChambers === 1) return { pct: src === 'congress' ? 20 : 45, why: 'It has cleared one chamber; the other still has to act.' };
    if (has('committee')) return { pct: src === 'congress' ? 8 : 15, why: 'A committee has reported it, which most introduced bills never get.' };
    return { pct: src === 'congress' ? 3 : 8, why: src === 'congress' ? 'Only a few percent of bills introduced in Congress become law.' : 'Most state bills introduced do not become law.' };
  }
  if (passedChambers >= 1) return { pct: 90, why: 'It already has a chamber vote on record.' };
  if (has('committee')) return { pct: src === 'congress' ? 35 : 45, why: 'A committee has reported it, which is the usual step before a floor vote.' };
  return { pct: src === 'congress' ? 10 : 20, why: 'Most bills never reach a floor vote.' };
}

function defaultResolveBy(ref, now) {
  if (ref.source === 'congress') return `${2 * ref.congress + 1789}-01-03`;       // the Congress ends on Jan 3 of its second year
  if (ref.source === 'openstates') { const y = new Date(now).getUTCFullYear(); return `${y}-12-31`; }
  return isoDay(now + 90 * 86400000);
}

function statementFor(track, detail, profile) {
  const ref = track.ref, name = clip(detail.title, 110), when = niceDay(track.resolveBy);
  if (ref.source === 'congress') {
    const head = `${detail.label} (${ordinal(ref.congress)} Congress), “${name}”`;
    return track.target === 'law' ? `${head}, will become law by ${when}.` : `${head}, will pass the ${track.origin} by ${when}.`;
  }
  if (ref.source === 'openstates') {
    const st = profile && profile.jurisdictions && profile.jurisdictions.state && profile.jurisdictions.state.name || 'state';
    const head = `${st} ${detail.label}, “${name}”`;
    return track.target === 'law' ? `${head}, will become law by ${when}.` : `${head}, will pass its first chamber by ${when}.`;
  }
  return `${detail.label} (${ref.place ? ref.place + ' ' : ''}${ref.body}), “${name}”, will be adopted by ${when}.`;
}

// ─── Preview / start ─────────────────────────────────────────────────────────

function existingFor(ref, target) {
  const k = refKey(ref);
  return Object.entries(db.tracks).find(([, t]) => refKey(t.ref) === k && t.target === target && t.status === 'open');
}

async function preview(item) {
  const profile = civic().profile();
  if (!profile) throw new Error('No Civic profile yet.');
  const ref = refFromItem(item, profile), detail = await readCached(ref);
  const origin = detail.origin;
  const targets = targetsFor(ref).map(t => {
    const probe = { ref, target: t.id, origin };
    const ev = evaluate(probe, detail, nowMs());
    const conf = startingConfidence(probe, detail);
    const already = ev.yes || ev.no;
    const ex = existingFor(ref, t.id);
    return { ...t, confidence: conf.pct, why: conf.why, already: already ? { outcome: ev.yes ? 'yes' : 'no', date: (ev.yes || ev.no).date, text: (ev.yes || ev.no).text } : null, tracking: ex ? ex[0] : '' };
  });
  const sorted = detail.actions.slice().reverse().slice(0, 4).map(a => ({ date: a.date, text: a.text, vote: a.vote }));
  return { item, label: detail.label, title: detail.title, url: detail.url, origin, source: ref.source, targets, defaultTarget: (targets.find(t => !t.already && !t.tracking) || targets[0]).id,
    resolveBy: defaultResolveBy(ref, nowMs()), recent: sorted, actionCount: detail.actions.length };
}

async function start({ item, target, confidence, resolveBy }) {
  const profile = civic().profile();
  if (!profile) throw new Error('No Civic profile yet.');
  const ref = refFromItem(String(item || ''), profile);
  const tg = targetsFor(ref).find(t => t.id === target);
  if (!tg) throw new Error('Choose what you are predicting.');
  const ex = existingFor(ref, tg.id);
  if (ex) return { existing: { predictionId: ex[0] } };
  const detail = await readCached(ref);
  const track = { ref, target: tg.id, origin: detail.origin };
  const ev = evaluate(track, detail, nowMs());
  if (ev.yes || ev.no) throw new Error(`That already happened (${niceDay((ev.yes || ev.no).date)}): ${clip((ev.yes || ev.no).text, 120)}. A prediction should be about something still open.`);
  const by = /^\d{4}-\d{2}-\d{2}$/.test(String(resolveBy || '')) ? resolveBy : defaultResolveBy(ref, nowMs());
  if (by <= isoDay(nowMs())) throw new Error('Pick a resolution date in the future.');
  track.resolveBy = by;
  const conf = Math.max(1, Math.min(99, Math.round(Number(confidence)) || startingConfidence(track, detail).pct));
  const statement = statementFor(track, detail, profile);
  const short = clip(detail.title, 60);
  const prediction = v2().createPrediction({
    statement, confidence: conf, resolutionDate: by,
    signals: [{ query: `${detail.label} ${short}`, type: 'event' }, { query: `${short} vote`, type: 'event' }],
  });
  db.tracks[prediction.id] = {
    ref, label: detail.label, title: detail.title, url: detail.url, target: tg.id, origin: detail.origin, resolveBy: by,
    actions: detail.actions, status: 'open', createdAt: nowIso(), checkedAt: nowMs(), lastOkAt: nowMs(), extra: detail.extra || {},
  };
  saveSoon();
  const storyId = 'pred-' + prediction.id.slice(0, 8);
  return {
    prediction, storyId,
    story: {
      id: storyId, title: statement.slice(0, 80) + (statement.length > 80 ? '…' : '') + ' (Prediction)', summary: statement,
      statusLine: `${conf}% confidence · Resolves ${by} · tracked from the official record`,
      tags: ['Prediction', 'Civic', ...(ref.source === 'congress' ? ['Congress'] : [])], predictionId: prediction.id,
    },
  };
}

// ─── Following the record ────────────────────────────────────────────────────

const pollEvery = t => t.ref.source === 'congress' ? (watch().keyFor('congress') ? HOUR : 4 * HOUR) : t.ref.source === 'openstates' ? 2 * HOUR : HOUR;
const storyIdOf = pid => 'pred-' + pid.slice(0, 8);

const KIND_WORD = { enacted: 'became law', veto: 'was vetoed', presented: 'was sent for signature', failed: 'failed a vote', chamber: 'passed a vote', committee: 'moved in committee' };

// Look at one tracked bill. Returns alert events. Never throws.
async function check(pid, { force = false } = {}) {
  const t = db.tracks[pid];
  if (!t || t.status !== 'open') return [];
  const now = nowMs();
  if (!force && now - (t.checkedAt || 0) < pollEvery(t)) return [];
  const events = [];
  const pred = v2().getPrediction(pid);
  if (!pred) { delete db.tracks[pid]; saveSoon(); return []; }
  if (pred.resolution) { t.status = 'closed'; t.closedBy = 'user'; saveSoon(); return []; }
  t.checkedAt = now;
  let detail;
  try { detail = await read(t.ref); t.lastOkAt = now; delete t.error; }
  catch (e) { t.error = clip(e.message, 160); saveSoon(); return []; }
  const have = new Set((t.actions || []).map(a => a.key));
  const fresh = detail.actions.filter(a => !have.has(a.key));
  t.actions = detail.actions; t.extra = detail.extra || t.extra; t.title = detail.title || t.title;
  const storyId = storyIdOf(pid);
  for (const a of fresh) {
    if (!a.milestone) continue;
    const word = KIND_WORD[a.kind] || 'moved';
    events.push({
      key: `civic:track:${pid}:${a.key}`, kind: 'civic-vote', severity: a.kind === 'enacted' || a.kind === 'veto' ? 'important' : 'info', storyId,
      title: `${t.label} ${word}${a.vote && a.vote.tally ? ` (${a.vote.tally.replace('-', '–')})` : ''}`,
      body: `${clip(t.title, 150)}\n${a.text}\nOfficial record: ${t.url}`,
    });
  }
  // Settled?
  const ev = evaluate(t, detail, now);
  let outcome = null;
  if (ev.yes) outcome = { outcome: 'yes', at: ev.yes.date, text: ev.yes.text };
  else if (ev.no && ev.no.final) outcome = { outcome: 'no', at: ev.no.date, text: ev.no.text };
  else if (t.resolveBy && isoDay(now) > t.resolveBy) outcome = { outcome: 'no', at: t.resolveBy, text: `The date passed (${niceDay(t.resolveBy)}) without it happening.` };
  if (outcome && v2().settlePrediction(pid, outcome.outcome, { source: 'civic-record', note: clip(outcome.text, 200) })) {
    t.status = 'closed'; t.closedBy = 'record'; t.outcome = outcome;
    events.push({
      key: `civic:track:${pid}:resolved`, kind: 'civic-vote', severity: 'important', storyId,
      title: `Prediction settled ${outcome.outcome === 'yes' ? 'YES' : 'NO'}: ${t.label}`,
      body: `${clip(t.title, 150)}\n${outcome.text}\nResolved from the official record. You can reopen it from the prediction page if this looks wrong.\n${t.url}`,
    });
  } else if (outcome) { t.status = 'closed'; t.closedBy = 'user'; }
  saveSoon();
  return events;
}

// Events found by a manual check wait here until the alerts engine collects them (it keeps the "already told you" record).
const pending = [];

async function collect() {
  const events = pending.splice(0);
  for (const pid of Object.keys(db.tracks)) {
    try { events.push(...await check(pid)); } catch { /* one bad bill must not stop the rest */ }
    await sleep(ctx.noSleep ? 0 : 300);
  }
  return events;
}

// ─── Reading it back ─────────────────────────────────────────────────────────

function publicTrack(pid) {
  const t = db.tracks[pid];
  if (!t) return null;
  const targetLabel = (targetsFor(t.ref).find(x => x.id === t.target) || {}).label || '';
  return {
    predictionId: pid, label: t.label, title: t.title, url: t.url, source: t.ref.source, target: t.target, targetLabel, origin: t.origin,
    resolveBy: t.resolveBy, status: t.status, closedBy: t.closedBy || '', outcome: t.outcome || null,
    checkedAt: t.checkedAt ? new Date(t.checkedAt).toISOString() : '', lastOkAt: t.lastOkAt ? new Date(t.lastOkAt).toISOString() : '', error: t.error || '',
    actions: (t.actions || []).slice(-60).reverse().map(a => ({ date: a.date, text: a.text, chamber: a.chamber, kind: a.kind, vote: a.vote, milestone: a.milestone })),
    actionCount: (t.actions || []).length,
  };
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

// Returns false when the path is not a track route.
async function route(req, reqUrl, res, send) {
  const p = reqUrl.pathname.replace(/^\/api\/lateral/, '');
  if (!p.startsWith('/civic/track')) return false;
  const sub = p.slice('/civic/track'.length).replace(/^\//, '');
  try {
    if (req.method === 'GET' && sub === 'preview') return send(res, 200, await preview(String(reqUrl.searchParams.get('item') || '')));
    if (req.method === 'GET' && sub === 'get') {
      const pid = String(reqUrl.searchParams.get('predictionId') || '');
      return send(res, 200, { track: publicTrack(pid) });
    }
    if (req.method === 'GET' && sub === 'list') return send(res, 200, { tracks: Object.keys(db.tracks).map(publicTrack).map(t => ({ ...t, actions: undefined })) });
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (sub === 'start') return send(res, 200, await start(b));
      if (sub === 'refresh') {
        const pid = String(b.predictionId || ''), t = db.tracks[pid];
        if (!t) return send(res, 200, { track: null });
        // At most every few minutes: the shared Congress.gov key allows only about ten requests an hour.
        const events = nowMs() - (t.checkedAt || 0) < 5 * 60000 ? [] : await check(pid, { force: true });
        if (events.length) { pending.push(...events); try { require('./alerts').checkCivic(); } catch { /* alerts are optional */ } }
        return send(res, 200, { track: publicTrack(pid), found: events.length });
      }
      if (sub === 'stop') { const t = db.tracks[String(b.predictionId || '')]; if (t) { t.status = 'closed'; t.closedBy = 'user'; saveSoon(); } return send(res, 200, { track: publicTrack(String(b.predictionId || '')) }); }
    }
  } catch (e) { return send(res, 200, { error: e.message, needsKey: e.needsKey || '' }); }
  return send(res, 404, { error: 'Unknown track route.' });
}

module.exports = {
  route, collect, check, preview, start, publicTrack,
  init: c => { ctx = { ...ctx, ...(c || {}) }; },
  // for tests
  refFromItem, congressAction, evaluate, startingConfidence, statementFor, defaultResolveBy, targetsFor, readCongress, readOpenStates, readLegistar,
  _reset: () => { db = { tracks: {} }; ctx = {}; detailCache.clear(); },
  _db: () => db,
};
