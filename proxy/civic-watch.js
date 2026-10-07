'use strict';
// Civic mode, part 2: watching. Four optional watches, each backing one ordinary Lateral story, so it gets headlines, alerts and
// feed output like any other story. Nothing is created until the person presses Watch on the Civic page.
//
//   council     your city council's legislation and meetings, from the council's Legistar site (keyless)
//   delegation  bills sponsored by your members of Congress, from Congress.gov (works keyless on a shared, limited demo key;
//               a free personal key lifts the limit)
//   state       bills sponsored by your state senator and representative, from Open States (needs a free key)
//   rules       federal proposed and final rules on topics you choose, from the Federal Register (keyless), with comment deadlines
//
// A story linked to a watch gets its items merged into its headlines by the server's background refresh (see server.js), and
// alerts.js calls collect() every hour for events: a bill that passed or was signed, a meeting tomorrow, a comment period closing.
//
// Routes (all under /api/lateral/civic/):
//   GET  watch/list                    the watches available for your profile, whether each is on, and key status
//   GET  watch/items?kind=             the current items of one watch (articles shaped like the app's headlines)
//   POST watch/link {kind,storyId,topics?}   remember which story backs a watch
//   POST watch/unlink {kind}           stop watching (the story stays in your list)
//   POST watch/topics {topics}         set the Federal Register topics
//   POST watch/key {which,key}         save an optional key (which: congress | openstates); empty removes it
//   POST watch/key/test {which}        check a saved key

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.LATERAL_DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'civic-watch.json');
const LEGISTAR = 'https://webapi.legistar.com/v1';
const CONGRESS = 'https://api.congress.gov/v3';
const OPENSTATES = 'https://v3.openstates.org';
const FEDREG = 'https://www.federalregister.gov/api/v1';
const MAX_TOPICS = 5;
const HOUR = 3600000;

const civic = () => require('./civic');
// Test hook: stand-ins for the network.
let ctx = {};
const getJson = (url, opts) => (ctx.getJson || civic().getJson)(url, opts);

// ─── Storage ─────────────────────────────────────────────────────────────────
// watches: { kind: { storyId, at, topics? } }; keys: optional API keys (never exported); seen: what has already been reported;
// cache: the last fetch per kind, so the rate-limited sources are not hit on every refresh.

let db = (() => {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { watches: j.watches || {}, topics: j.topics || [], keys: j.keys || {}, seen: j.seen || {}, cache: j.cache || {} }; }
  catch { return { watches: {}, topics: [], keys: {}, seen: {}, cache: {} }; }
})();
let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 500);
}
function saveNow() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, FILE); } catch { /* next change */ }
}

const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const dayOf = v => { const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ''; };
const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

function readStoryIds() {
  try { return new Set((JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'stories.json'), 'utf8')).stories || []).map(s => s.id)); } catch { return null; }
}

// ─── Keys ────────────────────────────────────────────────────────────────────

const KEY_INFO = {
  congress: { env: 'CONGRESS_API_KEY', demo: 'DEMO_KEY', label: 'Congress.gov', signup: 'https://api.congress.gov/sign-up/' },
  openstates: { env: 'OPENSTATES_API_KEY', demo: '', label: 'Open States', signup: 'https://open.pluralpolicy.com/accounts/profile/' },
};
function keyFor(which) { const i = KEY_INFO[which]; return (i && (db.keys[which] || process.env[i.env] || '')).trim(); }
function keyStatus() {
  return Object.fromEntries(Object.entries(KEY_INFO).map(([k, i]) => [k, { label: i.label, configured: !!keyFor(k), usesDemo: k === 'congress' && !keyFor(k), signup: i.signup }]));
}

// ─── Items: normalisers (pure) ───────────────────────────────────────────────

const BILL_PATH = { HR: 'house-bill', S: 'senate-bill', HRES: 'house-resolution', SRES: 'senate-resolution', HJRES: 'house-joint-resolution', SJRES: 'senate-joint-resolution', HCONRES: 'house-concurrent-resolution', SCONRES: 'senate-concurrent-resolution' };
const BILL_LABEL = { HR: 'H.R.', S: 'S.', HRES: 'H.Res.', SRES: 'S.Res.', HJRES: 'H.J.Res.', SJRES: 'S.J.Res.', HCONRES: 'H.Con.Res.', SCONRES: 'S.Con.Res.' };
// A latest-action line that means something happened to the bill itself, not just committee paperwork.
const MILESTONE = /\b(passed|agreed to|became public law|signed by (the )?(president|governor)|presented to (the )?president|enacted|vetoed|veto|override|ordered to be reported|failed|adopted|approved|effective)\b/i;

