'use strict';
// Civic mode: your ballot and voting dates. Two separate pieces, because they have different needs:
//
//   Voting dates     Come from your profile's state alone, so they need no key and no street address. Each state is a small, dated,
//                    sourced entry in STATE_PLANS (registration, early voting, mail ballots, Election Day). A state without an entry
//                    shows only the election day and a link to its official election site, never a guess.
//   Your ballot      The measures and races on YOUR ballot, plus early-vote sites, drop boxes and your polling place, come from the
//                    Google Civic Information API (voterInfoQuery). It needs a free key and your street address. The address goes to
//                    Google for that one request and is not kept unless you tick "remember" (then it stays in data/ on this computer).
//
// Measures can be explained in plain language by the local model from the official text. Those notes are labeled as AI-written, stay
// neutral and never say how to vote.
//
//   GET  ballot/status        { hasKey, remembered, schedule, ballot }   everything the card needs in one call
//   POST ballot/lookup        {address, remember?}   fetch your ballot from Google Civic (needs the key and a profile)
//   POST ballot/refresh       fetch again with the remembered address
//   POST ballot/forget        drop the cached ballot and any remembered address
//   POST ballot/explain {id}  a neutral plain-language note for one measure (cached)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.LATERAL_DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'civic-ballot.json');
const SECRETS_FILE = path.join(DATA_DIR, 'llm-secrets.json');
const API = 'https://www.googleapis.com/civicinfo/v2';
const REFRESH_MS = 6 * 3600 * 1000;           // a cached ballot is reused for six hours

const civic = () => require('./civic');
let ctx = {};                                   // test hooks: get, ollamaText, now, profile
const httpGet = (url, opts) => (ctx.get || civic().get)(url, { timeout: 20000, ...opts });
const nowMs = () => (ctx.now ? ctx.now() : Date.now());
const todayStr = () => { try { return require('./calendar-sources').localToday(nowMs()); } catch { return new Date(nowMs()).toISOString().slice(0, 10); } };
const profile = () => (ctx.profile ? ctx.profile() : civic().profile());

const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const cleanBlock = s => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
const httpsUrl = v => { try { const u = new URL(String(v || '')); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''; } catch { return ''; } };

// ─── Storage ─────────────────────────────────────────────────────────────────

let db = (() => {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { placeKey: j.placeKey || '', address: j.address || '', ballot: j.ballot || null, explain: j.explain || {} }; }
  catch { return { placeKey: '', address: '', ballot: null, explain: {} }; }
})();
function saveNow() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, FILE); } catch { /* next change */ } }

function apiKey() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')); } catch { /* none saved */ }
  return String(ctx.key !== undefined ? ctx.key : (file.googleCivicApiKey || process.env.GOOGLE_CIVIC_API_KEY || '')).trim();
}

// ─── Voting dates ────────────────────────────────────────────────────────────

// Each entry was read from the state's own election office (and checked against news reports) on the date in `checked`. Dates are written
// out, not computed: election law changes between cycles, and a wrong deadline is worse than none. Add a state by adding an entry.
const STATE_PLANS = {
  OH: {
    name: 'Ohio',
    site: { label: 'Ohio Secretary of State: voters', url: 'https://www.ohiosos.gov/elections/voters/' },
    lookup: { label: 'Check your registration and find your board of elections', url: 'https://voterlookup.ohiosos.gov/' },
    elections: {
      '2026-11-03': {
        checked: '2026-10-07',
        items: [
          { id: 'register', date: '2026-10-05', label: 'Voter registration deadline', note: 'County boards of elections stayed open until 9 p.m. that day.' },
          { id: 'early', date: '2026-10-06', label: 'Early in-person and absentee voting begins', note: 'Hours vary by county: see the sites listed below.' },
          { id: 'request', date: '2026-10-27', label: 'Last day to apply for an absentee ballot' },
          { id: 'election', date: '2026-11-03', label: 'Election Day', note: 'Polls are open 6:30 a.m. to 7:30 p.m.' },
          { id: 'return', date: '2026-11-03', label: 'Absentee ballots must reach your board of elections', note: 'By 7:30 p.m. Election Day. Under the new rule, a postmark is not enough.' },
        ],
      },
    },
  },
};

