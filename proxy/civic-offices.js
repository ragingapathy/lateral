'use strict';
// Civic mode: local offices beyond the city council. Mayor, county commissioners or executive, county judges, the sheriff and the
// school board have no single free, complete nationwide data source, so this is honest about how each one is found:
//
//   mayor        Wikidata (free, keyless, volunteer-edited, so it can lag an election). Looked up automatically with the profile.
//   the others   an opt-in web search that asks a plain question ("Who is the sheriff of Example County, Ohio?"), shows the answer,
//                its sources and the names it found, and saves NOTHING until you confirm each one (uses one Tavily credit).
//   anything     added by hand: name, office, and optional contact details.
//
// Every entry says where it came from, and a person you removed is not quietly put back by a refresh. This file holds the pure
// parts (the catalogue, the Wikidata query, the search, the name checks); civic.js stores the entries and serves the routes.

const WIKIDATA = 'https://query.wikidata.org/sparql';

const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { s = clean(s); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const norm = s => clean(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const sparqlString = s => clean(s).replace(/[^A-Za-z0-9 .'À-ɏ-]/g, '').replace(/"/g, '');

// ─── The catalogue ───────────────────────────────────────────────────────────

// A place name like "Toledo city" is the same city as "Toledo".
const bareName = s => clean(s).replace(/\s+(city|town|village|borough|township|CDP)$/i, '');

function catalogFor(profile) {
  if (!profile) return [];
  const j = profile.jurisdictions || {};
  const place = j.place && bareName(j.place.name), county = j.county && clean(j.county.name), st = j.state && j.state.name;
  const school = (j.schoolDistricts && j.schoolDistricts[0] && clean(j.schoolDistricts[0].name)) || '';
  const where = [county, st].filter(Boolean).join(', ');
  return [
    { id: 'mayor', office: 'Mayor', title: 'Mayor', available: !!place, via: 'wikidata', body: place ? `City of ${place}` : '', multi: false,
      hint: place ? `Looked up automatically from Wikidata for ${place}. It is edited by volunteers and can lag an election.` : 'Needs a city in your profile.' },
    { id: 'county-board', office: 'County Commissioner', title: 'County commissioners or executive', available: !!county, via: 'search', body: county ? `${county} government` : '', multi: true,
      question: `Who are the current members of the board of county commissioners (or the county executive and county council) of ${where}?`,
      hint: 'Search the web for the people who run the county.' },
    { id: 'city-manager', office: 'City Manager', title: 'City manager or administrator', available: !!place, via: 'search', body: place ? `City of ${place}` : '', multi: false,
      question: `Who is the current city manager (or city administrator) of ${place}, ${st}?`,
      hint: 'For cities run by an appointed manager rather than (or alongside) a mayor.' },
    { id: 'county-officers', office: 'County Officer', officeFromRole: true, title: 'Other county officers', available: !!county, via: 'search', body: county ? `${county} government` : '', multi: true,
      question: `Who currently holds the county offices of ${where}: auditor, treasurer, clerk of courts or county clerk, recorder, prosecuting attorney, coroner and engineer? Give each person's office.`,
      hint: 'The auditor, treasurer, clerk, recorder, prosecutor, coroner and engineer. Each person keeps the office the source gives.' },
    { id: 'county-judges', office: 'County Judge', title: 'County judges', available: !!county, via: 'search', body: county ? `${county} courts` : '', multi: true,
      question: `Who are the current judges of the court of common pleas, county court or other county courts of ${where}?`,
      hint: 'Judges of the county courts (some states call the county executive a county judge, and that is fine too).' },
    { id: 'sheriff', office: 'County Sheriff', title: 'County sheriff', available: !!county, via: 'search', body: county ? `${county} Sheriff's Office` : '', multi: false,
      question: `Who is the current sheriff of ${where}?`,
      hint: 'Search the web for the elected sheriff.' },
    { id: 'school-board', office: 'School Board Member', title: 'School board', available: !!school, via: 'search', body: school ? `${school} board of education` : '', multi: true,
      question: school ? `Who are the current members of the board of education of ${school} in ${where}?` : '',
      hint: school ? `Search the web for the members of the ${school} board.` : 'Needs a school district in your profile.' },
  ];
}

// ─── Wikidata: the mayor ─────────────────────────────────────────────────────

// Pure: choose the mayor from SPARQL result rows. Several rows are fine (an official site, a Wikipedia link); several PEOPLE are
// only accepted when one clearly started last, otherwise it is better to show nothing than to guess.
function pickMayor(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const id = r.mayor && r.mayor.value;
    if (!id) continue;
    const e = by.get(id) || { id, name: '', start: '', article: '', site: '' };
    e.name = e.name || (r.mayorLabel && r.mayorLabel.value) || '';
    const st = r.start && r.start.value ? String(r.start.value).slice(0, 10) : '';
    if (st && st > e.start) e.start = st;
    e.article = e.article || (r.article && r.article.value) || '';
    e.site = e.site || (r.site && r.site.value) || '';
    by.set(id, e);
  }
  const all = [...by.values()].filter(e => e.name && !/^Q\d+$/.test(e.name));
  if (!all.length) return null;
  if (all.length > 1) {
    all.sort((a, b) => b.start.localeCompare(a.start));
    if (!all[0].start || all[0].start === all[1].start) return null;
  }
  const m = all[0];
  let wikipedia = '';
  try { wikipedia = decodeURIComponent(new URL(m.article).pathname.replace(/^\/wiki\//, '')).replace(/_/g, ' '); } catch { /* no article */ }
  return { name: clean(m.name), since: m.start, wikipedia, website: /^https?:\/\//i.test(m.site) ? m.site : '', entity: m.id };
}

function mayorQuery(place, county, state) {
  const areas = [county, state].filter(Boolean).map(a => `"${sparqlString(a)}"@en`).join(' ');
  return `SELECT ?mayor ?mayorLabel ?start ?article ?site WHERE {
  ?c rdfs:label "${sparqlString(place)}"@en ; wdt:P17 wd:Q30 ; wdt:P131+ ?area .
  VALUES ?areaLabel { ${areas} } ?area rdfs:label ?areaLabel .
  ?c p:P6 ?stmt . ?stmt ps:P6 ?mayor . FILTER NOT EXISTS { ?stmt pq:P582 ?end }
  OPTIONAL { ?stmt pq:P580 ?start }
  OPTIONAL { ?mayor wdt:P856 ?site }
  OPTIONAL { ?article schema:about ?mayor ; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
} LIMIT 20`;
}

async function wikidataMayor(getJson, profile) {
  const j = profile.jurisdictions || {};
  if (!j.place) return null;
  const q = mayorQuery(bareName(j.place.name), j.county && j.county.name, j.state && j.state.name);
  const res = await getJson(`${WIKIDATA}?format=json&query=${encodeURIComponent(q)}`, { timeout: 25000, headers: { Accept: 'application/sparql-results+json' } });
  const m = pickMayor((res && res.results && res.results.bindings) || []);
  if (!m) return null;
  return {
    officeId: 'mayor', office: 'Mayor', level: 'local', name: m.name, body: `City of ${bareName(j.place.name)}`, website: m.website, wikipedia: m.wikipedia,
    source: 'wikidata', sourceUrl: `https://www.wikidata.org/wiki/${m.entity.split('/').pop()}`, sourceNote: 'From Wikidata, which volunteers edit; it can lag an election.',
    ...(m.since ? { termStart: m.since } : {}),
  };
}

// ─── Web search for the other offices ────────────────────────────────────────

// Does this name really appear in the text it supposedly came from? (First and last words, in order, ignoring punctuation.)
function appearsIn(name, text) {
  const t = ' ' + norm(text) + ' ';
  const parts = norm(name).split(' ').filter(w => w.length > 1);
  if (parts.length < 2) return false;
  const first = parts[0], last = parts[parts.length - 1];
  return t.includes(' ' + first + ' ') && t.includes(' ' + last + ' ') && t.indexOf(' ' + first + ' ') <= t.lastIndexOf(' ' + last + ' ');
}

const NOT_A_PERSON = /\b(county|board|office|department|court|commission|commissioners|school|schools|district|city|council|sheriff's|the|and|of|public|official|website|ohio|president|vice|chair|current|members|member|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const TITLE = /^(judge|justice|sheriff|commissioner|county commissioner|mayor|dr\.?|hon\.?|honorable|mr\.?|ms\.?|mrs\.?|president|vice president|chair|chairman|chairwoman|councilman|councilwoman|member)\s+/i;
// "Judge Gary Cook" is Gary Cook.
const stripTitle = n => { let x = clean(n), prev; do { prev = x; x = x.replace(TITLE, ''); } while (x !== prev); return x; };
function plausibleName(n) {
  n = clean(n);
  if (n.length < 5 || n.length > 60) return false;
  if (!/^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ.'\- ]+$/.test(n)) return false;
  const words = n.split(' ');
  if (words.length < 2 || words.length > 5) return false;
  return !NOT_A_PERSON.test(n);
}

// Ask the web (one Tavily credit), then pull names out of the answer and snippets with the local model. A name is kept only if it
// appears in the text; the person still confirms each one. `search` and `llmJson` are injectable for tests.
// A fallback that needs no model: capitalised word runs ("Pat Example", "Michael J. Sample", "Sam Roe III") in the answer, with
// the role that follows a name ("Pat Example, President"). plausibleName() and appearsIn() still apply afterwards.
function namesFromText(text) {
  const word = String.raw`[A-Z][a-z'\u2019]+(?:-[A-Z][a-z'\u2019]+)*`;
  const out = [], re = new RegExp(String.raw`\b(${word}(?:\s+[A-Z]\.?)?(?:\s+${word}){1,2}(?:\s+(?:Jr\.|Sr\.|II|III|IV))?)(?![A-Za-z-])(?:\s*,\s*((?:Vice )?(?:President|Chair(?:man|woman)?|Treasurer|Secretary)))?`, 'g');
  let m;
  while ((m = re.exec(String(text || '')))) out.push({ name: stripTitle(m[1]), role: m[2] || '' });
  return out;
}

// One entry per person: "Mike Sample" and "Michael J. Sample" are the same sheriff. The longer spelling wins.
function dedupePeople(list) {
  const out = [];
  for (const p of list) {
    const parts = norm(p.name).split(' ').filter(Boolean), last = parts[parts.length - 1], first = parts[0] || '';
    const i = out.findIndex(q => { const qp = norm(q.name).split(' ').filter(Boolean); return qp[qp.length - 1] === last && (qp[0].startsWith(first.slice(0, 2)) || first.startsWith(qp[0].slice(0, 2))); });
    if (i < 0) out.push(p);
    else if (p.name.length > out[i].name.length) out[i] = { ...p, role: p.role || out[i].role };
    else if (!out[i].role && p.role) out[i].role = p.role;
  }
  return out;
}

async function discover(profile, officeId, { search, llmJson }) {
  const cat = catalogFor(profile).find(c => c.id === officeId);
  if (!cat || cat.via !== 'search' || !cat.available) throw new Error('That office cannot be searched for.');
  const res = await search({ query: cat.question, maxResults: 6, includeAnswer: true });
  const results = ((res && res.results) || []).slice(0, 6).map(r => ({ title: clip(r.title, 120), url: r.url, content: clean(r.content) }));
  const answer = clean(res && res.answer);
  const text = [answer, ...results.map(r => `${r.title}. ${r.content}`)].filter(Boolean).join('\n');
  const out = { office: cat.office, title: cat.title, question: cat.question, answer: clip(answer, 600), sources: results.map(r => ({ title: r.title, url: r.url })), credits: 1, candidates: [], note: '' };
  if (!text) { out.note = 'The search found nothing. You can add the person by hand.'; return out; }
  let people = [];
  try {
    const j = await llmJson(`From the text below, list the people who currently hold this office: ${cat.office}${cat.multi ? ' (there may be several)' : ' (there is one)'} for ${cat.body}.
Use ONLY names that are written in the text. Do not guess. Give each person's role if the text says it (for example "President" or "Judge, Common Pleas Court"), otherwise leave it empty. Leave out anyone described as former or past.
Return JSON: {"people":[{"name":"First Last","role":""}]}

TEXT:
${text.slice(0, 5000)}`, { timeoutMs: 45000, numPredict: 700 });
    people = Array.isArray(j && j.people) ? j.people : [];
  } catch (e) { out.note = 'The local model did not answer, so names were picked out of the answer by a simpler method. Check them against the sources.'; }
  if (!people.length) {
    people = namesFromText(answer || text);
    if (!out.note && people.length) out.note = 'Names were picked out of the answer by a simple method. Check them against the sources.';
  }
  people = dedupePeople(people.map(p => ({ name: stripTitle(clip(p && p.name, 60)), role: clip(p && p.role, 60) })));
  const seen = new Set();
  for (const p of people.slice(0, 30)) {
    const name = clip(p && p.name, 60);
    if (!plausibleName(name) || !appearsIn(name, text) || seen.has(norm(name))) continue;
    seen.add(norm(name));
    const src = results.find(r => appearsIn(name, `${r.title} ${r.content}`)) || null;
    out.candidates.push({ name, role: clip(p.role, 60), sourceUrl: src ? src.url : '', sourceTitle: src ? src.title : '' });
    if (out.candidates.length >= (cat.multi ? 20 : 3)) break;
  }
  if (!out.candidates.length && !out.note) out.note = 'No names could be confirmed from the results. Read the answer below, or add the person by hand.';
  return out;
}

// ─── Entries ─────────────────────────────────────────────────────────────────

const PRESET_OFFICES = ['Mayor', 'County Commissioner', 'County Executive', 'County Judge', 'County Sheriff', 'County Prosecutor', 'County Auditor', 'School Board Member', 'Other'];

// A validated entry from user or search input. Throws a plain-language message.
function cleanEntry(input, catalog) {
  const cat = (catalog || []).find(c => c.id === input.officeId) || null;
  // A catalogue entry that spans several offices (other county officers) takes each person's own office from what the source said.
  const office = clip((cat && cat.officeFromRole && clip(input.role, 60)) || input.office || (cat && cat.office), 60);
  const name = clip(input.name, 80);
  if (!office) throw new Error('Choose or type the office.');
  if (!name || name.length < 3 || !/[A-Za-z]/.test(name)) throw new Error('Enter the person\'s name.');
  const email = clean(input.email), phone = clean(input.phone), site = clean(input.website);
  if (email && !/^[^\s@]{1,64}@[^\s@]{1,200}\.[^\s@]{2,}$/.test(email)) throw new Error('That email address does not look right.');
  if (phone && !/^[0-9+().\-x ]{5,30}$/.test(phone)) throw new Error('That phone number does not look right.');
  if (site && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(site)) throw new Error('A website should start with https://');
  const src = input.source === 'search' ? 'search' : 'manual';
  const srcUrl = /^https?:\/\/\S+$/i.test(clean(input.sourceUrl)) ? clean(input.sourceUrl) : '';
  return {
    officeId: cat ? cat.id : '', office, level: 'local', name, body: clip(input.body || (cat && cat.body), 100),
    ...(clip(input.role, 60) && !(cat && cat.officeFromRole) ? { role: clip(input.role, 60) } : {}),
    ...(email ? { email } : {}), ...(phone ? { phone } : {}), ...(site ? { website: site } : {}),
    source: src, sourceUrl: srcUrl,
    sourceNote: src === 'search' ? 'Found by a web search and confirmed by you.' : 'Added by you.',
  };
}

module.exports = {
  catalogFor, pickMayor, mayorQuery, wikidataMayor, discover, cleanEntry, appearsIn, plausibleName, bareName, namesFromText, stripTitle, dedupePeople, PRESET_OFFICES,
};