function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

function matterItem(slug, m) {
  const file = m.MatterFile || '';
  const title = clip(m.MatterTitle || m.MatterName || file, 200);
  return {
    id: `matter:${m.MatterId}`, kind: 'legislation',
    title: file ? `${file}: ${title}` : title,
    url: `https://${slug}.legistar.com/LegislationDetail.aspx?ID=${m.MatterId}&GUID=${m.MatterGuid}`,
    date: dayOf(m.MatterLastModifiedUtc) || dayOf(m.MatterIntroDate),
    snippet: [m.MatterTypeName, m.MatterStatusName, m.MatterBodyName].filter(Boolean).join(' · '),
    status: m.MatterStatusName || '',
    sig: [m.MatterStatusName, dayOf(m.MatterPassedDate), dayOf(m.MatterEnactmentDate)].join('|'),
    milestoneAt: dayOf(m.MatterEnactmentDate) || dayOf(m.MatterPassedDate),
    milestone: m.MatterEnactmentDate ? 'was enacted' : m.MatterPassedDate ? 'passed' : '',
  };
}
function eventItem(slug, e) {
  const day = dayOf(e.EventDate), body = e.EventBodyName || 'Meeting';
  return {
    id: `event:${e.EventId}`, kind: 'meeting', bodyName: body, time: e.EventTime || '',
    title: `${body}: ${niceDay(day)}${e.EventTime ? ', ' + e.EventTime : ''}`,
    url: e.EventInSiteURL || `https://${slug}.legistar.com/Calendar.aspx`,
    date: day, snippet: [e.EventLocation, e.EventAgendaStatusName ? `Agenda ${String(e.EventAgendaStatusName).toLowerCase()}` : ''].filter(Boolean).join(' · '),
    meetingOn: day, sig: [e.EventAgendaStatusName, e.EventAgendaLastPublishedUTC].join('|'),
  };
}
function billItem(member, b) {
  const type = String(b.type || '').toUpperCase(), la = b.latestAction || {};
  const label = `${BILL_LABEL[type] || type} ${b.number}`;
  return {
    id: `bill:${b.congress}-${type}-${b.number}`, kind: 'bill',
    title: `${label}: ${clip(b.title, 190)}`,
    url: BILL_PATH[type] ? `https://www.congress.gov/bill/${ordinal(b.congress)}-congress/${BILL_PATH[type]}/${b.number}` : `https://www.congress.gov/search?q=${encodeURIComponent(label)}`,
    date: dayOf(la.actionDate) || dayOf(b.introducedDate),
    snippet: `Sponsored by ${member}. ${la.text ? 'Latest action: ' + clip(la.text, 160) : ''}`.trim(),
    sig: String(la.text || ''), milestone: MILESTONE.test(la.text || '') ? clip(la.text, 120) : '',
    milestoneAt: dayOf(la.actionDate),
  };
}
function stateBillItem(b, who) {
  const la = b.latest_action_description || '';
  return {
    id: `os:${b.id}`, kind: 'bill',
    title: `${b.identifier}: ${clip(b.title, 190)}`,
    url: b.openstates_url || '',
    date: dayOf(b.latest_action_date) || dayOf(b.first_action_date) || dayOf(b.updated_at),
    snippet: `Sponsored by ${who}. ${la ? 'Latest action: ' + clip(la, 160) : ''}`.trim(),
    sig: la, milestone: MILESTONE.test(la) ? clip(la, 120) : '', milestoneAt: dayOf(b.latest_action_date),
  };
}
function ruleItem(d) {
  const agencies = (d.agency_names || []).join(', ');
  return {
    id: `fr:${d.document_number || sha(d.html_url)}`, kind: 'rule',
    title: clip(d.title, 220), url: d.html_url, date: dayOf(d.publication_date),
    snippet: [agencies, d.type, d.comments_close_on ? `comments close ${dayOf(d.comments_close_on)}` : ''].filter(Boolean).join(' · '),
    deadline: dayOf(d.comments_close_on), sig: '',
  };
}

// An item as one of the app's headline articles.
function toArticle(it, sourceName) {
  return {
    title: it.title, url: it.url, realUrl: it.url, date: it.date || new Date().toISOString().slice(0, 10), snippet: it.snippet || '',
    source: { name: sourceName, domain: hostOf(it.url), engine: 'civic' },
    civic: { kind: it.kind, ...(it.kind === 'bill' || it.kind === 'legislation' ? { item: it.id } : {}), ...(it.deadline ? { deadline: it.deadline } : {}), ...(it.meetingOn ? { meetingOn: it.meetingOn } : {}), ...(it.status ? { status: it.status } : {}) },
  };
}