// The federal general election falls on the Tuesday after the first Monday in November of even years. Pure.
function federalGeneralDay(year) {
  const d = new Date(Date.UTC(year, 10, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);       // first Monday
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function nextGeneralDay(today) {
  let y = Number(today.slice(0, 4));
  if (y % 2) y += 1;
  let d = federalGeneralDay(y);
  if (d < today) d = federalGeneralDay(y + 2);
  return d;
}
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

// What the schedule card shows. Pure given (profile, ballot, today). Returns null with no profile.
function scheduleFor(prof, ballot, today) {
  const abbr = prof && prof.jurisdictions && prof.jurisdictions.state && prof.jurisdictions.state.abbr;
  if (!abbr) return null;
  const plan = STATE_PLANS[abbr];
  const stateName = (plan && plan.name) || prof.jurisdictions.state.name || abbr;
  const day = (ballot && ballot.election && ballot.election.day >= today ? ballot.election.day : '') || nextGeneralDay(today);
  const entry = plan && plan.elections[day];
  const base = { state: abbr, stateName, electionDay: day, electionName: ballot && ballot.election && ballot.election.day === day ? ballot.election.name : '', daysToElection: daysBetween(today, day) };
  if (!entry) {
    const gov = ballot && ballot.officials;
    return {
      ...base, supported: false, items: [{ id: 'election', date: day, label: 'Election Day', past: day < today }],
      links: [gov && gov.registrationUrl && { label: 'Register or check your registration', url: gov.registrationUrl }, gov && gov.infoUrl && { label: `${stateName} election office`, url: gov.infoUrl }, { label: 'Find your state\'s dates on vote.gov', url: 'https://vote.gov/' }].filter(Boolean),
      note: `Lateral does not have ${stateName}'s deadlines yet, so it shows only the election date. ${stateName}'s own election office has the registration and mail-ballot deadlines.`,
    };
  }
  let nextSet = false;
  const items = entry.items.map(i => {
    const past = i.date < today;
    const out = { ...i, past, days: daysBetween(today, i.date) };
    if (!past && !nextSet) { out.next = true; nextSet = true; }
    return out;
  });
  return { ...base, supported: true, checked: entry.checked, items, links: [plan.site, plan.lookup].filter(Boolean), note: '' };
}

// ─── Google Civic ────────────────────────────────────────────────────────────

function googleError(status, body) {
  let msg = '';
  try { const j = JSON.parse(body); msg = (j.error && j.error.message) || ''; } catch { /* not JSON */ }
  if (status === 400 && /api key/i.test(msg)) return 'Google rejected the API key. Check it was copied whole and that the Civic Information API is enabled for its project.';
  if (status === 403) return 'Google refused the request. Make sure the Civic Information API is enabled for this key\'s project, and that the key has no restriction that blocks this computer.';
  if (status === 429) return 'Google\'s daily limit for this key has been used. Try again tomorrow.';
  if (status === 404 || /no information|not found|unable to resolve|address/i.test(msg)) return 'Google has no ballot information for that address yet. Election offices usually load it a few weeks before the election.';
  if (/election/i.test(msg)) return 'Google does not have this election loaded yet. Try again closer to the election.';
  return `Google Civic could not answer (HTTP ${status}${msg ? ': ' + msg.slice(0, 120) : ''}).`;
}

async function callGoogle(endpoint, params) {
  const key = apiKey();
  if (!key) throw new Error('Add a Google Civic Information API key first.');
  const qs = Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  let r;
  try { r = await httpGet(`${API}/${endpoint}?${qs}&key=${encodeURIComponent(key)}`); }
  catch (e) { throw new Error('Could not reach Google Civic (' + String(e.message || e).replace(key, '…') + '). Try again in a minute.'); }
  if (r.status !== 200) { const e = new Error(googleError(r.status, r.body)); e.status = r.status; throw e; }
  try { return JSON.parse(r.body); } catch { throw new Error('Google Civic returned something unreadable.'); }
}

// Which election to ask about: the soonest real one that covers the user's state. Pure.
function pickElection(elections, abbr, today) {
  const st = String(abbr || '').toLowerCase();
  const ok = (elections || []).filter(e => e && e.id && String(e.id) !== '2000' && e.electionDay && e.electionDay >= today);
  const scoped = d => (d.ocdDivisionId || '').includes('state:') ? (d.ocdDivisionId.includes('state:' + st) ? 2 : 0) : 1;
  return ok.filter(e => scoped(e) > 0).sort((a, b) => a.electionDay.localeCompare(b.electionDay) || scoped(b) - scoped(a))[0] || null;
}

function addressLine(a) {
  if (!a) return '';
  const place = [a.city && a.state ? `${clean(a.city)}, ${clean(a.state)}` : clean(a.city || a.state), clean(a.zip)].filter(Boolean).join(' ');
  return [clean(a.locationName), clean(a.line1), place].filter(Boolean).join(', ');
}
function siteOf(s) {
  return { name: clean(s.address && s.address.locationName) || 'Voting site', address: addressLine({ ...s.address, locationName: '' }), hours: clean(s.pollingHours), start: clean(s.startDate), end: clean(s.endDate), notes: clean(s.notes) };
}

// Google's voterInfo response -> the compact shape the card shows. Pure. The street address is never part of it.
function normalizeVoterInfo(j) {
  const election = { id: String(j.election && j.election.id || ''), name: clean(j.election && j.election.name), day: clean(j.election && j.election.electionDay) };
  const contests = (j.contests || []).map(c => {
    const district = clean(c.district && c.district.name);
    const scope = clean(c.district && c.district.scope);
    const isMeasure = !!(c.referendumTitle || /referend/i.test(c.type || ''));
    const title = isMeasure ? clean(c.referendumTitle) || clean(c.referendumSubtitle) || 'Ballot measure' : clean(c.office) || 'Contest';
    const out = {
      id: sha([election.id, isMeasure ? 'm' : 'c', title, district].join('|')),
      kind: isMeasure ? 'measure' : 'race', title, district, scope,
      level: /^(statewide|congressional|stateUpper|stateLower)$/i.test(scope) ? (scope === 'statewide' ? 'state' : 'district') : (scope ? 'local' : ''),
    };
    if (isMeasure) {
      Object.assign(out, {
        subtitle: clean(c.referendumSubtitle), text: cleanBlock(c.referendumText), pro: cleanBlock(c.referendumProStatement), con: cleanBlock(c.referendumConStatement),
        url: httpsUrl(c.referendumUrl), responses: (c.referendumBallotResponses || []).map(clean).filter(Boolean),
      });
    } else {
      out.seats = Number(c.numberElected) || 0;
      out.candidates = (c.candidates || []).map(k => ({ name: clean(k.name), party: clean(k.party), url: httpsUrl(k.candidateUrl) })).filter(k => k.name);
    }
    return out;
  });
  const body = ((j.state || [])[0] || {}).electionAdministrationBody || {};
  const local = ((((j.state || [])[0] || {}).local_jurisdiction) || {}).electionAdministrationBody || {};
  const office = x => ({
    name: clean(x.name), infoUrl: httpsUrl(x.electionInfoUrl), registrationUrl: httpsUrl(x.electionRegistrationUrl), checkUrl: httpsUrl(x.electionRegistrationConfirmationUrl),
    absenteeUrl: httpsUrl(x.absenteeVotingInfoUrl), finderUrl: httpsUrl(x.votingLocationFinderUrl), ballotUrl: httpsUrl(x.ballotInfoUrl),
  });
  const officials = { state: office(body), local: office(local) };
  const first = k => officials.local[k] || officials.state[k];
  return {
    election, contests,
    polling: (j.pollingLocations || []).slice(0, 3).map(siteOf),
    early: (j.earlyVoteSites || []).slice(0, 40).map(siteOf),
    dropOff: (j.dropOffLocations || []).slice(0, 40).map(siteOf),
    mailOnly: !!j.mailOnly,
    officials: { ...officials, name: officials.local.name || officials.state.name, infoUrl: first('infoUrl'), registrationUrl: first('registrationUrl'), checkUrl: first('checkUrl'), absenteeUrl: first('absenteeUrl'), finderUrl: first('finderUrl'), ballotUrl: first('ballotUrl') },
  };
}

async function lookup(address, remember) {
  const prof = profile();
  if (!prof) throw new Error('Look up your address in Civic first.');
  const addr = clean(address);
  if (addr.length < 8 || !/\d/.test(addr)) throw new Error('Enter your full street address: number, street, city, state and ZIP.');
  const abbr = prof.jurisdictions && prof.jurisdictions.state && prof.jurisdictions.state.abbr;
  const list = await callGoogle('elections', {});
  const el = pickElection(list.elections, abbr, todayStr());
  if (!el) throw new Error('Google does not list an upcoming election for your state yet. Try again closer to the election.');
  const info = await callGoogle('voterinfo', { address: addr, electionId: el.id });
  const ballot = { ...normalizeVoterInfo(info), fetchedAt: new Date(nowMs()).toISOString() };
  if (!ballot.election.day) ballot.election.day = el.electionDay;
  if (!ballot.election.name) ballot.election.name = clean(el.name);
  db.ballot = ballot;
  db.placeKey = placeKeyOf(prof.jurisdictions);
  db.address = remember ? addr : '';
  saveNow();
  return ballot;
}
async function refresh() {
  if (!db.address) throw new Error('Enter your address again to refresh your ballot (it was not remembered).');
  return lookup(db.address, true);
}

const placeKeyOf = j => [j && j.state && j.state.geoid, j && j.county && j.county.geoid, j && j.place && j.place.geoid].join('|');
function clearAll() { db = { placeKey: '', address: '', ballot: null, explain: {} }; saveNow(); }
function placeChanged(jurisdictions) { const k = placeKeyOf(jurisdictions); if (db.placeKey && db.placeKey !== k) clearAll(); }
function forget() { db.ballot = null; db.address = ''; db.placeKey = ''; saveNow(); }

// ─── Plain-language notes ────────────────────────────────────────────────────

function explainPrompt(m) {
  return [
    'You explain a ballot measure to a voter in plain, neutral language. Use ONLY the official text below. Do not recommend a vote, do not say whether the measure is good or bad, and do not add facts that are not in the text.',
    'Write exactly three short parts, each starting with its label:',
    'What it is: one or two sentences.',
    'A yes vote means: one sentence.',
    'A no vote means: one sentence.',
    'If the text does not say what a yes or no vote does, write "The official text does not say." for that part.',
    '', `Title: ${m.title}`, m.subtitle ? `Subtitle: ${m.subtitle}` : '', `Official text:\n${m.text.slice(0, 5000)}`,
  ].filter(x => x !== '').join('\n');
}
async function explain(id) {
  const m = db.ballot && db.ballot.contests.find(c => c.id === id && c.kind === 'measure');
  if (!m) throw new Error('That measure is no longer on your ballot. Refresh and try again.');
  if (!m.text) throw new Error('The official text is not published in the data yet, so there is nothing to explain.');
  const cached = db.explain[id];
  if (cached && cached.sig === sha(m.text)) return cached;
  const ask = ctx.ollamaText || require('./relevance').ollamaText;
  let out;
  try { out = await ask(explainPrompt(m), { timeoutMs: 90000, numPredict: 400 }); }
  catch { throw new Error('The local model is not answering, so no summary was made. The official text is still shown.'); }
  const text = cleanBlock(String(out || '').replace(/<think>[\s\S]*?<\/think>/g, ''));
  if (text.length < 20) throw new Error('The local model gave no usable summary. Try again.');
  const note = { text, sig: sha(m.text), at: new Date(nowMs()).toISOString() };
  db.explain[id] = note;
  saveNow();
  return note;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

function status() {
  const prof = profile();
  const stale = db.ballot && db.placeKey && prof && db.placeKey !== placeKeyOf(prof.jurisdictions);
  const ballot = db.ballot && !stale ? { ...db.ballot, explain: db.explain, stale: nowMs() - Date.parse(db.ballot.fetchedAt || 0) > REFRESH_MS } : null;
  return { hasProfile: !!prof, hasKey: !!apiKey(), remembered: !!db.address, schedule: scheduleFor(prof, ballot, todayStr()), ballot };
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n < 20000) chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

async function route(req, reqUrl, res, send) {
  const sub = reqUrl.pathname.replace(/^\/api\/lateral/, '').replace(/^\/civic\/ballot\/?/, '');
  try {
    if (req.method === 'GET' && (sub === 'status' || sub === '')) return send(res, 200, status());
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (sub === 'lookup') { await lookup(body.address, !!body.remember); return send(res, 200, status()); }
      if (sub === 'refresh') { await refresh(); return send(res, 200, status()); }
      if (sub === 'forget') { forget(); return send(res, 200, status()); }
      if (sub === 'explain') return send(res, 200, { note: await explain(String(body.id || '')) });
    }
  } catch (e) { return send(res, 200, { error: e.message, ...status() }); }
  return send(res, 404, { error: 'Unknown ballot route.' });
}

module.exports = {
  route, status, lookup, refresh, forget, explain, clearAll, placeChanged,
  // exported for tests
  scheduleFor, federalGeneralDay, nextGeneralDay, pickElection, normalizeVoterInfo, googleError, explainPrompt, STATE_PLANS,
  init: c => { ctx = { ...ctx, ...(c || {}) }; },
  _reset: () => { db = { placeKey: '', address: '', ballot: null, explain: {} }; },
};