// ─── Items: fetchers ─────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchCouncil(profile) {
  const loc = profile.local;
  if (!loc || !loc.slug || !loc.confirmed) throw new Error('Confirm your city council on the Civic page first.');
  const [matters, events] = await Promise.all([
    getJson(`${LEGISTAR}/${loc.slug}/matters?$top=30&$orderby=MatterLastModifiedUtc%20desc`, { timeout: 25000 }),
    getJson(`${LEGISTAR}/${loc.slug}/events?$top=60&$orderby=EventDate%20desc`, { timeout: 25000 }).catch(() => []),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = (Array.isArray(events) ? events : []).filter(e => dayOf(e.EventDate) >= today).map(e => eventItem(loc.slug, e)).sort((a, b) => a.date.localeCompare(b.date));
  return { name: `${loc.body || 'City council'} (Legistar)`, items: [...upcoming, ...(Array.isArray(matters) ? matters : []).map(m => matterItem(loc.slug, m))] };
}

async function fetchDelegation(profile) {
  const members = (profile.officials || []).filter(o => o.level === 'federal' && o.bioguide);
  if (!members.length) throw new Error('No members of Congress in your profile.');
  const key = keyFor('congress') || KEY_INFO.congress.demo;
  const out = [];
  let failed = 0, lastErr = '';
  for (const m of members) {
    try {
      const j = await getJson(`${CONGRESS}/member/${m.bioguide}/sponsored-legislation?limit=8&format=json&api_key=${encodeURIComponent(key)}`, { timeout: 25000 });
      for (const b of j.sponsoredLegislation || []) out.push(billItem(m.name, b));
    } catch (e) { failed++; lastErr = e.message; }
    await sleep(ctx.noSleep ? 0 : 250);
  }
  if (failed === members.length) {
    throw new Error(/429/.test(lastErr) ? 'Congress.gov\'s shared demo key is limited to about 10 requests an hour. Add a free personal key to lift that limit.' : `Congress.gov did not answer (${lastErr}).`);
  }
  return { name: 'Congress.gov', items: out };
}

async function fetchState(profile) {
  const key = keyFor('openstates');
  if (!key) { const e = new Error('Bills from your state legislators need a free Open States key.'); e.needsKey = 'openstates'; throw e; }
  const st = profile.jurisdictions && profile.jurisdictions.state;
  const people = (profile.officials || []).filter(o => o.level === 'state' && o.osId && /State (Senator|Representative)/.test(o.office));
  if (!st || !people.length) throw new Error('No state legislators in your profile.');
  const out = [];
  let failed = 0, lastErr = '';
  for (const p of people) {
    try {
      const j = await getJson(`${OPENSTATES}/bills?jurisdiction=${encodeURIComponent(st.name)}&sponsor=${encodeURIComponent(p.osId)}&sort=latest_action_desc&per_page=8`, { timeout: 25000, headers: { 'X-API-KEY': key } });
      for (const b of j.results || []) out.push(stateBillItem(b, p.name));
    } catch (e) { failed++; lastErr = e.message; }
    await sleep(ctx.noSleep ? 0 : 250);
  }
  if (failed === people.length) throw new Error(/40[13]/.test(lastErr) ? 'Open States rejected the key. Check it on the Civic page.' : /429/.test(lastErr) ? 'Open States says the key is over its daily limit; try again later.' : `Open States did not answer (${lastErr}).`);
  return { name: `Open States (${st.name})`, items: out };
}

async function fetchRules(topics) {
  const list = (topics || []).filter(Boolean).slice(0, MAX_TOPICS);
  if (!list.length) throw new Error('Choose at least one topic first.');
  const out = [], seen = new Set();
  for (const t of list) {
    const url = `${FEDREG}/documents.json?conditions[term]=${encodeURIComponent(t)}&conditions[type][]=PRORULE&conditions[type][]=RULE&order=newest&per_page=8` +
      '&fields[]=title&fields[]=html_url&fields[]=comments_close_on&fields[]=publication_date&fields[]=agency_names&fields[]=type&fields[]=document_number';
    const j = await getJson(url, { timeout: 25000 });
    for (const d of j.results || []) { const it = ruleItem(d); if (!seen.has(it.id)) { seen.add(it.id); out.push(it); } }
  }
  return { name: 'Federal Register', items: out };
}

const TTL = { council: 30 * 60000, delegation: 6 * HOUR, state: 3 * HOUR, rules: 3 * HOUR };

// Fetch (or reuse) one watch's items. Falls back to the last good copy when a source is down or rate-limited.
async function fetchKind(kind, { fresh = false } = {}) {
  const profile = civic().profile();
  if (!profile) throw new Error('No Civic profile yet.');
  const ttl = kind === 'delegation' && keyFor('congress') ? 2 * HOUR : TTL[kind];
  const hit = db.cache[kind];
  if (hit && !fresh && Date.now() - hit.at < ttl) return { ...hit, cached: true };
  try {
    const r = kind === 'council' ? await fetchCouncil(profile) : kind === 'delegation' ? await fetchDelegation(profile)
      : kind === 'state' ? await fetchState(profile) : kind === 'rules' ? await fetchRules(db.topics) : null;
    if (!r) throw new Error('Unknown watch.');
    db.cache[kind] = { at: Date.now(), name: r.name, items: r.items };
    saveSoon();
    return { ...db.cache[kind] };
  } catch (e) {
    if (hit) return { ...hit, cached: true, stale: true, error: e.message };
    throw e;
  }
}

// ─── Definitions: what can be watched for this profile ───────────────────────

function definitions(profile) {
  if (!profile) return [];
  const j = profile.jurisdictions || {}, place = j.place && j.place.name, st = j.state && j.state.name;
  const members = (profile.officials || []).filter(o => o.level === 'federal');
  const legislators = (profile.officials || []).filter(o => o.level === 'state' && /State (Senator|Representative)/.test(o.office));
  const council = profile.local && profile.local.confirmed;
  const defs = [];
  defs.push({
    id: 'council', title: `${place || 'City'} council: legislation and meetings`,
    blurb: council ? 'New and changed ordinances and resolutions, and upcoming meetings, read from the council\'s own site.' : 'Confirm your city council above to watch its legislation and meetings.',
    available: !!(council && place), tags: ['civic', 'local government', place].filter(Boolean), actors: [profile.local && profile.local.body].filter(Boolean),
    summary: `Tracks the ${(profile.local && profile.local.body) || 'city council'} of ${place || 'your city'}: new and changed legislation and upcoming meetings, read from its Legistar site, plus local news. Part of your Civic profile.`,
  });
  defs.push({
    id: 'delegation', title: `${st || 'Your state'}'s delegation: bills in Congress`,
    blurb: 'Bills your representative and senators have introduced, with their latest action. Works without a key, but the shared demo key is limited; a free key removes the limit.',
    available: members.length > 0, tags: ['civic', 'congress', st].filter(Boolean), actors: members.map(m => m.name),
    summary: `Follows bills sponsored by ${members.map(m => m.name).join(', ') || 'your members of Congress'}, with each bill's latest action, plus news. Part of your Civic profile.`,
    keyKind: 'congress',
  });
  defs.push({
    id: 'state', title: `${st || 'State'} legislators: their bills`,
    blurb: 'Bills sponsored by your state senator and representative, with their latest action. Needs a free Open States key.',
    available: legislators.length > 0 && !!st, needsKey: keyFor('openstates') ? '' : 'openstates', tags: ['civic', 'state legislature', st].filter(Boolean), actors: legislators.map(m => m.name),
    summary: `Follows bills sponsored by ${legislators.map(m => m.name).join(', ') || 'your state legislators'}, with each bill's latest action, plus news. Part of your Civic profile.`,
    keyKind: 'openstates',
  });
  defs.push({
    id: 'rules', title: 'Federal rules I follow',
    blurb: 'Proposed and final federal rules on topics you choose, with public-comment deadlines.',
    available: true, needsTopics: !(db.topics && db.topics.length), topics: db.topics.slice(), tags: ['civic', 'federal rules', ...db.topics.slice(0, 3)], actors: [],
    summary: `Follows federal proposed and final rules about ${db.topics.join(', ') || 'your chosen topics'}, with public-comment deadlines, from the Federal Register, plus news. Part of your Civic profile.`,
  });
  return defs;
}

function list() {
  const profile = civic().profile();
  const ids = readStoryIds();
  const defs = definitions(profile).map(d => {
    const w = db.watches[d.id];
    // A watch whose story was deleted quietly stops being a watch. (A brand-new link gets a grace period: the app saves a new
    // story a moment after creating it.)
    if (w && ids && !ids.has(w.storyId) && Date.now() - (Date.parse(w.at) || 0) > 2 * 60000) { delete db.watches[d.id]; saveSoon(); }
    const live = db.watches[d.id];
    return { ...d, watching: !!live, storyId: live ? live.storyId : '' };
  });
  return { watches: defs, keys: keyStatus(), topics: db.topics.slice(), hasProfile: !!profile };
}

// ─── Linking ─────────────────────────────────────────────────────────────────

function link(kind, storyId, topics) {
  if (!['council', 'delegation', 'state', 'rules'].includes(kind)) throw new Error('Unknown watch.');
  if (!storyId) throw new Error('A story is required.');
  if (kind === 'rules' && Array.isArray(topics)) setTopics(topics);
  db.watches[kind] = { storyId: String(storyId), at: new Date().toISOString() };
  delete db.seen[kind];            // the first look after linking is the baseline, never an alert
  saveSoon();
  return list();
}
function unlink(kind) { delete db.watches[kind]; delete db.seen[kind]; saveSoon(); return list(); }
function setTopics(topics) {
  const clean = [...new Set((Array.isArray(topics) ? topics : String(topics || '').split(',')).map(t => String(t).replace(/\s+/g, ' ').trim()).filter(t => t.length >= 2 && t.length <= 60))].slice(0, MAX_TOPICS);
  db.topics = clean;
  delete db.cache.rules;
  saveSoon();
  return clean;
}

// For the background refresh in server.js.
const hasWatch = storyId => Object.values(db.watches).some(w => w.storyId === storyId);
async function itemsForStory(storyId) {
  const out = [], errors = [];
  for (const [kind, w] of Object.entries(db.watches)) {
    if (w.storyId !== storyId) continue;
    try { const r = await fetchKind(kind); out.push(...r.items.map(i => toArticle(i, r.name))); if (r.error) errors.push({ kind, error: r.error }); }
    catch (e) { errors.push({ kind, error: e.message }); }
  }
  out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { items: out, errors };
}

// ─── Alerts: what is worth telling the person ────────────────────────────────

const daysUntil = (day, now) => Math.round((Date.parse(day + 'T12:00:00Z') - Date.parse(now.toISOString().slice(0, 10) + 'T12:00:00Z')) / 86400000);
const niceDay = day => { try { return new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); } catch { return day; } };

// Candidate events for every linked watch. Keyed events (meetings, deadlines, milestones) fire once per key; the caller keeps
// track. "activity" events are the ordinary new-and-changed items for a digest.
async function collect(now = new Date()) {
  const events = [];
  for (const [kind, w] of Object.entries(db.watches)) {
    let r;
    try { r = await fetchKind(kind); } catch { continue; }
    const items = r.items || [];
    const first = !db.seen[kind];
    const seen = db.seen[kind] = db.seen[kind] || {};
    const fresh = [], changed = [];
    for (const it of items) {
      const prev = seen[it.id];
      if (!prev) { if (!first) fresh.push(it); }
      else if (prev.sig !== it.sig) changed.push(it);
      seen[it.id] = { sig: it.sig, at: (prev && prev.at) || now.toISOString() };

      if (it.kind === 'meeting' && it.meetingOn) {
        const d = daysUntil(it.meetingOn, now);
        if (d >= 0 && d <= 1) events.push({ key: `civic:meeting:${it.id}:1d`, kind: 'civic-meeting', severity: 'info', storyId: w.storyId,
          title: `${clip(it.bodyName, 60)} ${d === 0 ? 'meets today' : 'meets tomorrow'}`, body: `${niceDay(it.meetingOn)}${it.time ? ' at ' + it.time : ''}.\n${it.snippet ? it.snippet + '\n' : ''}${it.url}`.trim() });
      }
      if (it.kind === 'rule' && it.deadline) {
        const d = daysUntil(it.deadline, now);
        if (d >= 0 && d <= 7) {
          const bucket = d <= 1 ? '1d' : '7d';
          events.push({ key: `civic:deadline:${it.id}:${bucket}`, kind: 'civic-deadline', severity: d <= 1 ? 'important' : 'info', storyId: w.storyId,
            title: `Public comment closes ${d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`}: a federal rule`,
            body: `${clip(it.title, 150)}\n${it.snippet}\nComment at regulations.gov or through the link: ${it.url}` });
        }
      }
      // A bill or ordinance that reached a milestone since the person last looked.
      const reached = (prev && prev.sig !== it.sig) || (!prev && !first);
      if (reached && it.milestone && it.kind !== 'rule' && it.kind !== 'meeting') {
        events.push({ key: `civic:vote:${it.id}:${sha(it.sig)}`, kind: 'civic-vote', severity: 'important', storyId: w.storyId,
          title: `${it.kind === 'legislation' ? 'City legislation' : 'A bill'} ${/enacted|public law|signed/i.test(it.milestone) ? 'became law' : 'moved'}: ${clip(it.title.split(':')[0], 40)}`,
          body: `${clip(it.title, 160)}\n${it.milestone}\n${it.url}` });
      }
    }
    // keep the memory bounded
    const ids = Object.keys(seen);
    if (ids.length > 600) for (const id of ids.slice(0, ids.length - 600)) delete seen[id];
    const activity = [...fresh, ...changed].filter(i => i.kind !== 'meeting');
    if (activity.length) {
      events.push({ kind: 'civic-activity', severity: 'info', storyId: w.storyId, activity: true, count: activity.length,
        title: `${clip(r.name.replace(/ \(.*$/, ''), 40)}: ${activity.length} new or updated item${activity.length === 1 ? '' : 's'}`,
        body: activity.slice(0, 4).map(i => `• ${clip(i.title, 100)}`).join('\n') });
    }
  }
  saveSoon();
  return events;
}

// ─── Keys: save and test ─────────────────────────────────────────────────────

function setKey(which, value) {
  if (!KEY_INFO[which]) throw new Error('Unknown key.');
  const v = String(value || '').trim();
  if (v && !/^[A-Za-z0-9_\-]{12,120}$/.test(v)) throw new Error('That does not look like an API key. Paste just the key, with no spaces.');
  if (v) db.keys[which] = v; else delete db.keys[which];
  delete db.cache[which === 'congress' ? 'delegation' : 'state'];
  saveSoon();
  return keyStatus();
}
async function testKey(which) {
  const key = keyFor(which);
  if (!key) throw new Error('No key saved yet.');
  try {
    if (which === 'congress') await getJson(`${CONGRESS}/bill?limit=1&format=json&api_key=${encodeURIComponent(key)}`, { timeout: 15000 });
    else await getJson(`${OPENSTATES}/jurisdictions?per_page=1`, { timeout: 15000, headers: { 'X-API-KEY': key } });
    return { ok: true };
  } catch (e) {
    if (/40[13]/.test(e.message)) return { ok: false, error: 'The service rejected this key.' };
    return { ok: false, error: `Could not check it: ${e.message}` };
  }
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

// Returns false when the path is not a watch route.
async function route(req, reqUrl, res, send) {
  const p = reqUrl.pathname.replace(/^\/api\/lateral/, '');
  if (!p.startsWith('/civic/watch')) return false;
  const sub = p.slice('/civic/watch'.length).replace(/^\//, '');
  try {
    if (req.method === 'GET' && sub === 'list') return send(res, 200, list());
    if (req.method === 'GET' && sub === 'items') {
      const kind = String(reqUrl.searchParams.get('kind') || '');
      const r = await fetchKind(kind, { fresh: reqUrl.searchParams.get('fresh') === '1' });
      return send(res, 200, { items: r.items.map(i => toArticle(i, r.name)), stale: !!r.stale, error: r.error || '' });
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (sub === 'link') return send(res, 200, link(String(b.kind || ''), String(b.storyId || ''), b.topics));
      if (sub === 'unlink') return send(res, 200, unlink(String(b.kind || '')));
      if (sub === 'topics') { setTopics(b.topics); return send(res, 200, list()); }
      if (sub === 'key') { setKey(String(b.which || ''), b.key); return send(res, 200, list()); }
      if (sub === 'key/test') return send(res, 200, await testKey(String(b.which || '')));
    }
  } catch (e) { return send(res, 200, { error: e.message, needsKey: e.needsKey || '' }); }
  return send(res, 404, { error: 'Unknown watch route.' });
}

module.exports = {
  route, list, link, unlink, collect, hasWatch, itemsForStory, fetchKind, keyStatus, keyFor,
  init: c => { ctx = { ...ctx, ...(c || {}) }; },
  // for tests
  matterItem, eventItem, billItem, stateBillItem, ruleItem, toArticle, definitions, setTopics, setKey, MILESTONE,
  _reset: () => { db = { watches: {}, topics: [], keys: {}, seen: {}, cache: {} }; ctx = {}; },
  _db: () => db,
};
