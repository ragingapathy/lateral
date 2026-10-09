/**
 * Lateral Proxy Server
 * Handles jobs that the browser can't do cross-origin.
 * Caddy strips the '/api/lateral/' prefix, so we handle paths like '/data'.
 */

const http   = require('http');
const https  = require('https');
const { URL } = require('url');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT          = 3005;
const MAX_REDIRECTS = 5;
const DATA_DIR = process.env.LATERAL_DATA_DIR || path.resolve(__dirname, '..', 'data');
const DATA_FILE     = path.join(DATA_DIR, 'stories.json');
const CACHE_FILE    = path.join(DATA_DIR, 'cache.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const LLM_SECRETS_FILE = path.join(DATA_DIR, 'llm-secrets.json');
const INTEL_LOG_FILE    = path.join(DATA_DIR, 'intelligence.log');
const REFRESH_LOG_FILE  = path.join(DATA_DIR, 'refresh-log.json');
const PURGED_IDS_FILE   = path.join(DATA_DIR, 'purged-ids.json');
const AGENTS_FILE       = path.join(DATA_DIR, 'agents.json');
const PURGE_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://vane:8080';
const NEWS_ENGINE_LIST = (process.env.LATERAL_NEWS_ENGINES || 'google news,brave.news,reuters,yahoo news,qwant news,duckduckgo news,wikinews,bing news')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
// Domains known to hard-paywall their content; filtered out of all news results.
const PAYWALLED_DOMAINS = new Set([
  // Major newspapers
  'nytimes.com', 'wsj.com', 'washingtonpost.com', 'bloomberg.com',
  'ft.com', 'economist.com', 'theatlantic.com', 'newyorker.com',
  'thetimes.co.uk', 'telegraph.co.uk', 'wired.com',
  // US regional
  'bostonglobe.com', 'latimes.com', 'sfchronicle.com', 'chicagotribune.com',
  'seattletimes.com', 'houstonchronicle.com', 'miamiherald.com',
  'startribune.com', 'denverpost.com', 'mercurynews.com',
  'tampabay.com', 'baltimoresun.com', 'courant.com',
  'pressdemocrat.com', 'sacbee.com', 'newsobserver.com',
  'charlotteobserver.com', 'kansascity.com', 'sltrib.com',
  // Business / trade
  'businessinsider.com', 'foreignpolicy.com', 'foreignaffairs.com',
  'technologyreview.com', 'hbr.org', 'law360.com', 'rollcall.com',
  // Opinion / culture
  'vanityfair.com', 'harpers.org', 'newstatesman.com',
  'spectator.co.uk', 'spectator.org', 'nymag.com',
  // International
  'haaretz.com', 'afr.com', 'smh.com.au', 'theage.com.au',
  'brisbanetimes.com.au', 'nzherald.co.nz',
]);

const ANTHROPIC_API_KEY_ENV = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_API_KEY_ENV = process.env.GEMINI_API_KEY || '';
const MOONSHOT_API_KEY_ENV = process.env.MOONSHOT_API_KEY || '';
const MOONSHOT_BASE_URL_ENV = process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1';
const OPENAI_COMPAT_API_KEY_ENV = process.env.OPENAI_COMPAT_API_KEY || '';
const OPENAI_COMPAT_BASE_URL_ENV = process.env.OPENAI_COMPAT_BASE_URL || 'https://api.openai.com/v1';
const LISTEN_NOTES_API_KEY_ENV = process.env.LISTEN_NOTES_API_KEY || process.env.LISTENNOTES_API_KEY || '';
const TAVILY_API_KEY_ENV = process.env.TAVILY_API_KEY || '';

// ─── Data persistence ─────────────────────────────────────────────────────────

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonFileSafe(filePath, fallback = {}) {
  try {
    ensureDataDir();
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8') || '{}');
  } catch {
    return fallback;
  }
}

function writeJsonFileSafe(filePath, value) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(value ?? {}), 'utf8');
}

function logIntel(event, meta = {}) {
  try {
    ensureDataDir();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: String(event || '').trim() || 'event',
      ...meta
    });
    fs.appendFileSync(INTEL_LOG_FILE, line + '\n', 'utf8');
  } catch {}
}

function readStoriesFile() {
  const data = readJsonFileSafe(DATA_FILE, { stories: [] });
  return Array.isArray(data?.stories) ? data.stories : [];
}

function readCacheFile() {
  return readJsonFileSafe(CACHE_FILE, {});
}

function writeCacheFile(cache) {
  writeJsonFileSafe(CACHE_FILE, cache || {});
}

function readRefreshLog() {
  return readJsonFileSafe(REFRESH_LOG_FILE, { runs: [] });
}

function appendRefreshRun(run) {
  ensureDataDir();
  const log = readRefreshLog();
  log.runs = [run, ...(log.runs || [])].slice(0, 20);
  log.lastRunAt = run.at;
  writeJsonFileSafe(REFRESH_LOG_FILE, log);
}

function updateCacheFile(mutator) {
  const cur = readCacheFile();
  const next = mutator ? (mutator({ ...cur }) || cur) : cur;
  writeCacheFile(next);
  return next;
}

function readLlmSecretsFile() {
  try {
    ensureDataDir();
    if (!fs.existsSync(LLM_SECRETS_FILE)) return {};
    const raw = fs.readFileSync(LLM_SECRETS_FILE, 'utf8');
    return JSON.parse(raw || '{}') || {};
  } catch {
    return {};
  }
}

function writeLlmSecretsFile(next) {
  ensureDataDir();
  fs.writeFileSync(LLM_SECRETS_FILE, JSON.stringify(next || {}), 'utf8');
}

function resolveLlmSecrets() {
  const file = readLlmSecretsFile();
  return {
    anthropicApiKey: String(file.anthropicApiKey || ANTHROPIC_API_KEY_ENV || '').trim(),
    geminiApiKey: String(file.geminiApiKey || GEMINI_API_KEY_ENV || '').trim(),
    moonshotApiKey: String(file.moonshotApiKey || MOONSHOT_API_KEY_ENV || '').trim(),
    moonshotBaseUrl: String(file.moonshotBaseUrl || MOONSHOT_BASE_URL_ENV || 'https://api.moonshot.ai/v1').trim(),
    openaiCompatApiKey: String(file.openaiCompatApiKey || OPENAI_COMPAT_API_KEY_ENV || '').trim(),
    openaiCompatBaseUrl: String(file.openaiCompatBaseUrl || OPENAI_COMPAT_BASE_URL_ENV || 'https://api.openai.com/v1').trim(),
    listenNotesApiKey: String(file.listenNotesApiKey || LISTEN_NOTES_API_KEY_ENV || '').trim(),
    podcastIndexApiKey: String(file.podcastIndexApiKey || process.env.PODCAST_INDEX_API_KEY || '').trim(),
    podcastIndexApiSecret: String(file.podcastIndexApiSecret || process.env.PODCAST_INDEX_API_SECRET || '').trim(),
    tavilyApiKey: String(file.tavilyApiKey || TAVILY_API_KEY_ENV || '').trim(),
    googleCivicApiKey: String(file.googleCivicApiKey || process.env.GOOGLE_CIVIC_API_KEY || '').trim(),
  };
}

function patchLlmSecrets(patch) {
  const current = readLlmSecretsFile();
  const next = { ...current };
  const keys = ['anthropicApiKey', 'geminiApiKey', 'moonshotApiKey', 'moonshotBaseUrl', 'openaiCompatApiKey', 'openaiCompatBaseUrl', 'listenNotesApiKey', 'podcastIndexApiKey', 'podcastIndexApiSecret', 'tavilyApiKey', 'googleCivicApiKey'];
  keys.forEach(k => {
    if (!(k in patch)) return;
    const val = String(patch[k] ?? '').trim();
    // Safety: blank values do not clear existing secrets.
    // We only update when a non-empty replacement is provided.
    if (!val) return;
    next[k] = val;
  });
  writeLlmSecretsFile(next);
  return resolveLlmSecrets();
}

async function handleDataGet(res) {
  try {
    ensureDataDir();
    if (!fs.existsSync(DATA_FILE)) return send(res, 200, { stories: [] });
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(raw);
  } catch (e) { send(res, 500, { error: e.message }); }
}

// Tracks recently-purged story IDs so a stale tab's zombie repost (it still
// has the pre-purge copy in memory) can't resurrect something the user
// deliberately emptied from trash. Expires after a week so this doesn't grow
// forever — by then every tab has long since resynced past it anyway.
function readPurgeTombstones() {
  const raw = readJsonFileSafe(PURGED_IDS_FILE, {});
  const cutoff = Date.now() - PURGE_TOMBSTONE_TTL_MS;
  const fresh = {};
  for (const [id, ts] of Object.entries(raw)) {
    if (new Date(ts).getTime() >= cutoff) fresh[id] = ts;
  }
  return fresh;
}
function writePurgeTombstones(map) {
  try { fs.writeFileSync(PURGED_IDS_FILE, JSON.stringify(map)); } catch {}
}

async function handleDataPost(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      ensureDataDir();
      const body = Buffer.concat(chunks).toString('utf8');
      const incoming = JSON.parse(body); // validate + parse
      const incomingStories = Array.isArray(incoming?.stories) ? incoming.stories : [];

      // Merge against what's currently on disk instead of blindly overwriting.
      // Multiple browser tabs/devices can be saving concurrently (confirmed:
      // an edit in one tab was silently discarded by a stale save from an idle
      // tab moments later) — without this, whichever POST lands last wins
      // wholesale, with zero awareness of what it's discarding.
      let existing = { stories: [] };
      try {
        if (fs.existsSync(DATA_FILE)) existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      } catch {}
      const existingStories = Array.isArray(existing?.stories) ? existing.stories : [];
      const existingById = new Map(existingStories.map(s => [s.id, s]));
      const incomingIds = new Set(incomingStories.map(s => s.id));
      const tombstones = readPurgeTombstones();
      let tombstonesChanged = false;

      // Per-story recency wins, not per-request recency — so a tab that's
      // slow to save doesn't lose an unrelated story's edit just because
      // another tab's story in the same payload happens to be newer. A story
      // that only exists in the incoming payload is either genuinely new, or
      // a stale tab's zombie repost of something that's since been purged —
      // the tombstone list is what tells those two apart.
      const merged = [];
      for (const incomingStory of incomingStories) {
        const existingStory = existingById.get(incomingStory.id);
        if (!existingStory) {
          if (tombstones[incomingStory.id]) continue; // deliberately purged — reject the resurrection
          merged.push(incomingStory);
          continue;
        }
        const incomingTs = new Date(incomingStory.updatedAt || 0).getTime();
        const existingTs = new Date(existingStory.updatedAt || 0).getTime();
        merged.push(incomingTs >= existingTs ? incomingStory : existingStory);
      }

      // A story present on disk but absent from this payload is ambiguous:
      // either another tab added/kept it after this tab's snapshot was taken
      // (preserve it), or this tab just ran purgeDeletedStories and
      // deliberately removed it (let it go, and tombstone it). Distinguish by
      // status — deletion here is already a soft delete (status:'deleted')
      // before a purge ever removes the row, so anything missing that wasn't
      // already marked deleted is the former, not the latter.
      const missingFromIncoming = [];
      for (const s of existingStories) {
        if (incomingIds.has(s.id)) continue;
        if (String(s?.status || '').toLowerCase() === 'deleted') {
          if (!tombstones[s.id]) { tombstones[s.id] = nowIso(); tombstonesChanged = true; }
          continue;
        }
        missingFromIncoming.push(s);
      }
      if (tombstonesChanged) writePurgeTombstones(tombstones);

      const finalData = { ...incoming, stories: [...merged, ...missingFromIncoming] };
      fs.writeFileSync(DATA_FILE, JSON.stringify(finalData), 'utf8');
      send(res, 200, { ok: true, storyCount: finalData.stories.length });
    } catch (e) { send(res, 400, { error: 'Invalid JSON: ' + e.message }); }
  });
}

async function handleCacheGet(res) {
  try {
    ensureDataDir();
    if (!fs.existsSync(CACHE_FILE)) return send(res, 200, {});
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(raw);
  } catch (e) { send(res, 500, { error: e.message }); }
}

async function handleSettingsGet(res) {
  try {
    ensureDataDir();
    if (!fs.existsSync(SETTINGS_FILE)) return send(res, 200, {});
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object') return send(res, 200, {});
    const location = String(parsed.location || '').trim();
    const autoRefreshHours = Number.isFinite(Number(parsed.autoRefreshHours)) ? Number(parsed.autoRefreshHours) : 8;
    send(res, 200, { location, autoRefreshHours, updatedAt: parsed.updatedAt || null });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}

async function handleSettingsPost(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      ensureDataDir();
      const incoming = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const existing = readJsonFileSafe(SETTINGS_FILE, {});
      const location = incoming?.location !== undefined ? String(incoming.location || '').trim() : String(existing.location || '').trim();
      const autoRefreshHoursRaw = incoming?.autoRefreshHours !== undefined ? incoming.autoRefreshHours : existing.autoRefreshHours;
      const autoRefreshHours = Number.isFinite(Number(autoRefreshHoursRaw)) ? Math.max(0, Number(autoRefreshHoursRaw)) : 8;
      const archiveAuto = incoming?.archiveAuto !== undefined ? incoming.archiveAuto !== false : existing.archiveAuto !== false;
      const payload = { location, autoRefreshHours, archiveAuto, updatedAt: new Date().toISOString() };
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(payload), 'utf8');
      send(res, 200, { ok: true, ...payload });
    } catch (e) {
      send(res, 400, { error: 'Invalid JSON: ' + e.message });
    }
  });
}

// ─── Agent configuration ──────────────────────────────────────────────────────

function agentsDefaults() {
  return { agents: [], updatedAt: new Date().toISOString() };
}

async function handleAgentsGet(res) {
  try {
    const data = readJsonFileSafe(AGENTS_FILE, agentsDefaults());
    send(res, 200, data);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}

async function handleAgentsPost(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      ensureDataDir();
      const incoming = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const existing = readJsonFileSafe(AGENTS_FILE, agentsDefaults());
      const agents = Array.isArray(incoming?.agents) ? incoming.agents : existing.agents || [];
      // Validate each agent
      const cleaned = agents.map(a => ({
        id: String(a.id || crypto.randomBytes(6).toString('hex')),
        name: String(a.name || a.type || 'Agent').trim(),
        type: String(a.type || 'custom').trim().toLowerCase(),
        baseUrl: String(a.baseUrl || '').trim(),
        apiKey: String(a.apiKey || '').trim(),
        model: String(a.model || '').trim(),
        enabled: a.enabled !== false,
      }));
      const payload = { agents: cleaned, updatedAt: new Date().toISOString() };
      fs.writeFileSync(AGENTS_FILE, JSON.stringify(payload), 'utf8');
      send(res, 200, { ok: true, ...payload });
    } catch (e) {
      send(res, 400, { error: 'Invalid JSON: ' + e.message });
    }
  });
}

async function handleAgentsTest(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    try {
      const incoming = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const baseUrl = String(incoming?.baseUrl || '').trim().replace(/\/+$/, '');
      const apiKey = String(incoming?.apiKey || '').trim();
      const model = String(incoming?.model || '').trim();
      if (!baseUrl) return send(res, 400, { error: 'Missing baseUrl' });
      const start = Date.now();
      const modelsUrl = `${baseUrl}/models`;
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const r = await new Promise((resolve, reject) => {
        const client = modelsUrl.startsWith('https:') ? https : http;
        const req2 = client.request(modelsUrl, { method: 'GET', headers, timeout: 15000 }, (res2) => {
          let body = '';
          res2.on('data', d => body += d);
          res2.on('end', () => resolve({ status: res2.statusCode, body }));
        });
        req2.on('error', reject);
        req2.on('timeout', () => { req2.destroy(); reject(new Error('Timeout')); });
        req2.end();
      });
      const latencyMs = Date.now() - start;
      let models = [];
      let modelUsed = '';
      if (r.status === 200) {
        try {
          const d = JSON.parse(r.body);
          models = Array.isArray(d.data) ? d.data.map(m => m.id || m.model || m.name).filter(Boolean) : [];
          if (!models.length && Array.isArray(d.models)) models = d.models.map(m => m.id || m.model || m.name).filter(Boolean);
          if (!models.length && Array.isArray(d)) models = d.map(m => m.id || m.model || m.name).filter(Boolean);
          if (model && models.includes(model)) modelUsed = model;
          else if (models.length) modelUsed = models[0];
        } catch {}
      }
      send(res, 200, {
        ok: r.status === 200,
        status: r.status,
        latencyMs,
        modelUsed,
        modelsAvailable: models,
        error: r.status !== 200 ? `HTTP ${r.status}` : undefined
      });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message || 'Connection failed' });
    }
  });
}

async function handleCachePost(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      ensureDataDir();
      const incoming = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let existing = {};
      if (fs.existsSync(CACHE_FILE)) existing = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));

      if (incoming.storyCache) {
        const base = { ...(existing.storyCache || {}) };
        for (const [sid, types] of Object.entries(incoming.storyCache)) {
          if (!base[sid]) { base[sid] = types; continue; }
          for (const [type, entry] of Object.entries(types)) {
            if (!base[sid][type] || new Date(entry.generatedAt) > new Date(base[sid][type].generatedAt)) {
              base[sid][type] = entry;
            }
          }
        }
        existing.storyCache = base;
      }
      ['brief', 'disc', 'vale'].forEach(key => {
        if (incoming[key]) {
          const inAt = incoming[key].generatedAt;
          const exAt = existing[key]?.generatedAt;
          if (!exAt || (inAt && new Date(inAt) > new Date(exAt))) existing[key] = incoming[key];
        }
      });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(existing), 'utf8');
      send(res, 200, { ok: true });
    } catch (e) { send(res, 400, { error: 'Invalid JSON: ' + e.message }); }
  });
}

const v2 = require('./v2');
const relevance = require('./relevance');
const images = require('./images');
const ops = require('./ops');
const archive = require('./archive');
const alerts = require('./alerts');
const feeds = require('./feeds');
const civic = require('./civic');
const podcasts = require('./podcasts');
const dedupe = require('./dedupe');
const civicWatch = require('./civic-watch');

// ─── HTTP request helper ─────────────────────────────────────────────────────────────────

function request(rawUrl, opts = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) return reject(new Error('Too many redirects'));
    let url;
    try { url = new URL(rawUrl); } catch (e) { return reject(new Error(`Bad URL: ${rawUrl}`)); }
    const lib = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      method:   opts.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
      timeout: opts.timeout || 12000,
    };
    const req = lib.request(options, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : `${url.protocol}//${url.host}${res.headers.location}`;
        return request(next, opts, redirects + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}


function withHardTimeout(promise, ms, label = 'Operation timed out') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function postJson(url, payload, { headers = {}, timeout = 45000 } = {}) {
  const r = await request(url, {
    method: 'POST',
    timeout,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload || {})
  });
  let data = null;
  try { data = JSON.parse(r.body || '{}'); } catch {}
  return { status: r.status, data, raw: r.body || '' };
}

function compactMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter(m => m && typeof m === 'object')
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }))
    .filter(m => m.content);
}

async function llmAnthropic({ model, messages, temperature }) {
  const secrets = resolveLlmSecrets();
  if (!secrets.anthropicApiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  const ms = compactMessages(messages);
  if (!ms.length) throw new Error('No messages');
  const payload = {
    model: model || 'claude-3-5-sonnet-latest',
    max_tokens: 900,
    temperature: Number.isFinite(temperature) ? temperature : 0.3,
    messages: ms.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
  };
  const r = await postJson('https://api.anthropic.com/v1/messages', payload, {
    headers: { 'x-api-key': secrets.anthropicApiKey, 'anthropic-version': '2023-06-01' },
    timeout: 50000
  });
  if (r.status < 200 || r.status >= 300) throw new Error(`Anthropic ${r.status}: ${String(r.raw).slice(0, 220)}`);
  const content = Array.isArray(r.data?.content)
    ? r.data.content.filter(c => c?.type === 'text').map(c => c.text || '').join('\n').trim()
    : '';
  if (!content) throw new Error('Anthropic returned empty content');
  return { content, modelUsed: r.data?.model || payload.model };
}

async function llmGemini({ model, messages, temperature }) {
  const secrets = resolveLlmSecrets();
  if (!secrets.geminiApiKey) throw new Error('Missing GEMINI_API_KEY');
  const ms = compactMessages(messages);
  if (!ms.length) throw new Error('No messages');
  const gemModel = model || 'gemini-1.5-flash';
  const contents = ms.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const payload = {
    contents,
    generationConfig: {
      temperature: Number.isFinite(temperature) ? temperature : 0.3
    }
  };
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(gemModel)}:generateContent?key=${encodeURIComponent(secrets.geminiApiKey)}`;
  const r = await postJson(endpoint, payload, { timeout: 50000 });
  if (r.status < 200 || r.status >= 300) throw new Error(`Gemini ${r.status}: ${String(r.raw).slice(0, 220)}`);
  const content = (r.data?.candidates || [])
    .flatMap(c => c?.content?.parts || [])
    .map(p => p?.text || '')
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!content) throw new Error('Gemini returned empty content');
  return { content, modelUsed: gemModel };
}

async function llmOpenAICompat({ model, messages, temperature, apiKey, baseUrl }) {
  if (!apiKey) throw new Error('Missing API key');
  const ms = compactMessages(messages);
  if (!ms.length) throw new Error('No messages');
  const endpoint = `${String(baseUrl || OPENAI_COMPAT_BASE_URL).replace(/\/+$/,'')}/chat/completions`;
  const payload = {
    model: model || 'gpt-4o-mini',
    messages: ms,
    temperature: Number.isFinite(temperature) ? temperature : 0.3,
    stream: false
  };
  const r = await postJson(endpoint, payload, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 50000
  });
  if (r.status < 200 || r.status >= 300) throw new Error(`OpenAI-compatible ${r.status}: ${String(r.raw).slice(0, 220)}`);
  const content = r.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Provider returned empty content');
  return { content: String(content), modelUsed: r.data?.model || payload.model };
}

function llmProviderCatalog() {
  const sec = resolveLlmSecrets();
  return [
    { id: 'ollama', label: 'Ollama', configured: true, modelDefault: 'qwen3:latest' },
    { id: 'anthropic', label: 'Claude (Anthropic)', configured: !!sec.anthropicApiKey, modelDefault: 'claude-3-5-sonnet-latest' },
    { id: 'gemini', label: 'Google Gemini', configured: !!sec.geminiApiKey, modelDefault: 'gemini-1.5-flash' },
    { id: 'moonshot', label: 'Kimi (Moonshot)', configured: !!sec.moonshotApiKey, modelDefault: 'moonshot-v1-8k' },
    { id: 'openai_compatible', label: 'OpenAI-Compatible', configured: !!sec.openaiCompatApiKey, modelDefault: 'gpt-4o-mini' },
  ];
}

async function handleLlmProviders(res) {
  return send(res, 200, { providers: llmProviderCatalog() });
}

function uniqStrings(values = []) {
  return [...new Set((values || []).map(v => String(v || '').trim()).filter(Boolean))];
}

const MOONSHOT_MODEL_HINTS = [
  'moonshot-v1-8k',
  'moonshot-v1-32k',
  'kimi-k2-instruct',
  'kimi-k2-0905',
  'kimi-k2-thinking',
  'kimi-k2.5',
  'kimi-k2.5-preview',
  'kimi-k2.5-thinking',
];

async function fetchLlmModelList({ provider, openaiBaseUrl, moonshotBaseUrl }) {
  const sec = resolveLlmSecrets();
  const p = String(provider || '').toLowerCase();

  if (p === 'ollama') {
    const base = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    const r = await request(`${base}/api/tags`, { timeout: 12000 });
    if (r.status !== 200) throw new Error(`Ollama ${r.status}`);
    const d = JSON.parse(r.body || '{}');
    return uniqStrings((d.models || []).map(m => m?.name));
  }

  if (p === 'anthropic') {
    if (!sec.anthropicApiKey) throw new Error('Missing ANTHROPIC_API_KEY');
    const r = await request('https://api.anthropic.com/v1/models', {
      timeout: 15000,
      headers: { 'x-api-key': sec.anthropicApiKey, 'anthropic-version': '2023-06-01' }
    });
    if (r.status !== 200) throw new Error(`Anthropic ${r.status}`);
    const d = JSON.parse(r.body || '{}');
    return uniqStrings((d.data || []).map(m => m?.id));
  }

  if (p === 'gemini') {
    if (!sec.geminiApiKey) throw new Error('Missing GEMINI_API_KEY');
    const r = await request(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(sec.geminiApiKey)}`, { timeout: 15000 });
    if (r.status !== 200) throw new Error(`Gemini ${r.status}`);
    const d = JSON.parse(r.body || '{}');
    return uniqStrings((d.models || [])
      .map(m => String(m?.name || '').replace(/^models\//, ''))
      .filter(n => /gemini/i.test(n)));
  }

  if (p === 'moonshot' || p === 'openai_compatible') {
    const baseUrl = p === 'moonshot'
      ? String(moonshotBaseUrl || sec.moonshotBaseUrl || MOONSHOT_BASE_URL_ENV || 'https://api.moonshot.ai/v1').trim()
      : String(openaiBaseUrl || sec.openaiCompatBaseUrl || OPENAI_COMPAT_BASE_URL_ENV || '').trim();
    const apiKey = p === 'moonshot' ? sec.moonshotApiKey : sec.openaiCompatApiKey;
    if (!apiKey) throw new Error(`Missing ${p === 'moonshot' ? 'MOONSHOT_API_KEY' : 'OPENAI_COMPAT_API_KEY'}`);
    const endpoint = `${baseUrl.replace(/\/+$/,'')}/models`;
    const r = await request(endpoint, {
      timeout: 15000,
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (r.status !== 200) throw new Error(`Provider ${r.status}`);
    const d = JSON.parse(r.body || '{}');
    const live = uniqStrings((d.data || []).map(m => m?.id));
    return p === 'moonshot' ? uniqStrings([...live, ...MOONSHOT_MODEL_HINTS]) : live;
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

function fallbackModelList(provider) {
  const p = String(provider || '').toLowerCase();
  if (p === 'anthropic') return ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'];
  if (p === 'gemini') return ['gemini-1.5-flash', 'gemini-1.5-pro'];
  if (p === 'moonshot') return [...MOONSHOT_MODEL_HINTS];
  if (p === 'openai_compatible') return ['gpt-4o-mini', 'gpt-4o'];
  if (p === 'ollama') return ['qwen3:latest', 'qwen3.5:9b', 'qwen3-coder:30b', 'llama3.2:latest'];
  return [];
}

async function resolveOllamaModelsToTry({ preferredModel = '', fallbackModel = '' } = {}) {
  const requested = uniqStrings([preferredModel, fallbackModel]);
  const preferredInstalledOrder = ['qwen3:latest', 'qwen3.5:9b', 'qwen3-coder:30b', 'llama3.2:latest'];
  let installed = [];
  try {
    installed = uniqStrings(await fetchLlmModelList({ provider: 'ollama' }));
  } catch {}

  if (!installed.length) {
    return uniqStrings([...requested, ...preferredInstalledOrder.slice(0, 2)]);
  }

  const installedSet = new Set(installed);
  const chosen = [];

  for (const model of requested) {
    if (installedSet.has(model)) chosen.push(model);
  }

  if (!chosen.length) {
    const preferred = preferredInstalledOrder.find(m => installedSet.has(m));
    if (preferred) chosen.push(preferred);
  }

  if (!chosen.length) chosen.push(installed[0]);
  const backup = installed.find(m => !chosen.includes(m));
  if (backup) chosen.push(backup);

  return uniqStrings(chosen);
}

async function handleLlmModels(reqUrl, res) {
  const provider = String(reqUrl.searchParams.get('provider') || '').toLowerCase();
  const openaiBaseUrl = String(reqUrl.searchParams.get('openaiBaseUrl') || '').trim();
  const moonshotBaseUrl = String(reqUrl.searchParams.get('moonshotBaseUrl') || '').trim();
  if (!provider) return send(res, 400, { error: 'Missing provider' });
  try {
    const models = await fetchLlmModelList({ provider, openaiBaseUrl, moonshotBaseUrl });
    return send(res, 200, { provider, models: uniqStrings(models), source: 'live' });
  } catch (e) {
    const models = fallbackModelList(provider);
    return send(res, 200, { provider, models, source: 'fallback', warning: e.message });
  }
}

// ─── Article image pipeline (see images.js) ─────────────────────────────────
// POST { articles: [{ url, title, source, imageUrl? }], force? } -> { results: { [url]: { realUrl, imageUrl, via, ... } }, pending }
async function handleImagesResolve(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { return send(res, 400, { error: 'Bad JSON' }); }
  try {
    const out = await images.resolveBatch(Array.isArray(body.articles) ? body.articles : [], { force: !!body.force });
    return send(res, 200, out);
  } catch (e) {
    return send(res, 200, { results: {}, pending: 0, error: e.message });
  }
}

// ─── AI relevance gate (see relevance.js) ───────────────────────────────────
// Always answers 200: if the judge is unavailable the client simply gets no verdicts and keeps everything.
async function handleRelevanceCheck(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { return send(res, 400, { error: 'Bad JSON' }); }
  const topic = String(body.topic || '').trim();
  if (!topic) return send(res, 400, { error: 'Missing topic' });
  try {
    const out = await relevance.checkArticles(
      { topic, ctx: String(body.ctx || '').slice(0, 400), tags: String(body.tags || '').slice(0, 200), strict: !!body.strict },
      Array.isArray(body.articles) ? body.articles : []
    );
    return send(res, 200, out);
  } catch (e) {
    return send(res, 200, { verdicts: {}, stats: { error: e.message } });
  }
}

async function handleRelevanceOverride(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { return send(res, 400, { error: 'Bad JSON' }); }
  const ok = relevance.setOverride(body.topic, String(body.url || ''), body.verdict || 'on_topic');
  return send(res, ok ? 200 : 400, ok ? { ok: true } : { error: 'Missing topic or url' });
}

async function handleLlmSecretsGet(res) {
  const sec = resolveLlmSecrets();
  return send(res, 200, {
    hasAnthropic: !!sec.anthropicApiKey,
    hasGemini: !!sec.geminiApiKey,
    hasMoonshot: !!sec.moonshotApiKey,
    moonshotBaseUrl: sec.moonshotBaseUrl || 'https://api.moonshot.ai/v1',
    hasOpenAICompat: !!sec.openaiCompatApiKey,
    openaiCompatBaseUrl: sec.openaiCompatBaseUrl || 'https://api.openai.com/v1',
    listenNotesConfigured: !!sec.listenNotesApiKey,
    podcastIndexConfigured: !!sec.podcastIndexApiKey,
    podcastIndexSecretConfigured: !!sec.podcastIndexApiSecret,
    tavilyConfigured: !!sec.tavilyApiKey,
    googleCivicConfigured: !!sec.googleCivicApiKey,
  });
}

async function handleLlmSecretsPost(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { return send(res, 400, { error: 'Bad JSON' }); }
  const next = patchLlmSecrets({
    anthropicApiKey: body.anthropicApiKey,
    geminiApiKey: body.geminiApiKey,
    moonshotApiKey: body.moonshotApiKey,
    moonshotBaseUrl: body.moonshotBaseUrl,
    openaiCompatApiKey: body.openaiCompatApiKey,
    openaiCompatBaseUrl: body.openaiCompatBaseUrl,
    listenNotesApiKey: body.listenNotesApiKey,
    podcastIndexApiKey: body.podcastIndexApiKey,
    podcastIndexApiSecret: body.podcastIndexApiSecret,
    tavilyApiKey: body.tavilyApiKey,
    googleCivicApiKey: body.googleCivicApiKey,
  });
  return send(res, 200, {
    ok: true,
    hasAnthropic: !!next.anthropicApiKey,
    hasGemini: !!next.geminiApiKey,
    hasMoonshot: !!next.moonshotApiKey,
    moonshotBaseUrl: next.moonshotBaseUrl || 'https://api.moonshot.ai/v1',
    hasOpenAICompat: !!next.openaiCompatApiKey,
    openaiCompatBaseUrl: next.openaiCompatBaseUrl || 'https://api.openai.com/v1',
    listenNotesConfigured: !!next.listenNotesApiKey,
    podcastIndexConfigured: !!next.podcastIndexApiKey,
    podcastIndexSecretConfigured: !!next.podcastIndexApiSecret,
    tavilyConfigured: !!next.tavilyApiKey,
    googleCivicConfigured: !!next.googleCivicApiKey,
  });
}

async function runLlmProvider({ provider, model, messages, temperature, openaiBaseUrl, moonshotBaseUrl }) {
  const p = String(provider || '').toLowerCase();
  if (p === 'anthropic') {
    return await llmAnthropic({ model, messages, temperature });
  }
  if (p === 'gemini') {
    return await llmGemini({ model, messages, temperature });
  }
  if (p === 'moonshot') {
    const sec = resolveLlmSecrets();
    const chosenModel = String(model || 'moonshot-v1-8k').trim();
    const moonshotTemp = /kimi-k2\.5/i.test(chosenModel) ? 1 : temperature;
    return await llmOpenAICompat({
      model: chosenModel,
      messages,
      temperature: moonshotTemp,
      apiKey: sec.moonshotApiKey,
      baseUrl: String(moonshotBaseUrl || sec.moonshotBaseUrl || MOONSHOT_BASE_URL_ENV || 'https://api.moonshot.ai/v1').trim()
    });
  }
  if (p === 'openai_compatible') {
    const sec = resolveLlmSecrets();
    const baseUrl = String(openaiBaseUrl || sec.openaiCompatBaseUrl || OPENAI_COMPAT_BASE_URL_ENV || '').trim();
    return await llmOpenAICompat({
      model,
      messages,
      temperature,
      apiKey: sec.openaiCompatApiKey,
      baseUrl
    });
  }
  if (p === 'ollama') {
    const base = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    const payload = {
      model: model || 'qwen3:latest',
      messages: compactMessages(messages),
      stream: false,
      format: 'json',
      options: { temperature: Number.isFinite(temperature) ? temperature : 0.2 }
    };
    const r = await postJson(`${base}/api/chat`, payload, { timeout: 45000 });
    if (r.status < 200 || r.status >= 300) throw new Error(`Ollama ${r.status}: ${String(r.raw).slice(0,220)}`);
    const content = String(r.data?.message?.content || '').trim();
    if (!content) throw new Error('Ollama returned empty content');
    return { content, modelUsed: payload.model };
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

async function handleLlmChat(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { return send(res, 400, { error: 'Bad JSON' }); }
  try {
    const provider = String(body.provider || 'ollama').toLowerCase();
    const model = String(body.model || '').trim();
    const fallbackModel = String(body.fallbackModel || '').trim();
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const temperature = Number(body.temperature);
    let modelsToTry = [model, fallbackModel].filter(Boolean);
    if (provider === 'ollama') {
      const resolved = await resolveOllamaModelsToTry({ preferredModel: model, fallbackModel });
      modelsToTry = uniqStrings([...modelsToTry, ...resolved]);
    }
    if (!modelsToTry.length) modelsToTry.push('');
    let out = null;
    let lastErr = null;

    for (const m of modelsToTry) {
      try {
        out = await runLlmProvider({
          provider,
          model: m,
          messages,
          temperature,
          openaiBaseUrl: body.openaiBaseUrl,
          moonshotBaseUrl: body.moonshotBaseUrl
        });
        if (out?.content) break;
      } catch (e) {
        lastErr = e;
      }
    }

    if (!out?.content) throw (lastErr || new Error('Provider returned no content'));
    return send(res, 200, { provider, modelUsed: out.modelUsed || model || fallbackModel, content: out.content || '' });
  } catch (e) {
    return send(res, 502, { error: e.message || 'LLM request failed' });
  }
}

async function handleLlmPing(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { return send(res, 400, { error: 'Bad JSON' }); }
  const provider = String(body.provider || '').toLowerCase();
  if (!provider) return send(res, 400, { error: 'Missing provider' });
  const model = String(body.model || '').trim();
  const t0 = Date.now();
  if (provider === 'tavily') {
    if (!resolveLlmSecrets().tavilyApiKey) return send(res, 200, { ok: false, provider, error: 'No Tavily key saved yet — paste one above and click Save key.' });
    try {
      const results = await tavilySearch({ query: 'connection test', maxResults: 1, timeout: 12000 });
      return send(res, 200, { ok: true, provider, latencyMs: Date.now() - t0, results: results.length });
    } catch (e) {
      const m = String(e.message || '');
      const friendly = /\b(401|403)\b/.test(m) ? 'Tavily rejected this key (401/403). Check that you pasted the whole key.'
        : /\b429\b/.test(m) ? 'Tavily says this key is out of quota or rate-limited (429).'
        : m;
      return send(res, 200, { ok: false, provider, latencyMs: Date.now() - t0, error: friendly });
    }
  }
  try {
    const out = await withHardTimeout(
      runLlmProvider({
        provider,
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        temperature: 0,
        openaiBaseUrl: body.openaiBaseUrl,
        moonshotBaseUrl: body.moonshotBaseUrl
      }),
      22000,
      'LLM ping timeout'
    );
    const latencyMs = Date.now() - t0;
    return send(res, 200, {
      ok: true,
      provider,
      modelUsed: out.modelUsed || model || '',
      latencyMs,
      preview: String(out.content || '').slice(0, 120)
    });
  } catch (e) {
    return send(res, 502, {
      ok: false,
      provider,
      latencyMs: Date.now() - t0,
      error: e.message || 'Ping failed'
    });
  }
}

function parseModelJson(content) {
  if (typeof content !== 'string') return content || {};
  try { return JSON.parse(content); } catch {}
  const a = content.indexOf('{');
  const b = content.lastIndexOf('}');
  if (a >= 0 && b > a) {
    const slice = content.slice(a, b + 1);
    try { return JSON.parse(slice); } catch {}
  }
  return { summary: String(content || '').trim(), keyPoints: [String(content || '').trim()] };
}

async function runLlmJsonPrompt(prompt, settings = {}) {
  const provider = String(settings?.llmProvider || 'ollama').toLowerCase();
  const preferred = provider === 'ollama'
    ? String(settings?.model || 'qwen3:latest').trim()
    : String(settings?.externalModel || 'gpt-4o-mini').trim();
  const fallback = provider === 'ollama'
    ? String(settings?.externalFallbackModel || 'llama3.2:latest').trim()
    : String(settings?.externalFallbackModel || '').trim();
  const models = provider === 'ollama'
    ? await resolveOllamaModelsToTry({ preferredModel: preferred, fallbackModel: fallback })
    : [...new Set([preferred, fallback].filter(Boolean))];
  if (!models.length) models.push('');
  let lastErr = null;
  for (const model of models) {
    try {
      const out = await withHardTimeout(
        runLlmProvider({
          provider,
          model,
          messages: [{ role: 'user', content: String(prompt || '') }],
          temperature: 0.3,
          openaiBaseUrl: settings?.openaiBaseUrl || '',
          moonshotBaseUrl: settings?.moonshotBaseUrl || '',
        }),
        52000,
        `LLM timeout (${provider}:${model || 'default'})`
      );
      return parseModelJson(String(out?.content || '{}'));
    } catch (e) {
      lastErr = e;
    }
  }
  throw (lastErr || new Error('LLM failed'));
}

function clip(v, n) {
  const t = String(v || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

async function generateStoryBriefServer(story, settings) {
  const eps = (story?.episodes || []);
  const recentEps = eps.slice(-12);
  const ctx = recentEps.map(e => `[${e.type}] ${e.date}: ${clip(e.headline, 140)}\n  ${clip(e.summary, 260)}${e.framingNote ? `\n  FRAMING: ${clip(e.framingNote, 160)}` : ''}`).join('\n\n');
  const actors = (story?.actors || []).slice(0, 20).join(', ');
  // Inject cached headlines so the brief can remark on current coverage not yet in episodes
  const cachedHeadlines = readCacheFile()?.storyCache?.[story.id]?.headlines?.items || [];
  const headlineCtx = cachedHeadlines.slice(0, 10).map((a, i) => {
    const src = String(a?.source?.name || a?.source?.domain || '').trim();
    const date = normalizePublishedDate(a?.date || a?.publishedDate || '');
    return `${i+1}. [${date||'recent'}] ${clip(a?.title||'',130)}${src?` (${src})`:''}`;
  }).join('\n');
  const prompt = `You are a narrative intelligence analyst preparing a briefing on a tracked story.

STORY: "${story?.title || ''}"
STATUS: ${story?.status || 'active'}
ACTORS: ${actors || 'none listed'}
SUMMARY: ${story?.summary || 'none'}

EPISODE LOG (${eps.length} total, latest ${recentEps.length} shown):
${ctx || '(no episodes yet)'}
${headlineCtx ? `\nRECENT WEB COVERAGE (not yet added as episodes — use to flag emerging developments):\n${headlineCtx}` : ''}

Generate a concise intelligence brief. Return JSON:
{
  "velocity": "accelerating|steady|decelerating|stalled",
  "velocityNote": "One sentence: why this velocity rating",
  "summary": "4-7 sentence analytical prose narrative. Cover the most significant recent developments, the forces and actors driving them, why it matters for the broader story arc, and what trajectory the story is on. Write in active voice, no bullet formatting.",
  "keyPlayers": [{"name":"actor name","role":"their role in this story"}],
  "keyPoints": ["3-5 most important analytical observations about this story"],
  "informationGaps": ["2-3 things we don't know that matter"],
  "actionableItems": ["2-3 concrete things a researcher should do next"],
  "likelyNextSteps": ["2-3 predicted near-term developments"],
  "watchSignals": ["2-3 specific events or publications that would be meaningful if they appear"],
  "sourceDiversityFlag": "green|yellow|red",
  "sourceDiversityNote": "One sentence on source health"
}`;
  return await runLlmJsonPrompt(prompt, settings);
}

// Many story titles follow a "Catchy Name: Explainer" pattern — great as a
// title, poor as a search query. The part before the colon/dash is usually
// the actual searchable subject; the rest is prose that just dilutes the
// query. Mirrors shortTitlePhrase() in index.html.
function shortTitlePhrase(title, maxWords = 6) {
  const t = String(title || '').trim();
  if (!t) return '';
  const base = t.split(/[:\-–—]/)[0].trim() || t;
  return base.split(/\s+/).filter(Boolean).slice(0, maxWords).join(' ');
}

function buildStoryWebDeltaQuery(story) {
  // Keep the query tight — SearXNG matches best on short, specific terms.
  // Confirmed on a long narrative title ("The Unveiling of Alien Files: A
  // Decade of Government Transparency") that using the full title starved a
  // story's results to old coverage a shorter, keyword-style query found
  // easily — use the short phrase instead of the raw title.
  const title = shortTitlePhrase(story?.title || '');
  const firstActor = Array.isArray(story?.actors) && story.actors[0] ? String(story.actors[0]).trim() : '';
  // If title already contains the actor name, skip it to avoid redundancy.
  const actorNeeded = firstActor && !title.toLowerCase().includes(firstActor.toLowerCase());
  return [title, actorNeeded ? firstActor : ''].filter(Boolean).join(' ').trim();
}

function latestEpisodeDateMs(story) {
  const eps = Array.isArray(story?.episodes) ? story.episodes : [];
  let best = 0;
  for (const e of eps) {
    const d = new Date(e?.date || '').getTime();
    if (Number.isFinite(d) && d > best) best = d;
  }
  return best;
}

function startOfLocalDayMs(daysAgo = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - Math.max(0, Number(daysAgo) || 0));
  return d.getTime();
}

function filterFreshArticlesForStory(story, articles) {
  const list = Array.isArray(articles) ? articles : [];
  const storyLastEpMs = latestEpisodeDateMs(story);
  const yesterdayMs = startOfLocalDayMs(1);
  // Floor at the day AFTER the last episode, capped at yesterday.
  // e.g. last episode 12th → floor = 13th; episode from yesterday/today → floor = yesterday.
  let freshFloorMs;
  if (storyLastEpMs > 0) {
    const dayAfterLastEp = storyLastEpMs + 24 * 60 * 60 * 1000;
    freshFloorMs = Math.min(dayAfterLastEp, yesterdayMs);
  } else {
    freshFloorMs = yesterdayMs;
  }
  return list.filter(a => {
    const ds = String(a?.date || a?.publishedDate || '').trim();
    const ms = new Date(ds).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return false;
    return ms >= freshFloorMs;
  });
}

async function fetchStoryWebDevelopments(story) {
  const query = buildStoryWebDeltaQuery(story);
  let dayResults = [];
  try {
    const rDay = await fetchNewsFromSearx(query, { engines: NEWS_ENGINE_LIST, timeRange: 'day', timeout: 12000 });
    dayResults = normalizeNewsResults(rDay.results || []);
  } catch {}

  // Strict freshness: no widening to week for daily delta brief.
  const fresh = filterFreshArticlesForStory(story, dayResults);
  return { query, articles: fresh.slice(0, 8) };
}

function compactStoryWebContextForPrompt(packet) {
  const rows = (packet?.articles || []).slice(0, 6).map((a, i) => {
    const d = normalizePublishedDate(a?.date || a?.publishedDate || '');
    const src = String(a?.source?.name || a?.source?.domain || '').trim();
    const title = clip(a?.title || '', 150);
    const snip = clip(a?.snippet || a?.content || '', 180);
    return `${i + 1}. [${d || 'undated'}] ${title}${src ? ` (${src})` : ''}${snip ? ` — ${snip}` : ''}`;
  });
  return rows.join('\n');
}

async function generateHomeWebDeltaBundleServer(storyPackets, settings) {
  const safePackets = Array.isArray(storyPackets) ? storyPackets : [];
  const context = safePackets.map((p, idx) => (
    `STORY ${idx + 1}
storyId: ${p.storyId}
title: ${p.title}
recent_web_results:
${compactStoryWebContextForPrompt(p) || '(no reliable new results found)'}`
  )).join('\n\n---\n\n');

  const prompt = `You are generating a DAILY NEWS DELTA BRIEF.
Only use the provided recent web results.
Do NOT rehash long-term background. Focus on what's newly developing.
Keep output compact.

Return strict JSON:
{
  "execSummary": "2-3 concise sentences about what changed today/this week across all tracked stories.",
  "storyBriefs": [
    {
      "storyId": "exact storyId from input",
      "velocity": "accelerating|steady|decelerating|stalled",
      "velocityNote": "one short sentence",
      "summary": "3-5 sentence analytical paragraph. Describe what is newly developing, why it matters systemically, what actors or forces are driving it, and what it signals for the broader narrative arc. Active voice, no bullets. If no fresh news: 'No significant new developments found in the current daily window.'",
      "keyPlayers": [{"name":"person/org","role":"their relevance in current developments"}],
      "keyPoints": ["2-3 concise analytical takeaways"],
      "actionableItems": ["1-2 concrete analyst actions"],
      "watchSignals": ["1-2 near-term signals to monitor"],
      "informationGaps": ["1-2 unknowns that still matter"],
      "likelyNextSteps": ["1-2 likely next developments"],
      "sourceDiversityFlag": "green|yellow|red",
      "sourceDiversityNote": "one short sentence"
    }
  ]
}

Rules:
- If a story has weak fresh signals, say so clearly and set velocity to "stalled" or "steady".
- Keep lists short and specific.
- Preserve every input storyId exactly once.
- If a story has zero fresh items, set summary to: "No significant new developments found in the current daily window."

INPUT STORIES:
${context}`;
  return await runLlmJsonPrompt(prompt, settings);
}

function buildNoNewsBrief(story) {
  return {
    velocity: 'stalled',
    velocityNote: 'No fresh developments found since the latest timeline episode.',
    summary: 'No significant new developments found in the current monitoring window. The story appears quiet — check back when fresh reporting becomes available.',
    keyPlayers: (story?.actors || []).slice(0, 4).map(name => ({ name, role: 'Previously identified key player' })),
    keyPoints: ['No fresh coverage in the current daily window.', 'Wait for fresh reporting and rerun.'],
    actionableItems: ['Wait for fresh reporting and rerun.'],
    watchSignals: ['New primary-source reporting from credible outlets.'],
    informationGaps: ['No net-new reporting to resolve open questions.'],
    likelyNextSteps: ['Continue monitoring.'],
    sourceDiversityFlag: 'yellow',
    sourceDiversityNote: 'No fresh qualifying sources were found in this cycle.'
  };
}

function sinceDateForStory(story) {
  const lastEpMs = latestEpisodeDateMs(story);
  const yesterdayMs = startOfLocalDayMs(1);
  if (lastEpMs > 0) {
    // Search from the day AFTER the last episode (e.g. episode on 12th → search from 13th).
    // Cap at yesterday so we never ask "since today" and get an empty window.
    const dayAfterLastEp = lastEpMs + 24 * 60 * 60 * 1000;
    const effectiveMs = Math.min(dayAfterLastEp, yesterdayMs);
    return new Date(effectiveMs).toISOString().slice(0, 10);
  }
  return new Date(yesterdayMs).toISOString().slice(0, 10);
}

function buildHomeDeltaValePayload(stories) {
  const safeStories = Array.isArray(stories) ? stories : [];
  const storyLines = safeStories.map((s, idx) => (
    `${idx + 1}. storyId=${String(s?.id || '')}; title="${String(s?.title || '').replace(/"/g, "'")}"; since=${sinceDateForStory(s)}`
  )).join('\n');

  const query = `Search the web and report only net-new developments for each tracked story since its provided date.
If there are no net-new developments for a story, return NO_NEWS for that story.

Stories:
${storyLines}`;

  const systemInstructions = `You are a news-delta analyst. Use web search results only.
Return STRICT JSON:
{
  "execSummary": "2-3 concise sentences across all stories",
  "stories": [
    {
      "storyId": "exact id from input",
      "noNews": true|false,
      "velocity": "accelerating|steady|decelerating|stalled",
      "velocityNote": "one short sentence",
      "summary": "3-5 sentence analytical paragraph. Describe what is newly happening, why it matters systemically, what actors or forces are driving it, and what it signals for the broader narrative arc. Active voice, no bullets. If noNews=true: 'No significant new developments found since the provided date.'",
      "keyPlayers": [{"name":"...","role":"..."}],
      "keyPoints": ["2-3 concise analytical takeaways"],
      "actionableItems": ["1-2 actions"],
      "watchSignals": ["1-2 signals"],
      "informationGaps": ["1-2 gaps"],
      "likelyNextSteps": ["1-2 likely next moves"],
      "sourceDiversityFlag": "green|yellow|red",
      "sourceDiversityNote": "one short sentence"
    }
  ]
}
Rules:
- Do not include background history unless required for immediate context.
- Preserve every input storyId exactly once.
- If no fresh updates since the provided date, set noNews=true and use explicit no-news phrasing.`;
  return { query, systemInstructions };
}

function decorateDeltaBundleWithTitles(bundle, stories) {
  const out = (bundle && typeof bundle === 'object') ? { ...bundle } : {};
  const rows = Array.isArray(out.stories) ? out.stories : [];
  if (!rows.length) return out;
  const byId = new Map();
  const byTitleKey = new Map();
  (Array.isArray(stories) ? stories : []).forEach((s) => {
    const sid = String(s?.id || '').trim();
    const title = String(s?.title || '').trim();
    if (sid && title) byId.set(sid, title);
    const nk = normalizeStoryKey(title);
    if (nk && title) byTitleKey.set(nk, title);
  });
  out.stories = rows.map((row) => {
    const r = (row && typeof row === 'object') ? { ...row } : {};
    const sid = String(r.storyId || r.id || '').trim();
    const existingTitle = String(r.storyTitle || r.title || '').trim();
    const inferredTitle = existingTitle
      || byId.get(sid)
      || byTitleKey.get(normalizeStoryKey(existingTitle || ''))
      || '';
    if (inferredTitle) {
      r.storyTitle = inferredTitle;
      if (!String(r.title || '').trim()) r.title = inferredTitle;
    }
    return r;
  });
  return out;
}

function normalizeStoryKey(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSimpleRssItems(xml, engine = 'rss', limit = 12) {
  const src = String(xml || '');
  const out = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  const tag = (chunk, name) => {
    const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
    const m = chunk.match(re);
    return m ? decodeHtml(stripTags(m[1] || '')) : '';
  };
  let m;
  while ((m = itemRe.exec(src)) && out.length < limit) {
    const chunk = m[0] || '';
    const titleRaw = tag(chunk, 'title');
    const linkRaw = tag(chunk, 'link');
    if (!titleRaw || !linkRaw) continue;
    const url = unwrapRedirectUrl(linkRaw);
    const pub = tag(chunk, 'pubDate') || tag(chunk, 'published') || '';
    const source = tag(chunk, 'source');
    const title = titleRaw.trim();
    const sourceFromTitle = (() => {
      const mm = title.match(/\s[-|]\s([^|•-]{2,80})$/);
      return mm ? mm[1].trim() : '';
    })();
    out.push({
      url,
      title,
      content: '',
      publishedDate: pub,
      engine,
      engines: [engine],
      source: { name: source || sourceFromTitle || hostFromUrl(url), domain: hostFromUrl(url) }
    });
  }
  return out;
}

async function fetchSimpleRssFallbacks(query, { timeout = 10000, limit = 10 } = {}) {
  const q = encodeURIComponent(String(query || '').trim());
  if (!q) return [];
  const googleUrl = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const bingUrl = `https://www.bing.com/news/search?q=${q}&format=rss&mkt=en-US`;
  const settled = await Promise.allSettled([
    request(googleUrl, { timeout, headers: { Accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' } }),
    request(bingUrl, { timeout, headers: { Accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' } }),
  ]);
  const rows = [];
  if (settled[0].status === 'fulfilled' && settled[0].value?.status === 200) {
    rows.push(...parseSimpleRssItems(settled[0].value.body || '', 'google news', limit));
  }
  if (settled[1].status === 'fulfilled' && settled[1].value?.status === 200) {
    rows.push(...parseSimpleRssItems(settled[1].value.body || '', 'bing news', limit));
  }
  return rows;
}

function normalizeCachedHeadlineRows(items) {
  const inRows = Array.isArray(items) ? items : [];
  return inRows
    .map((a) => {
      const url = unwrapRedirectUrl(String(a?.url || a?.realUrl || '').trim());
      const title = String(a?.title || a?.headline || '').trim();
      if (!url || !title) return null;
      const date = normalizePublishedDate(a?.date || a?.publishedDate || '');
      const sourceName = String(a?.source?.name || a?.sourceName || '').trim();
      const sourceDomain = String(a?.source?.domain || '').trim() || hostFromUrl(url);
      return {
        url,
        title,
        content: String(a?.snippet || a?.content || '').trim(),
        publishedDate: date,
        date,
        source: { name: sourceName || sourceDomain, domain: sourceDomain },
      };
    })
    .filter(Boolean);
}

async function fetchFreshEvidenceForStory(story, cachedHeadlines = []) {
  const query = buildStoryWebDeltaQuery(story);
  const title = String(story?.title || '').trim();
  const titleCore = title.split(/\s[:\-–—]\s/)[0].trim() || title;
  const titleShort = titleCore.split(/\s+/).slice(0, 6).join(' ').trim();
  const actorSeed = String((Array.isArray(story?.actors) ? story.actors[0] : '') || '').trim();
  const tagSeed = String((Array.isArray(story?.tags) ? story.tags[0] : '') || '').trim();
  const latestEp = (() => {
    const eps = Array.isArray(story?.episodes) ? story.episodes : [];
    if (!eps.length) return null;
    const sorted = eps.slice().sort((a, b) => {
      const am = new Date(a?.date || 0).getTime();
      const bm = new Date(b?.date || 0).getTime();
      return (Number.isFinite(bm) ? bm : 0) - (Number.isFinite(am) ? am : 0);
    });
    return sorted[0] || null;
  })();
  const epHeadline = String(latestEp?.headline || '').trim();
  const epCore = epHeadline.split(/\s[:\-–—]\s/)[0].trim() || epHeadline;
  const epShort = epCore.split(/\s+/).slice(0, 8).join(' ').trim();
  const queryVariants = Array.from(new Set([
    query,
    titleCore,
    titleShort,
    epCore,
    epShort,
    actorSeed && titleShort ? `${actorSeed} ${titleShort}` : '',
    tagSeed ? `${tagSeed} news` : '',
    actorSeed ? `${actorSeed} news` : '',
  ].filter(Boolean)));

  const merged = [];
  const pushRows = (rows) => {
    if (!Array.isArray(rows) || !rows.length) return;
    merged.push(...normalizeNewsResults(rows));
  };

  for (const q of queryVariants) {
    const rMulti = await fetchNewsFromSearx(q, { engines: NEWS_ENGINE_LIST, timeRange: 'month', timeout: 12000 });
    pushRows(rMulti.results || []);
    if (merged.length >= 24) break;
  }

  const cachedRows = normalizeCachedHeadlineRows(cachedHeadlines);
  const rows = dedupeArticles([...cachedRows, ...merged]);
  // Use UTC-consistent sinceMs (date-only string parses as UTC midnight in JS,
  // matching how normalizePublishedDate stores dates — avoids local-offset rejection).
  const sinceMs = new Date(sinceDateForStory(story)).getTime();
  let fresh = rows.filter(a => {
    const ms = new Date(String(a?.date || a?.publishedDate || '')).getTime();
    // Undated articles (no parseable date) are treated as potentially fresh —
    // excluding them entirely was the reason evidenceCount was always 0.
    if (!Number.isFinite(ms) || ms <= 0) return true;
    return ms >= sinceMs;
  });
  // Soft fallback: if strict since-date yields nothing, allow recent 45-day window
  // to avoid blanket "no news" false negatives from sparse/late date metadata.
  if (!fresh.length) {
    const floorMs = Date.now() - (45 * 24 * 60 * 60 * 1000);
    fresh = rows.filter(a => {
      const ms = new Date(String(a?.date || a?.publishedDate || '')).getTime();
      if (!Number.isFinite(ms) || ms <= 0) return true;
      return ms >= floorMs;
    });
  }
  // Final fallback: prefer recent cached headlines over blank "no news" output.
  if (!fresh.length && cachedRows.length) {
    fresh = cachedRows.slice(0, 6);
  }
  fresh = fresh.slice(0, 6);
  return { query, fresh };
}

function buildEvidenceBackedBriefFallback(story, evidenceRows) {
  // Template fallback used only when LLM is unavailable
  const rows = Array.isArray(evidenceRows) ? evidenceRows : [];
  const players = (story?.actors || []).slice(0, 4).map(name => ({ name, role: 'Previously identified key player' }));
  const cleanedTitles = rows.slice(0, 4).map(r => String(r?.title || '').trim()).filter(Boolean);
  const leadA = cleanedTitles[0] || '';
  const leadB = cleanedTitles[1] || '';
  const sourceNames = Array.from(new Set(
    rows.map(r => String(r?.source?.name || r?.source?.domain || '').trim()).filter(Boolean)
  ));
  const sourceCount = sourceNames.length || rows.length;
  const summaryText = cleanedTitles.length
    ? [
        `Reporting activity is elevated across ${sourceCount} independent outlet${sourceCount === 1 ? '' : 's'}, indicating renewed movement in this narrative.`,
        leadA ? `The strongest coverage signal centers on ${leadA.replace(/[“””]/g, '')}.` : '',
        leadB ? `A secondary thread of reporting points to ${leadB.replace(/[“””]/g, '')}, suggesting the story is branching into adjacent policy and implementation questions.` : '',
      ].filter(Boolean).join(' ')
    : 'Fresh web coverage was found. Reporting appears active, but signal quality remains mixed and requires additional verification.';
  const evidenceSources = rows.slice(0, 8).map((r) => ({
    title: String(r?.title || '').trim() || String(r?.source?.name || r?.source?.domain || 'Source').trim(),
    url: String(r?.url || '').trim(),
    source: String(r?.source?.name || r?.source?.domain || '').trim(),
    date: String(r?.date || r?.publishedDate || '').slice(0, 10),
  })).filter(s => /^https?:\/\//i.test(s.url));
  return {
    velocity: rows.length >= 4 ? 'accelerating' : (rows.length >= 2 ? 'steady' : 'stalled'),
    velocityNote: `${rows.length} fresh web item(s) found since last tracked episode.`,
    summary: summaryText,
    keyPlayers: players,
    keyPoints: [`Coverage volume is ${rows.length >= 4 ? 'high' : (rows.length >= 2 ? 'moderate' : 'emerging')} for the current monitoring window.`],
    actionableItems: ['Review recent sources and add high-signal items to the timeline.'],
    watchSignals: ['Further coverage from primary outlets on this topic.'],
    informationGaps: ['Need deeper validation across independent outlets.'],
    likelyNextSteps: ['Additional follow-up coverage within the next 24–72 hours.'],
    sourceDiversityFlag: rows.length >= 3 ? 'green' : 'yellow',
    sourceDiversityNote: `${rows.length} recent web item(s) found since last episode date.`,
    evidenceSources,
  };
}

async function generateEvidenceBackedBrief(story, evidenceRows, settings) {
  const rows = Array.isArray(evidenceRows) ? evidenceRows : [];
  const evidenceSources = rows.slice(0, 8).map((r) => ({
    title: String(r?.title || '').trim() || String(r?.source?.name || r?.source?.domain || 'Source').trim(),
    url: String(r?.url || '').trim(),
    source: String(r?.source?.name || r?.source?.domain || '').trim(),
    date: String(r?.date || r?.publishedDate || '').slice(0, 10),
  })).filter(s => /^https?:\/\//i.test(s.url));

  const ctx = rows.slice(0, 6).map((a, i) => {
    const d = normalizePublishedDate(a?.date || a?.publishedDate || '');
    const src = String(a?.source?.name || a?.source?.domain || '').trim();
    const title = clip(a?.title || '', 150);
    const snip = clip(a?.snippet || a?.content || '', 300);
    return `${i + 1}. [${d || 'undated'}] ${title}${src ? ` (${src})` : ''}${snip ? ` — ${snip}` : ''}`;
  }).join('\n');

  const actors = (story?.actors || []).slice(0, 10).join(', ');
  const prompt = `You are a narrative intelligence analyst. Fresh web coverage has been found for a tracked story.

STORY: “${story?.title || ''}”
STATUS: ${story?.status || 'active'}
ACTORS: ${actors || 'none listed'}
STORY SUMMARY: ${story?.summary || 'none'}

FRESH WEB COVERAGE (${rows.length} article${rows.length === 1 ? '' : 's'}):
${ctx || '(no articles)'}

Analyze the fresh coverage and generate a substantive intelligence brief. Return JSON:
{
  “velocity”: “accelerating|steady|decelerating|stalled”,
  “velocityNote”: “One sentence: why this velocity rating”,
  “summary”: “4-6 sentences of analytical prose. Cover: what is newly happening, why it matters systemically, what forces or actors are driving it, and what it signals for the broader narrative arc. Active voice, no bullets.”,
  “keyPlayers”: [{“name”:”person or org”,”role”:”their current role in this development”}],
  “keyPoints”: [“3-5 specific, non-obvious analytical observations drawn from the fresh coverage — not just restatements of headlines”],
  “informationGaps”: [“2-3 things we still don't know that would materially change the analysis”],
  “actionableItems”: [“2-3 concrete analyst actions given what was found”],
  “likelyNextSteps”: [“2-3 predicted near-term developments based on current coverage trajectory”],
  “watchSignals”: [“2-3 specific events, publications, or statements that would be meaningful if they appear”],
  “sourceDiversityFlag”: “green|yellow|red”,
  “sourceDiversityNote”: “One sentence on source health and coverage breadth”
}`;

  try {
    const result = await runLlmJsonPrompt(prompt, settings);
    if (!result || !String(result?.summary || '').trim()) throw new Error('Empty LLM result');
    return { ...result, evidenceSources };
  } catch (e) {
    console.warn(`[Intel] generateEvidenceBackedBrief LLM failed (${e.message}); using template fallback`);
    return buildEvidenceBackedBriefFallback(story, evidenceRows);
  }
}

function buildHomeValeFromStoryBriefs(execSummary, storyBriefs, warningText = '') {
  const rows = Array.isArray(storyBriefs) ? storyBriefs : [];
  const sources = [];
  const sourceIdx = new Map();
  const ensureSourceIndex = (src) => {
    const url = unwrapRedirectUrl(String(src?.url || src?.link || src?.href || '').trim());
    if (!/^https?:\/\//i.test(url)) return 0;
    if (sourceIdx.has(url)) return sourceIdx.get(url);
    const idx = sources.length + 1;
    sourceIdx.set(url, idx);
    sources.push({
      title: String(src?.title || src?.name || url).trim(),
      url
    });
    return idx;
  };

  const lines = [];
  lines.push('### Executive Summary');
  lines.push(String(execSummary || 'Daily intelligence update generated from tracked-story evidence.').trim());
  if (warningText) lines.push(`\n> Note: ${String(warningText).trim()}`);

  for (const row of rows) {
    const story = row?.story || {};
    const brief = row?.brief || {};
    const title = String(story?.title || 'Untitled Story').trim();
    const summary = String(brief?.summary || brief?.velocityNote || '').trim();
    const keyPoints = Array.isArray(brief?.keyPoints) ? brief.keyPoints.filter(Boolean).slice(0, 5) : [];
    const actions = Array.isArray(brief?.actionableItems) ? brief.actionableItems.filter(Boolean).slice(0, 3) : [];
    const watchSignals = Array.isArray(brief?.watchSignals) ? brief.watchSignals.filter(Boolean).slice(0, 3) : [];
    const likelyNextSteps = Array.isArray(brief?.likelyNextSteps) ? brief.likelyNextSteps.filter(Boolean).slice(0, 3) : [];
    const infoGaps = Array.isArray(brief?.informationGaps) ? brief.informationGaps.filter(Boolean).slice(0, 3) : [];
    const evidence = Array.isArray(brief?.evidenceSources) ? brief.evidenceSources.slice(0, 6) : [];
    const refs = evidence.map((src) => ensureSourceIndex(src)).filter(n => n > 0).map(n => `[${n}]`);

    lines.push(`\n#### ${title}`);
    lines.push(`\n**Assessment**`);
    if (summary) lines.push(`${summary}${refs.length ? ` ${refs.join(' ')}` : ''}`);

    lines.push(`\n**Key Takeaways**`);
    if (keyPoints.length) {
      keyPoints.forEach((k) => lines.push(`  - ${String(k)}`));
    } else {
      lines.push('  - No strong analytical takeaways were extracted in this cycle.');
    }

    if (infoGaps.length) {
      lines.push(`\n**Information Gaps**`);
      infoGaps.forEach((g) => lines.push(`  - ${String(g)}`));
    }

    if (likelyNextSteps.length) {
      lines.push(`\n**Likely Next Steps**`);
      likelyNextSteps.forEach((s) => lines.push(`  - ${String(s)}`));
    }

    if (watchSignals.length) {
      lines.push(`\n**Watch Signals**`);
      watchSignals.forEach((w) => lines.push(`  - ${String(w)}`));
    }

    lines.push(`\n**Actionable Items**`);
    if (actions.length) {
      actions.forEach((a) => lines.push(`  - ${String(a)}`));
    } else {
      lines.push('  - Continue monitoring for stronger corroborated reporting.');
    }

    if (evidence.length) {
      lines.push(`\n**Sources**`);
      evidence.forEach((src) => {
        const idx = ensureSourceIndex(src);
        const linkTitle = String(src?.title || src?.source || `Source ${idx}`).trim();
        const url = unwrapRedirectUrl(String(src?.url || '').trim());
        if (!idx || !/^https?:\/\//i.test(url)) return;
        lines.push(`  - [${idx}] [${linkTitle}](${url})`);
      });
    }
  }

  return {
    message: lines.join('\n').trim(),
    sources
  };
}

async function generateExecutiveSummaryServer(stories, settings) {
  const lines = (stories || []).map(st => `- "${st.title}" (${st.status}): ${st.summary || 'no summary'}`).join('\n');
  const prompt = `You are briefing an analyst who tracks narratives across multiple stories.

TRACKED STORIES:
${lines}

Write a 2-3 sentence executive summary of the current intelligence landscape across all stories. Focus on the most urgent or significant pattern.

Return JSON: { "summary": "..." }`;
  const out = await runLlmJsonPrompt(prompt, settings);
  return String(out?.summary || '');
}

async function generateCrossStoryBriefServer(stories, settings) {
  const digests = (stories || []).map(story => {
    const recent = (story.episodes || []).slice(-3).map(e => `  [${e.type}] ${e.date}: ${e.headline}`).join('\n');
    return `STORY: "${story.title}" (${story.status})\nSUMMARY: ${story.summary || 'none'}\nRECENT:\n${recent || '  (none)'}`;
  }).join('\n\n---\n\n');
  const prompt = `You are a lateral intelligence analyst. Your specialty is finding non-obvious connections between separate tracked stories.

ACTIVE STORIES:

${digests}

Analyze these stories together. Return JSON:
{
  "globalTheme": "1-2 sentences: the underlying systemic story connecting these narratives",
  "connections": [{"stories":["story title 1","story title 2"],"connection":"what links them and why it matters"}],
  "convergences": ["2-3 points where multiple stories are heading toward the same event or outcome"],
  "blindSpots": ["1-2 things the collective coverage is systematically missing"],
  "recommendedReading": [{"topic":"what to search for","reason":"why it would illuminate the landscape"}]
}`;
  return await runLlmJsonPrompt(prompt, settings);
}

let _intelJob = null; // single-flight lock for intelligence generation
const INTEL_JOB_TTL_MS = 20 * 60 * 1000;
const INTEL_RUNNING_STALE_MS = Number(process.env.INTEL_RUNNING_STALE_MS || (6 * 60 * 1000));

function makeJobId() {
  return `ij_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function cleanFinishedJob(job) {
  if (!job) return null;
  const age = Date.now() - new Date(job.updatedAt || job.startedAt || 0).getTime();
  if (job.state === 'running') {
    if (age > INTEL_RUNNING_STALE_MS) {
      // Stale in-flight job (process interruption or unhandled timeout).
      // Convert to terminal error so UI can recover and users can retry.
      return {
        ...job,
        state: 'error',
        error: job.error || 'Request timed out',
        message: job.message || 'Intelligence generation timed out',
        updatedAt: nowIso()
      };
    }
    return job;
  }
  return age > INTEL_JOB_TTL_MS ? null : job;
}

function getIntelligenceStatus(scope, storyId = '') {
  _intelJob = cleanFinishedJob(_intelJob);
  const out = !_intelJob ? { active: false, job: null } : (
    (_intelJob.scope === 'home' && scope === 'home')
      ? { active: true, job: _intelJob }
      : (_intelJob.scope === 'story' && scope === 'story' && String(_intelJob.storyId || '') === String(storyId || ''))
        ? { active: true, job: _intelJob }
        : {
            active: false,
            job: _intelJob,
            blockedByOther: _intelJob.state === 'running'
          }
  );
  // Attach latest story intelligence directly from server cache for the requested story.
  // This lets clients hydrate from the same backend that owns the running/completed job.
  if (scope === 'story' && storyId) {
    try {
      const entry = readCacheFile()?.storyCache?.[storyId]?.intelligence || null;
      if (entry && entry.brief) out.storyIntelligence = entry;
    } catch {}
  }
  return out;
}

function safeDecode(v) {
  try { return decodeURIComponent(v); } catch { return v; }
}

function hostFromUrl(rawUrl) {
  try { return new URL(rawUrl).hostname.toLowerCase(); } catch { return ''; }
}

// Headline caches get wholesale-replaced on every fetch — merge by URL against
// the previous batch so firstSeenAt survives across refreshes, otherwise every
// headline would look "brand new" on every single cycle. Mirrors the client's
// own stampFirstSeen() in index.html; both write to the same cache entry.
function stampFirstSeenServer(freshItems, prevItems) {
  const prevByUrl = new Map((Array.isArray(prevItems) ? prevItems : []).map(a => [a?.url, a]).filter(([u]) => u));
  const ts = nowIso();
  return (freshItems || []).map(a => ({ ...a, firstSeenAt: prevByUrl.get(a.url)?.firstSeenAt || ts }));
}

function unwrapRedirectUrl(rawUrl) {
  let url = rawUrl;
  for (let i = 0; i < 3; i++) {
    let parsed;
    try { parsed = new URL(url); } catch { return rawUrl; }
    const params = parsed.searchParams;
    const candidates = ['url', 'u', 'r', 'redirect', 'redir', 'target', 'dest', 'destination'];
    let next = '';
    for (const k of candidates) {
      const v = params.get(k);
      if (!v) continue;
      const dec = safeDecode(v);
      if (/^https?:\/\//i.test(dec)) { next = dec; break; }
    }
    if (!next) break;
    url = next;
  }
  return url;
}

function resolveUrl(baseUrl, candidate) {
  if (!candidate) return '';
  const v = candidate.trim();
  if (!v) return '';
  try { return new URL(v, baseUrl).toString(); } catch { return ''; }
}

function pickImageCandidate(pageUrl, candidate) {
  const raw = safeDecode(String(candidate || '').trim());
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (
    lower.startsWith('data:') ||
    /\.(svg)(?:$|[?#])/.test(lower) ||
    /(?:logo|icon|sprite|avatar|favicon|pixel|blank|spacer|placeholder|default-image|noimage|no-image)\b/.test(lower) ||
    /(?:download|app-?store|play-?store|badge|chevron|arrow|glyph)\b/.test(lower)
  ) return '';
  const img = resolveUrl(pageUrl, raw);
  if (!/^https?:\/\//i.test(img)) return '';
  // Known Google News placeholder logo — same URL stamped on every article without a thumbnail.
  if (/J6_coFbogxhRI9iM864NL_liGXvsQp2AupsKei7z0cNNfDvGUmWUy20nuUhkREQyrpY4bEeIBuc/.test(img)) return '';
  // Common tiny-asset hints.
  if (/(?:[?&](?:w|width|h|height)=([1-9]\d?)\b)|(?:[-_/](?:[1-9]\d?)x([1-9]\d?)(?:[-_.]|$))/i.test(img)) return '';
  return img;
}

function extractOgImageFromHtml(html, pageUrl) {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["'][^>]*>/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const img = pickImageCandidate(pageUrl, m[1]);
      if (/^https?:\/\//i.test(img)) return img;
    }
  }
  // JSON-LD image fields
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldHit;
  while ((ldHit = ldRe.exec(html)) !== null) {
    const block = String(ldHit[1] || '').trim();
    if (!block) continue;
    try {
      const parsed = JSON.parse(block);
      const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node)) { stack.push(...node); continue; }
        if (typeof node.image === 'string') {
          const img = pickImageCandidate(pageUrl, node.image);
          if (img) return img;
        } else if (Array.isArray(node.image)) {
          for (const v of node.image) {
            const val = typeof v === 'string' ? v : (v?.url || v?.contentUrl || '');
            const img = pickImageCandidate(pageUrl, val);
            if (img) return img;
          }
        } else if (node.image && typeof node.image === 'object') {
          const img = pickImageCandidate(pageUrl, node.image.url || node.image.contentUrl || '');
          if (img) return img;
        }
        Object.values(node).forEach(v => { if (v && typeof v === 'object') stack.push(v); });
      }
    } catch {}
  }
  // Fallback: pick first meaningful in-body image if OG/Twitter tags are absent.
  // Score img/srcset candidates and pick strongest "article-like" hit.
  const scored = [];
  const imgTagRe = /<img\b[^>]*>/gi;
  let tagMatch;
  while ((tagMatch = imgTagRe.exec(html)) !== null) {
    const tag = String(tagMatch[0] || '');
    const lowerTag = tag.toLowerCase();
    const near = html.slice(Math.max(0, tagMatch.index - 220), Math.min(html.length, tagMatch.index + 220)).toLowerCase();
    const srcsetM = tag.match(/\bsrcset=["']([^"']+)["']/i);
    const srcM = tag.match(/\bsrc=["']([^"']+)["']/i);
    const widthM = tag.match(/\bwidth=["']?(\d{2,4})/i);
    const heightM = tag.match(/\bheight=["']?(\d{2,4})/i);
    const w = widthM ? Number(widthM[1]) : 0;
    const h = heightM ? Number(heightM[1]) : 0;

    const candidates = [];
    if (srcsetM?.[1]) {
      srcsetM[1].split(',').map(x => x.trim().split(/\s+/)[0]).filter(Boolean).forEach(x => candidates.push(x));
    }
    if (srcM?.[1]) candidates.push(srcM[1]);

    for (const c of candidates) {
      const img = pickImageCandidate(pageUrl, c);
      if (!img) continue;
      let score = 0;
      if (/(article|main|story|content|post|entry)/.test(near)) score += 4;
      if (/(hero|lead|featured|cover|image|media|thumb)/.test(lowerTag)) score += 3;
      if (/(nav|menu|header|footer|toolbar|button|share|social|icon|logo|avatar|badge|download)/.test(lowerTag)) score -= 5;
      if (w >= 300 || h >= 180) score += 2;
      if ((w && w < 140) || (h && h < 90)) score -= 3;
      scored.push({ img, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored[0]?.score >= 0 && scored[0]?.img) return scored[0].img;

  return '';
}

function extractSnippetImageFromContentHtml(contentHtml) {
  const html = String(contentHtml || '');
  if (!html) return '';
  const srcsetRe = /<img[^>]+srcset=["']([^"']+)["'][^>]*>/i;
  const srcsetMatch = html.match(srcsetRe);
  if (srcsetMatch?.[1]) {
    const parts = srcsetMatch[1].split(',').map(x => x.trim().split(/\s+/)[0]).filter(Boolean);
    for (const p of parts) {
      if (
        /^https?:\/\//i.test(p) &&
        !/\.(svg)(?:$|[?#])/i.test(p) &&
        !/(logo|icon|sprite|avatar|favicon|pixel|blank|spacer|download|app-?store|play-?store|badge|chevron|arrow|glyph)/i.test(p)
      ) return p;
    }
  }
  const imgRe = /<img[^>]+src=["']([^"']+)["'][^>]*>/i;
  const m = html.match(imgRe);
  if (!m?.[1]) return '';
  const src = safeDecode(String(m[1]).trim());
  if (!/^https?:\/\//i.test(src)) return '';
  if (/\.(svg)(?:$|[?#])/i.test(src)) return '';
  if (/(logo|icon|sprite|avatar|favicon|pixel|blank|spacer|download|app-?store|play-?store|badge|chevron|arrow|glyph)/i.test(src)) return '';
  return src;
}

async function handleOg(reqUrl, res) {
  const targetRaw = reqUrl.searchParams.get('url');
  if (!targetRaw) return send(res, 400, { error: 'Missing url' });
  const target = unwrapRedirectUrl(targetRaw);
  if (!/^https?:\/\//i.test(target)) return send(res, 400, { error: 'Invalid url' });

  try {
    const r = await request(target, {
      timeout: 12000,
      headers: {
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
      }
    });
    if (r.status < 200 || r.status >= 400) return send(res, 200, { imageUrl: null });
    const imageUrl = extractOgImageFromHtml(r.body || '', target);
    return send(res, 200, { imageUrl: imageUrl || null });
  } catch {
    return send(res, 200, { imageUrl: null });
  }
}
// ─── Search Handlers ──────────────────────────────────────────────────────────

function mapNewsResult(r) {
  const normalized = unwrapRedirectUrl(r.url || '');
  const urlDomain = hostFromUrl(normalized);
  const sourceObj = (r && typeof r.source === 'object' && r.source) ? r.source : null;
  const sourceName = sourceObj ? String(sourceObj.name || '').trim() : '';
  const sourceDomainRaw = sourceObj ? String(sourceObj.domain || sourceObj.url || '').trim() : '';
  const sourceDomain = sourceDomainRaw ? hostFromUrl(sourceDomainRaw.startsWith('http') ? sourceDomainRaw : `https://${sourceDomainRaw}`) : '';
  const AGGREGATOR_DOMAIN_RE = /(^|\.)(news\.google\.com|bing\.com|search\.brave\.com|duckduckgo\.com|startpage\.com|qwant\.com)$/i;
  const domain = (sourceDomain && (!urlDomain || AGGREGATOR_DOMAIN_RE.test(urlDomain))) ? sourceDomain : urlDomain;
  const engine = String(r.engine || '').trim();
  const nameLooksEngine = /^(google news|bing news|brave\.?news|duckduckgo news|startpage news|qwant news|wikinews)$/i.test(sourceName);
  const inferredFromTitle = (() => {
    const t = String(r.title || '').trim();
    const m = t.match(/\s[-|]\s([^|•-]{2,80})$/);
    return m ? m[1].trim() : '';
  })();
  const inferredFromContent = (() => {
    const c = decodeHtmlEntities(String(r.content || ''))
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const m = c.match(/(?:\u00A0|&nbsp;|\s){1,4}([A-Za-z0-9 .&'’:-]{2,80})$/i);
    return m ? m[1].trim() : '';
  })();
  const shouldInferPublisher = AGGREGATOR_DOMAIN_RE.test(urlDomain || '') || /^(google news|news\.google\.com)$/i.test(sourceName || '');
  const inferredName = shouldInferPublisher ? (inferredFromTitle || inferredFromContent) : '';
  const name = (!nameLooksEngine && sourceName) || inferredName || domain || engine;
  const displayDomain = (domain && !AGGREGATOR_DOMAIN_RE.test(domain)) ? domain : '';
  return {
    title: r.title,
    url: normalized,
    realUrl: normalized,
    date: normalizePublishedDate(
      r.publishedDate ||
      r.published_date ||
      r.published ||
      r.pubDate ||
      r.metadata ||
      r.published_at ||
      r.publishedAt ||
      r.createdAt ||
      r.created_at ||
      r.created ||
      r.date ||
      r.time ||
      guessDateFromUrl(r.url)
    ),
    snippet: (r.content || '').slice(0, 240),
    source: { name, domain: displayDomain, engine },
    imageUrl: r.thumbnail || r.img_src || extractSnippetImageFromContentHtml(r.content || '') || null
  };
}

function normalizeNewsResults(results) {
  const out = [];
  const seenUrls = new Set();
  const domainCount = Object.create(null);
  const engineCount = Object.create(null);
  const ENGINE_CAP = {
    'google news': 8,
    reuters: 8,
    'bing news': 6,
    'brave news': 6,
    'duckduckgo news': 6,
    'startpage news': 6,
    'qwant news': 6,
    'yahoo news': 6,
    wikinews: 4,
  };
  const MAX_PER_DOMAIN = 2;

  const mapped = (results || [])
    .filter(r => r.url && r.title)
    .map(mapNewsResult)
    .filter(a => {
      const domain = (a?.source?.domain || hostFromUrl(a?.url || '')).replace(/^www\./, '');
      return !PAYWALLED_DOMAINS.has(domain);
    });
  // Freshness-first ordering, then prefer non-Google for better source mix.
  const ageDays = d => {
    const dt = new Date(d || '');
    if (Number.isNaN(dt.getTime())) return 999;
    const now = new Date();
    const utcA = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const utcB = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
    return Math.max(0, Math.floor((utcA - utcB) / 86400000));
  };
  mapped.sort((a, b) => {
    const d = ageDays(a?.date) - ageDays(b?.date);
    if (d !== 0) return d;
    const ag = engineAliasSet(a?.source?.engine).has('google news') ? 1 : 0;
    const bg = engineAliasSet(b?.source?.engine).has('google news') ? 1 : 0;
    return ag - bg;
  });

  // Strip imageUrls that appear on 2+ articles — those are generic source fallbacks
  // (e.g. the Google News placeholder icon), not article-specific photos.
  const imgUrlCount = Object.create(null);
  for (const a of mapped) if (a.imageUrl) imgUrlCount[a.imageUrl] = (imgUrlCount[a.imageUrl] || 0) + 1;
  for (const a of mapped) {
    if (a.imageUrl && imgUrlCount[a.imageUrl] > 1) a.imageUrl = null;
  }

  // First pass: prioritize source diversity.
  for (const a of mapped) {
    const key = (a.url || '').toLowerCase();
    if (!key || seenUrls.has(key)) continue;
    const domain = (a.source?.domain || '').toLowerCase() || 'unknown';
    const engine = (a.source?.engine || a.source?.name || '').toLowerCase() || 'unknown';
    const isSocialEngine = engine === 'reddit' || engine === 'bluesky' || engine === 'threads';
    const domainCap = isSocialEngine ? 12 : MAX_PER_DOMAIN;
    const maxForEngine = ENGINE_CAP[engine] || 999;
    if ((domainCount[domain] || 0) >= domainCap) continue;
    if ((engineCount[engine] || 0) >= maxForEngine) continue;
    seenUrls.add(key);
    domainCount[domain] = (domainCount[domain] || 0) + 1;
    engineCount[engine] = (engineCount[engine] || 0) + 1;
    out.push(a);
    if (out.length >= 28) return out;
  }

  // Second pass: backfill if strict diversity filters were too aggressive,
  // but keep relaxed caps so one engine/domain cannot fully dominate.
  const RELAXED_MAX_PER_DOMAIN = 3;
  const RELAXED_ENGINE_CAP_FACTOR = 2;
  for (const a of mapped) {
    const key = (a.url || '').toLowerCase();
    if (!key || seenUrls.has(key)) continue;
    const domain = (a.source?.domain || '').toLowerCase() || 'unknown';
    const engine = (a.source?.engine || a.source?.name || '').toLowerCase() || 'unknown';
    const isSocialEngine = engine === 'reddit' || engine === 'bluesky' || engine === 'threads';
    const relaxedDomainCap = isSocialEngine ? 16 : RELAXED_MAX_PER_DOMAIN;
    const relaxedEngineCap = (ENGINE_CAP[engine] || 999) * RELAXED_ENGINE_CAP_FACTOR;
    if ((domainCount[domain] || 0) >= relaxedDomainCap) continue;
    if ((engineCount[engine] || 0) >= relaxedEngineCap) continue;
    seenUrls.add(key);
    domainCount[domain] = (domainCount[domain] || 0) + 1;
    engineCount[engine] = (engineCount[engine] || 0) + 1;
    out.push(a);
    if (out.length >= 28) break;
  }
  // Final re-balance: if we have non-Google supply, keep Google to a minority share.
  const isGoogleAt = a => engineAliasSet(a?.source?.engine).has('google news');
  const nonGoogleCount = out.reduce((n, a) => n + (isGoogleAt(a) ? 0 : 1), 0);
  if (nonGoogleCount > 0) {
    const maxGoogle =
      nonGoogleCount >= 10 ? 8 :
      nonGoogleCount >= 6  ? 6 :
      4;
    let seenGoogle = 0;
    const balanced = [];
    for (const a of out) {
      if (isGoogleAt(a)) {
        if (seenGoogle >= maxGoogle) continue;
        seenGoogle += 1;
      }
      balanced.push(a);
    }
    return balanced;
  }
  return out;
}

function normalizeEngineName(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function engineAliasSet(name) {
  const base = normalizeEngineName(name);
  const out = new Set(base ? [base] : []);
  if (!base) return out;
  const add = s => out.add(normalizeEngineName(s));
  if (base === 'bing') add('bing news');
  if (base === 'bing news') add('bing');
  if (base === 'google') add('google news');
  if (base === 'google news') add('google');
  if (base === 'brave') add('brave news');
  if (base === 'brave news') add('brave');
  if (base === 'duckduckgo') add('duckduckgo news');
  if (base === 'duckduckgo news') add('duckduckgo');
  if (base === 'qwant') add('qwant news');
  if (base === 'qwant news') add('qwant');
  if (base === 'startpage') add('startpage news');
  if (base === 'startpage news') add('startpage');
  return out;
}

function resultMatchesRequestedEngines(result, requestedEngines) {
  if (!requestedEngines?.length) return true;
  const wanted = new Set();
  for (const e of requestedEngines) {
    for (const alias of engineAliasSet(e)) wanted.add(alias);
  }
  const present = new Set();
  for (const e of [result?.engine, ...(Array.isArray(result?.engines) ? result.engines : [])]) {
    for (const alias of engineAliasSet(e)) present.add(alias);
  }
  for (const e of present) if (wanted.has(e)) return true;
  return false;
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/gi, '/');
}

function stripTags(html) {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim();
}

function normalizePublishedDate(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    const dt = new Date(ms);
    return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const rel = s.match(/(\d+)\s*(minute|min|hour|hr|day|week|month|year)s?\s+ago/i);
  if (rel) {
    const n = Number(rel[1] || 0);
    const unit = (rel[2] || '').toLowerCase();
    const dt = new Date();
    if (unit.startsWith('min')) dt.setMinutes(dt.getMinutes() - n);
    else if (unit.startsWith('hour') || unit === 'hr') dt.setHours(dt.getHours() - n);
    else if (unit.startsWith('day')) dt.setDate(dt.getDate() - n);
    else if (unit.startsWith('week')) dt.setDate(dt.getDate() - (7 * n));
    else if (unit.startsWith('month')) dt.setMonth(dt.getMonth() - n);
    else if (unit.startsWith('year')) dt.setFullYear(dt.getFullYear() - n);
    return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
  }
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
}

// Guess publish date from URL path patterns like /2024/05/03/ or 2024-05-03
function guessDateFromUrl(url) {
  if (!url) return '';
  const s = String(url);
  // Match /YYYY/MM/DD/ or /YYYY/M/D/ patterns
  const pathDate = s.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
  if (pathDate) {
    const [_, y, m, d] = pathDate;
    const dt = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T00:00:00Z`);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  }
  // Match YYYY-MM-DD in URL
  const isoDate = s.match(/\/(\d{4}-\d{2}-\d{2})[/-\s]/);
  if (isoDate) return isoDate[1];
  // Match YYYYMMDD in URL
  const compactDate = s.match(/\/(\d{4})(\d{2})(\d{2})\//);
  if (compactDate) {
    const [_, y, m, d] = compactDate;
    const dt = new Date(`${y}-${m}-${d}T00:00:00Z`);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  }
  return '';
}

// Pre-normalization deduplication: remove near-duplicate articles
// based on URL canonicalization and title similarity
function deduplicateByUrlAndTitle(results) {
  if (!Array.isArray(results)) return [];
  const out = [];
  const seenUrls = new Set();
  const titleFingerprints = new Set();

  for (const r of results) {
    if (!r?.url || !r?.title) continue;

    // Canonicalize URL: strip tracking params, trailing slashes
    let canonical = '';
    try {
      const url = new URL(r.url);
      // Strip common tracking params
      const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref', 'source'];
      trackingParams.forEach(p => url.searchParams.delete(p));
      url.hash = '';
      canonical = url.toString().toLowerCase().replace(/\/$/, '');
    } catch {
      canonical = r.url.toLowerCase().replace(/\/$/, '');
    }

    // URL-based dedup
    if (seenUrls.has(canonical)) continue;
    seenUrls.add(canonical);

    // Title fingerprint: first 12 normalized words
    const titleFp = String(r.title || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .slice(0, 12)
      .join(' ');

    // Skip if we've seen a very similar title already
    if (titleFingerprints.has(titleFp)) continue;
    titleFingerprints.add(titleFp);

    out.push(r);
  }
  return out;
}

async function fetchOpenGraphImage(url, timeout = 3000) {
  try {
    const r = await request(url, { timeout, headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' } });
    if (r.status !== 200 || !r.body) return null;
    const ogMatch = r.body.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                     r.body.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    return ogMatch ? ogMatch[1] : null;
  } catch {
    return null;
  }
}

function parseGoogleNewsRss(xml, limit = 12) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  const tag = (src, name) => {
    const m = src.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'));
    return m ? decodeHtmlEntities(m[1].trim()) : '';
  };
  const sourceTag = src => {
    const m = src.match(/<source[^>]*url=["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/i);
    return m ? { url: m[1], name: stripTags(m[2]) } : { url: '', name: '' };
  };
  const descImg = desc => {
    // Google News RSS embeds the article thumbnail as <img src="..."> inside the description HTML.
    const m = desc.match(/<img[^>]+src=["']([^"']+)["']/i);
    return m ? m[1] : null;
  };
  let m;
  while ((m = itemRe.exec(xml)) && items.length < limit) {
    const raw = m[1] || '';
    const title = stripTags(tag(raw, 'title'));
    const link = tag(raw, 'link');
    if (!title || !link) continue;
    const source = sourceTag(raw);
    const normalized = unwrapRedirectUrl(link);
    const domain = hostFromUrl(source.url || normalized);
    const descRaw = tag(raw, 'description');
    const thumbnail = descImg(descRaw);
    items.push({
      url: normalized,
      title,
      content: stripTags(descRaw).slice(0, 240),
      publishedDate: tag(raw, 'pubDate'),
      engine: 'google news',
      engines: ['google news'],
      thumbnail,
      img_src: thumbnail || '',
      source: { name: source.name || domain, domain }
    });
  }
  // Strip thumbnails shared across multiple items — those are Google News fallback logos,
  // not article-specific images. Real article thumbnails are always unique per item.
  const thumbCount = Object.create(null);
  for (const it of items) if (it.thumbnail) thumbCount[it.thumbnail] = (thumbCount[it.thumbnail] || 0) + 1;
  for (const it of items) {
    if (it.thumbnail && thumbCount[it.thumbnail] > 1) { it.thumbnail = null; it.img_src = ''; }
  }
  return items;
}

function parseBingNewsRss(xml, limit = 12) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  const tag = (src, name) => {
    const m = src.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'));
    return m ? decodeHtmlEntities(m[1].trim()) : '';
  };
  const sourceTag = src => {
    const m = src.match(/<source[^>]*url=["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/i);
    return m ? { url: m[1], name: stripTags(m[2]) } : { url: '', name: '' };
  };
  const mediaThumbnail = src => {
    // Bing uses <News:Image>https://www.bing.com/th?id=...&pid=News</News:Image>
    const m = src.match(/<News:Image[^>]*>(https?:\/\/[^<]+)<\/News:Image>/i);
    return m ? decodeHtmlEntities(m[1].trim()) : null;
  };
  let m;
  while ((m = itemRe.exec(xml)) && items.length < limit) {
    const raw = m[1] || '';
    const title = stripTags(tag(raw, 'title'));
    const link = tag(raw, 'link');
    if (!title || !link) continue;
    const source = sourceTag(raw);
    const normalized = unwrapRedirectUrl(link);
    const domain = hostFromUrl(source.url || normalized);
    const thumbnail = mediaThumbnail(raw);
    items.push({
      url: normalized,
      title,
      content: stripTags(tag(raw, 'description')).slice(0, 240),
      publishedDate: tag(raw, 'pubDate'),
      engine: 'bing news',
      engines: ['bing news'],
      thumbnail,
      img_src: thumbnail || '',
      source: { name: source.name || domain, domain }
    });
  }
  return items;
}

function parseBraveNewsHtml(html, limit = 12) {
  const items = [];
  const seen = new Set();

  // Pass 1: build URL → thumbnail map from <a class="thumbnail" href="URL">...<img src="IMG">.
  // Brave wraps each result image in a separate anchor with class="thumbnail".
  const thumbnailMap = new Map();
  const thumbRe = /<a\b([^>]*class="[^"]*thumbnail[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;
  const hrefFrom = attrs => { const hm = attrs.match(/href=["'](https?:\/\/[^"']+)["']/i); return hm ? hm[1] : null; };
  const imgSrcFrom = inner => {
    const im = inner.match(/<img\b[^>]+src=["'](https?:\/\/[^"']+)["']/i);
    if (!im) return null;
    const src = im[1];
    if (/cdn\.search\.brave\.com/i.test(src)) return null;
    if (/imgs\.search\.brave\.com/i.test(src) && /rs:fit:32:/i.test(src)) return null;
    return src;
  };
  let t;
  while ((t = thumbRe.exec(html))) {
    const url = hrefFrom(t[1]);
    const img = imgSrcFrom(t[2]);
    if (url && img) {
      const key = unwrapRedirectUrl(url).toLowerCase();
      if (!thumbnailMap.has(key)) thumbnailMap.set(key, img);
    }
  }

  // Pass 2: collect article links with titles, attach thumbnails from map.
  const linkRe = /<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) && items.length < limit) {
    const link = m[1];
    if (!/^https?:\/\//i.test(link)) continue;
    if (/search\.brave\.com|cdn\.search\.brave\.com/i.test(link)) continue;
    let title = stripTags(m[2]);
    title = title.replace(/^\s*[^•]{1,60}\s*•\s*\d+\s+\w+\s+ago\s*/i, '').trim();
    if (!title || title.length < 20) continue;
    const normalized = unwrapRedirectUrl(link);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const thumbnail = thumbnailMap.get(key) || null;
    items.push({
      url: normalized,
      title,
      content: '',
      publishedDate: '',
      engine: 'brave.news',
      engines: ['brave.news'],
      thumbnail,
      img_src: thumbnail || '',
    });
  }
  return items;
}

async function fetchGoogleNewsFallback(query, { timeout = 12000, limit = 12 } = {}) {
  const q = encodeURIComponent(String(query || '').trim());
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const r = await request(url, { timeout, headers: { 'Accept': 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' } });
  if (r.status !== 200) return [];
  return parseGoogleNewsRss(r.body || '', limit);
}

async function fetchBingNewsFallback(query, { timeout = 12000, limit = 12 } = {}) {
  const q = encodeURIComponent(String(query || '').trim());
  const url = `https://www.bing.com/news/search?q=${q}&format=rss&mkt=en-US`;
  const r = await request(url, { timeout, headers: { 'Accept': 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' } });
  if (r.status !== 200) return [];
  return parseBingNewsRss(r.body || '', limit);
}

// Tavily: general web search API with real domain restriction (include_domains),
// used for Social Context (reddit.com / bsky.app / threads.net) since the local
// SearXNG instance's `site:` filtering never worked (news-only engine verticals
// don't support it) and direct calls to Reddit/Bluesky's own APIs are blocked
// at the network level. Key stays server-side — never exposed to the client.
async function tavilySearch({ query, domains, maxResults = 8, timeout = 12000 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Missing query');
  const tavilyKey = resolveLlmSecrets().tavilyApiKey;
  if (!tavilyKey) throw new Error('Tavily API key not configured — add it in Settings → Web search');
  const body = {
    query: q,
    search_depth: 'basic',
    max_results: Math.max(1, Math.min(20, Number(maxResults) || 8)),
  };
  const domainList = (Array.isArray(domains) ? domains : []).map(d => String(d || '').trim()).filter(Boolean);
  if (domainList.length) body.include_domains = domainList;
  const { status, data, raw } = await postJson('https://api.tavily.com/search', body, {
    headers: { 'Authorization': `Bearer ${tavilyKey}` },
    timeout,
  });
  if (status < 200 || status >= 300) throw new Error(`Tavily ${status}: ${String(raw || '').slice(0, 200)}`);
  return (data?.results || []).map(x => ({
    title: String(x?.title || '').trim(),
    url: String(x?.url || '').trim(),
    content: String(x?.content || '').trim(),
    score: x?.score,
  })).filter(x => x.url);
}

async function handleTavilyUsage(res) {
  const tavilyKey = resolveLlmSecrets().tavilyApiKey;
  if (!tavilyKey) return send(res, 200, { configured: false, error: 'No Tavily key saved' });
  try {
    const { status, body } = await request('https://api.tavily.com/usage', {
      headers: { 'Authorization': `Bearer ${tavilyKey}` },
      timeout: 10000,
    });
    if (status < 200 || status >= 300) throw new Error(`Tavily ${status}: ${String(body || '').slice(0, 200)}`);
    const parsed = JSON.parse(body || '{}');
    const account = parsed?.account || {};
    const key = parsed?.key || {};
    const limit = account.plan_limit ?? key.limit ?? null;
    const usage = account.plan_usage ?? key.usage ?? 0;
    return send(res, 200, {
      configured: true,
      planName: account.current_plan || 'Unknown',
      limit,
      usage,
      remaining: limit !== null ? Math.max(0, limit - usage) : null,
      percentage: limit ? Math.round((usage / limit) * 100) : null,
      breakdown: {
        search: account.search_usage ?? key.search_usage ?? 0,
        extract: account.extract_usage ?? key.extract_usage ?? 0,
        crawl: account.crawl_usage ?? key.crawl_usage ?? 0,
        map: account.map_usage ?? key.map_usage ?? 0,
        research: account.research_usage ?? key.research_usage ?? 0,
      },
    });
  } catch (e) {
    return send(res, 502, { configured: true, error: e.message || 'Usage fetch failed' });
  }
}

async function fetchBraveNewsFallback(query, { timeout = 12000, limit = 12 } = {}) {
  const q = encodeURIComponent(String(query || '').trim());
  const url = `https://search.brave.com/news?q=${q}`;
  const r = await request(url, { timeout, headers: { 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' } });
  if (r.status !== 200) return [];
  return parseBraveNewsHtml(r.body || '', limit);
}

function parseRedditJson(body, limit = 12) {
  let data;
  try { data = JSON.parse(body || '{}'); } catch { return []; }
  const children = data?.data?.children || [];
  const out = [];
  for (const row of children) {
    const p = row?.data || {};
    const permalink = p.permalink ? `https://www.reddit.com${p.permalink}` : '';
    const url = permalink || p.url || '';
    const title = (p.title || '').trim();
    if (!url || !title) continue;
    out.push({
      url,
      title,
      content: (p.selftext || '').slice(0, 240),
      publishedDate: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : '',
      engine: 'reddit',
      engines: ['reddit'],
      thumbnail: (p.thumbnail && /^https?:\/\//i.test(p.thumbnail)) ? p.thumbnail : null,
      img_src: '',
      source: { name: 'Reddit', domain: 'reddit.com' },
    });
    if (out.length >= limit) break;
  }
  return out;
}

function parsePullpushJson(body, limit = 12) {
  let data;
  try { data = JSON.parse(body || '{}'); } catch { return []; }
  const rows = data?.data || [];
  const out = [];
  for (const p of rows) {
    const url = p?.full_link || p?.url || '';
    const title = (p?.title || '').trim();
    if (!url || !title) continue;
    out.push({
      url,
      title,
      content: (p?.selftext || '').slice(0, 240),
      publishedDate: p?.created_utc ? new Date(p.created_utc * 1000).toISOString() : '',
      engine: 'reddit',
      engines: ['reddit'],
      thumbnail: null,
      img_src: '',
      source: { name: 'Reddit', domain: 'reddit.com' },
    });
    if (out.length >= limit) break;
  }
  return out;
}

// Filter social results to only keep posts whose title/content contains
// at least one keyword from the original query. This removes irrelevant
// SearXNG-cached posts that happen to match broad platform filters.
function filterSocialByRelevance(results, query) {
  if (!Array.isArray(results) || !query) return results;
  const keywords = String(query)
    .replace(/site:\S+/gi, '')
    .replace(/[^\w\s]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= 3);
  if (keywords.length === 0) return results;
  return results.filter(r => {
    const text = String(r.title + ' ' + (r.content || '')).toLowerCase();
    return keywords.some(kw => text.includes(kw));
  });
}

async function fetchRedditFallback(query, { timeout = 12000, limit = 12 } = {}) {
  const clean = String(query || '').replace(/site:reddit\.com/ig, '').replace(/\s+/g, ' ').trim();
  const q = encodeURIComponent(clean || String(query || '').trim());
  const lim = Math.min(Math.max(limit, 1), 25);

  // Primary: reddit.com (often blocked)
  try {
    const url = `https://www.reddit.com/search.json?q=${q}&sort=relevance&t=week&limit=${lim}&raw_json=1`;
    const r = await request(url, { timeout, headers: { 'Accept': 'application/json' } });
    if (r.status === 200) {
      const parsed = parseRedditJson(r.body || '', limit);
      if (parsed.length) return parsed;
    }
  } catch {}

  // Fallback: public Reddit mirror index
  try {
    const url2 = `https://api.pullpush.io/reddit/search/submission/?q=${q}&size=${lim}`;
    const r2 = await request(url2, { timeout, headers: { 'Accept': 'application/json' } });
    if (r2.status !== 200) return [];
    return parsePullpushJson(r2.body || '', limit);
  } catch {
    return [];
  }
}

function bskyWebUrlFromUri(uri, handle) {
  const m = String(uri || '').match(/\/app\.bsky\.feed\.post\/([^\/?#]+)/i);
  const rkey = m?.[1] || '';
  if (!rkey || !handle) return '';
  return `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(rkey)}`;
}

function parseBlueskyJson(body, limit = 12) {
  let data;
  try { data = JSON.parse(body || '{}'); } catch { return []; }
  const posts = data?.posts || [];
  const out = [];
  for (const p of posts) {
    const text = (p?.record?.text || '').trim();
    const handle = p?.author?.handle || '';
    const url = bskyWebUrlFromUri(p?.uri, handle);
    if (!url || !text) continue;
    out.push({
      url,
      title: text.slice(0, 180),
      content: text.slice(0, 240),
      publishedDate: p?.record?.createdAt || '',
      engine: 'bluesky',
      engines: ['bluesky'],
      thumbnail: null,
      img_src: '',
      source: { name: 'Bluesky', domain: 'bsky.app' },
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchBlueskyFallback(query, { timeout = 12000, limit = 12 } = {}) {
  const q = encodeURIComponent(String(query || '').trim());
  const lim = Math.min(Math.max(limit, 1), 25);
  const url = `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${q}&limit=${lim}`;
  const r = await request(url, { timeout, headers: { 'Accept': 'application/json' } });
  if (r.status !== 200) return [];
  return parseBlueskyJson(r.body || '', limit);
}

async function fetchThreadsScrapeFallback(query, { timeout = 12000, limit = 12 } = {}) {
  const clean = String(query || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const out = [];
  const seen = new Set();

  // Strategy 1: Search general web results for threads.net URLs
  // This catches Threads posts that are linked from Reddit, news, etc.
  const broadQueries = [
    `threads.net ${clean}`,
    `${clean} threads.net`,
    `www.threads.net ${clean}`,
  ];

  const perQueryTimeout = Math.max(5000, Math.min(timeout, 10000));
  const batches = await Promise.all(
    broadQueries.map(async q => {
      try {
        const params = new URLSearchParams({ q, format: 'json', language: 'en' });
        const url = `${SEARXNG_URL}/search?${params.toString()}`;
        const r = await request(url, { timeout: perQueryTimeout });
        if (r.status !== 200) return [];
        const data = JSON.parse(r.body || '{}');
        return Array.isArray(data?.results) ? data.results : [];
      } catch {
        return [];
      }
    })
  );

  for (const row of batches.flat()) {
    const u = String(row?.url || '');
    // Match Threads URLs: threads.net/@handle/post/ABC or threads.net/t/ABC
    // Also accept embed URLs: threads.net/t/ABC/embed
    if (!/threads\.net\/(?:@[^\/?#]+\/post\/[^\/?#]+|t\/[^\/?#]+)/i.test(u)) continue;
    const key = u.toLowerCase().split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: u,
      title: String(row?.title || '').trim() || `Threads post about "${clean}"`,
      content: String(row?.content || '').trim().slice(0, 240),
      publishedDate: row?.publishedDate || row?.published_date || new Date().toISOString(),
      engine: 'threads',
      engines: ['threads'],
      thumbnail: row?.thumbnail || null,
      img_src: row?.img_src || '',
      source: { name: 'Threads', domain: 'threads.net' },
    });
    if (out.length >= limit) break;
  }

  // Strategy 2: Try direct Threads page fetch as last resort
  // Sometimes the search page contains JSON data or SSR markup
  if (!out.length) {
    try {
      const url = `https://www.threads.net/search/?q=${encodeURIComponent(clean)}`;
      const r = await request(url, {
        timeout: Math.min(timeout, 6000),
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        }
      });
      if (r.status === 200 && r.body) {
        const threadsRe = /https?:\/\/www\.threads\.net\/(?:@[^\/"\s<>]+\/post\/[^\/"\s<>]+|t\/[^\/"\s<>]+)/gi;
        let m;
        while ((m = threadsRe.exec(r.body)) !== null && out.length < limit) {
          const postUrl = m[0];
          const key = postUrl.toLowerCase().split('?')[0];
          if (seen.has(key)) continue;
          seen.add(key);
          const contextStart = Math.max(0, m.index - 300);
          const context = r.body.slice(contextStart, m.index);
          const textMatch = context.match(/>([^<]{20,200})<\s*$/);
          const title = textMatch ? textMatch[1].trim().slice(0, 180) : `Threads post about "${clean}"`;
          out.push({
            url: postUrl,
            title,
            content: '',
            publishedDate: new Date().toISOString(),
            engine: 'threads',
            engines: ['threads'],
            thumbnail: null,
            img_src: '',
            source: { name: 'Threads', domain: 'threads.net' },
          });
        }
      }
    } catch {
      // Ignore
    }
  }

  return out;
}

const SOCIAL_ENGINES = {
  reddit: {
    detectRe: /site:reddit\.com/i,
    queries: clean => [`site:reddit.com/r ${clean}`, `reddit discussion ${clean}`],
    wantedUrlRe: /reddit\.com\/r\/.+\/(comments|s)\//i,
    source: { name: 'Reddit', domain: 'reddit.com' },
  },
  bluesky: {
    detectRe: /site:(bsky\.app|bsky\.social)/i,
    queries: clean => [`site:bsky.app/profile ${clean}`, `site:bsky.app/post ${clean}`, `bluesky post ${clean}`, `bluesky ${clean}`],
    wantedUrlRe: /bsky\.app\/profile\/.+\/post\//i,
    source: { name: 'Bluesky', domain: 'bsky.app' },
  },
  threads: {
    detectRe: /site:(threads\.net|www\.threads\.net)/i,
    queries: clean => [`site:threads.net/@ ${clean}`, `site:threads.net post ${clean}`, `threads post ${clean}`, `threads ${clean}`],
    wantedUrlRe: /(threads\.net\/@[^\/?#]+\/post\/[A-Za-z0-9_-]+|threads\.net\/t\/[A-Za-z0-9_-]+)/i,
    source: { name: 'Threads', domain: 'threads.net' },
  },
};

function getSocialIntent(query) {
  const q = String(query || '');
  const intent = {};
  for (const [platform, cfg] of Object.entries(SOCIAL_ENGINES)) {
    intent[platform] = cfg.detectRe.test(q);
  }
  return intent;
}

function flattenFulfilledArrays(settled) {
  return settled
    .filter(x => x.status === 'fulfilled' && Array.isArray(x.value))
    .flatMap(x => x.value);
}

function socialCounts(rows) {
  const out = { reddit: 0, bluesky: 0, threads: 0 };
  for (const row of rows || []) {
    const k = String(row?.engine || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(out, k)) out[k] += 1;
  }
  return out;
}

function socialFallbackJobs(cleanQ, intent, { timeout = 10000, limit = 12 } = {}) {
  return [
    intent.reddit ? fetchRedditFallback(cleanQ, { timeout, limit }) : Promise.resolve([]),
    intent.bluesky ? fetchBlueskyFallback(cleanQ, { timeout, limit }) : Promise.resolve([]),
    intent.reddit ? fetchSocialWebFallback(cleanQ, { platform: 'reddit', timeout, limit }) : Promise.resolve([]),
    intent.bluesky ? fetchSocialWebFallback(cleanQ, { platform: 'bluesky', timeout, limit }) : Promise.resolve([]),
    intent.threads ? fetchSocialWebFallback(cleanQ, { platform: 'threads', timeout, limit }) : Promise.resolve([]),
    intent.threads ? fetchThreadsScrapeFallback(cleanQ, { timeout, limit }) : Promise.resolve([]),
  ];
}

async function fetchSocialWebFallback(query, { platform = 'bluesky', timeout = 12000, limit = 12 } = {}) {
  const clean = String(query || '').replace(/site:(reddit\.com|bsky\.app|bsky\.social|threads\.net|www\.threads\.net)/ig, '').replace(/\s+/g, ' ').trim();
  const cfg = SOCIAL_ENGINES[platform] || SOCIAL_ENGINES.bluesky;
  const queries = cfg.queries(clean);
  const out = [];
  const seen = new Set();
  const canonicalize = u => {
    const unwrapped = unwrapRedirectUrl(u || '');
    if (!unwrapped) return '';
    if (platform === 'bluesky') {
      // Prefer canonical post URL over /quotes view.
      const deQuoted = unwrapped.replace(/(\/post\/[^\/?#]+)\/quotes(?:[/?#].*)?$/i, '$1');
      try {
        const parsed = new URL(deQuoted);
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
      } catch {
        return deQuoted;
      }
    }
    try {
      const parsed = new URL(unwrapped);
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return unwrapped;
    }
  };
  const isWantedUrl = u => {
    const s = String(u || '');
    return cfg.wantedUrlRe.test(s);
  };
  const perQueryTimeout = Math.max(3000, Math.min(timeout, 7000));
  const batches = await Promise.all(
    queries.map(async q => {
      try {
        const params = new URLSearchParams({
          q,
          format: 'json',
          language: 'en'
        });
        const url = `${SEARXNG_URL}/search?${params.toString()}`;
        const r = await request(url, { timeout: perQueryTimeout });
        if (r.status !== 200) return [];
        const data = JSON.parse(r.body || '{}');
        return Array.isArray(data?.results) ? data.results : [];
      } catch {
        return [];
      }
    })
  );

  for (const row of batches.flat()) {
    const normalized = canonicalize(row?.url || '');
    if (!normalized || !isWantedUrl(normalized)) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: normalized,
      title: String(row?.title || '').trim(),
      content: String(row?.content || '').trim().slice(0, 240),
      publishedDate: row?.publishedDate || row?.published_date || row?.metadata || '',
      engine: platform,
      engines: [platform],
      thumbnail: row?.thumbnail || null,
      img_src: row?.img_src || '',
      source: cfg.source,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// Primary news aggregator: runs Google/Bing/Brave RSS in parallel and optionally
// tops up with Vane when results are thin. No SearXNG dependency required.
async function fetchNewsMultiSource(query, { timeRange = 'week', timeout = 15000 } = {}) {
  const cleanQ = String(query || '').replace(/["'']/g, '').replace(/\s+/g, ' ').trim();
  if (!cleanQ) return { results: [], query: cleanQ };

  const rssTimeout = Math.min(timeout, 12000);
  const [google, bing, brave] = await Promise.allSettled([
    fetchGoogleNewsFallback(cleanQ, { timeout: rssTimeout, limit: 16 }),
    fetchBingNewsFallback(cleanQ, { timeout: rssTimeout, limit: 16 }),
    fetchBraveNewsFallback(cleanQ, { timeout: Math.min(timeout, 9000), limit: 12 }),
  ]);

  const rows = [
    ...(google.status === 'fulfilled' ? google.value : []),
    ...(bing.status === 'fulfilled' ? bing.value : []),
    ...(brave.status === 'fulfilled' ? brave.value : []),
  ];

  // If RSS returns thin results, try Vane as a supplement (silently skip if it's down).
  if (rows.length < 10) {
    try {
      const vane = await fetchNewsFromSearx(cleanQ, {
        engines: NEWS_ENGINE_LIST,
        timeRange,
        timeout: Math.min(timeout, 6000),
      });
      rows.push(...(vane.results || []));
    } catch {}
  }

  return { results: deduplicateByUrlAndTitle(rows), query: cleanQ };
}

async function fetchNewsFromSearx(query, { engines = [], timeRange = 'week', timeout = 15000 } = {}) {
  const cleanQ = String(query || '').replace(/["'']/g, '').replace(/\s+/g, ' ').trim();
  if (!cleanQ) return { results: [], query: cleanQ };
  const params = new URLSearchParams({
    q: cleanQ,
    format: 'json',
    categories: 'news',
    language: 'en',
    time_range: timeRange
  });
  if (engines.length) params.set('engines', engines.join(','));
  const searchUrl = `${SEARXNG_URL}/search?${params.toString()}`;
  const r = await request(searchUrl, { timeout });
  if (r.status !== 200) throw new Error(`SearXNG returned ${r.status}`);
  const data = JSON.parse(r.body || '{}');
  const baseRaw = data.results || [];
  let filtered = engines.length ? baseRaw.filter(x => resultMatchesRequestedEngines(x, engines)) : baseRaw;

  if (engines.length) {
    const wantsGoogle = engines.some(e => engineAliasSet(e).has('google news'));
    const wantsBrave = engines.some(e => engineAliasSet(e).has('brave news'));
    const wantsBing = engines.some(e => engineAliasSet(e).has('bing news'));
    const hasGoogle = filtered.some(x => resultMatchesRequestedEngines(x, ['google news']));
    const hasBrave = filtered.some(x => resultMatchesRequestedEngines(x, ['brave.news']));
    const hasBing = filtered.some(x => resultMatchesRequestedEngines(x, ['bing news']));
    const hasBingWithDate = filtered.some(x =>
      resultMatchesRequestedEngines(x, ['bing news']) &&
      !!normalizePublishedDate(
        x.publishedDate || x.published_date || x.published || x.pubDate ||
        x.metadata || x.published_at || x.publishedAt || x.createdAt || x.created_at || x.created || x.date || x.time
      )
    );

    const fallbackCalls = [];
    if (wantsGoogle && !hasGoogle) fallbackCalls.push(fetchGoogleNewsFallback(cleanQ, { timeout: Math.min(timeout, 12000), limit: 12 }));
    if (wantsBrave && !hasBrave) fallbackCalls.push(fetchBraveNewsFallback(cleanQ, { timeout: Math.min(timeout, 12000), limit: 12 }));
    if (wantsBing && (!hasBing || !hasBingWithDate)) fallbackCalls.push(fetchBingNewsFallback(cleanQ, { timeout: Math.min(timeout, 12000), limit: 12 }));

    if (fallbackCalls.length) {
      const settled = await Promise.allSettled(fallbackCalls);
      const extras = settled
        .filter(x => x.status === 'fulfilled')
        .flatMap(x => x.value || []);
      if (extras.length) {
        filtered = [...filtered, ...extras].filter(x => resultMatchesRequestedEngines(x, engines));
        console.log(`[Search] Added fallback results: ${extras.length} for engines=${engines.join(',')}`);
      }
    }
  }

  if (engines.length && baseRaw.length && !filtered.length) {
    console.warn(`[Search] Engine filter dropped all results for engines=${engines.join(',')}`);
  }

  // Patch D: Early per-domain cap to reduce downstream processing
  // Allow up to 4 results per domain per engine batch
  const earlyDomainCap = Object.create(null);
  const capped = [];
  for (const row of filtered) {
    const domain = hostFromUrl(row?.url || '').toLowerCase() || 'unknown';
    if ((earlyDomainCap[domain] || 0) >= 4) continue;
    earlyDomainCap[domain] = (earlyDomainCap[domain] || 0) + 1;
    capped.push(row);
  }
  if (capped.length < filtered.length) {
    console.log(`[Search] Early domain cap removed ${filtered.length - capped.length} excess results from same domains`);
  }

  return { results: capped, query: cleanQ };
}
async function handleVaneSearch(reqUrl, res) {
  const q = reqUrl.searchParams.get('q');
  if (!q) return send(res, 400, { error: 'Missing query' });
  const engineOverride = (reqUrl.searchParams.get('engines') || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // Explicit override: /search?q=...&engines=brave.news
  if (engineOverride.length) {
    try {
      const one = await fetchNewsFromSearx(q, { engines: engineOverride, timeout: 15000 });
      const articles = normalizeNewsResults(one.results || []);
      return send(res, 200, { articles, query: one.query, engines: engineOverride });
    } catch (e) {
      return send(res, 502, { error: e.message });
    }
  }

  const socialIntent = getSocialIntent(q);
  const wantsRedditSite = !!socialIntent.reddit;
  const wantsBlueskySite = !!socialIntent.bluesky;
  const wantsThreadsSite = !!socialIntent.threads;

  // Social-only queries should bypass the heavier news blend path.
  if (wantsRedditSite || wantsBlueskySite || wantsThreadsSite) {
    try {
      const cleanQ = String(q || '').trim();
      // Strip ALL site: operators so APIs search the actual topic, not the platform name
      const socialQuery = cleanQ.replace(/site:\S+/gi, '').replace(/\s+/g, ' ').trim();
      // When any social site: operator is used, fetch ALL social platforms for a mixed result
      const fullSocialIntent = { reddit: true, bluesky: true, threads: true };
      const settledSocial = await Promise.allSettled(socialFallbackJobs(socialQuery, fullSocialIntent, { timeout: 10000, limit: 12 }));
      let socialExtras = flattenFulfilledArrays(settledSocial);

      // Separate Threads from other social — Threads titles from SearXNG are always
      // just "Threads" so they can never pass keyword relevance filtering.
      const threadsResults = socialExtras.filter(r => r.engine === 'threads');
      const nonThreads = socialExtras.filter(r => r.engine !== 'threads');

      // Apply relevance filter only to Reddit/Bluesky
      const beforeFilter = nonThreads.length;
      const filteredNonThreads = filterSocialByRelevance(nonThreads, socialQuery);
      if (filteredNonThreads.length < beforeFilter) {
        console.log(`[Search] Relevance filter removed ${beforeFilter - filteredNonThreads.length} off-topic Reddit/Bluesky posts`);
      }

      // Keep up to 3 Threads results even if their titles are poor
      // (Threads has no public API and blocks scrapers — this is the best we can do)
      socialExtras = [...filteredNonThreads, ...threadsResults.slice(0, 3)];

      const { reddit: rCount, bluesky: bCount, threads: tCount } = socialCounts(socialExtras);
      console.log(`[Search] Social-only fallback: total=${socialExtras.length} (reddit=${rCount}, bluesky=${bCount}, threads=${tCount})`);
      if (!socialExtras.length) return send(res, 200, { articles: [], query: cleanQ, warning: 'No social results returned' });
      const articles = normalizeNewsResults(socialExtras);
      return send(res, 200, { articles, query: cleanQ });
    } catch (e) {
      return send(res, 200, { articles: [], query: String(q || '').trim(), warning: e?.message || 'Social search failed' });
    }
  }

  // Primary news path: Vane (SearXNG) — returns img_src with results, no extra fetching needed.
  try {
    const r = await fetchNewsFromSearx(q, { engines: NEWS_ENGINE_LIST, timeout: 15000 });
    const cleanQ = r.query || String(q || '').trim();

    const socialExtras = [];
    if (wantsRedditSite || wantsBlueskySite || wantsThreadsSite) {
      const socialSettled = await Promise.allSettled(socialFallbackJobs(cleanQ, socialIntent, { timeout: 10000, limit: 12 }));
      socialExtras.push(...flattenFulfilledArrays(socialSettled));
      if (socialExtras.length) {
        const { reddit: rCount, bluesky: bCount, threads: tCount } = socialCounts(socialExtras);
        console.log(`[Search] Added social fallbacks: ${socialExtras.length} (reddit=${rCount}, bluesky=${bCount}, threads=${tCount})`);
      }
    }

    const allRaw = socialExtras.length ? [...r.results, ...socialExtras] : r.results;
    if (!allRaw.length) {
      return send(res, 200, { articles: [], query: cleanQ, warning: 'No news sources returned results' });
    }

    const articles = normalizeNewsResults(allRaw);

    const AGGREGATOR_URL_RE = /\/\/(news\.google\.com|bing\.com|search\.brave\.com|duckduckgo\.com)/i;
    const articlesNeedingImages = articles.filter(a => !a.imageUrl && a.url && !AGGREGATOR_URL_RE.test(a.url));
    if (articlesNeedingImages.length > 0) {
      await Promise.allSettled(articlesNeedingImages.slice(0, 6).map(async (article) => {
        const ogImage = await fetchOpenGraphImage(article.url, 3000);
        if (ogImage) article.imageUrl = ogImage;
      }));
    }

    send(res, 200, { articles, query: cleanQ });
  } catch (e) { send(res, 502, { error: e.message }); }
}

async function handleVideos(reqUrl, res) {
  const q = reqUrl.searchParams.get('q');
  if (!q) return send(res, 400, { error: 'Missing query' });
  try {
    const baseQ = String(q || '').replace(/\s+/g, ' ').trim();
    const variants = [...new Set([
      baseQ,
      `${baseQ} interview`,
      `${baseQ} analysis`,
      `${baseQ} explainer`,
      `${baseQ} latest`
    ].map(s => s.trim()).filter(Boolean))].slice(0, 5);
    const jobs = variants.map(async term => {
      const params = new URLSearchParams({
        q: term,
        categories: 'videos',
        format: 'json',
        language: 'en'
      });
      const u = `${SEARXNG_URL}/search?${params.toString()}`;
      const r = await request(u, { timeout: 12000 });
      if (r.status !== 200) return [];
      const data = JSON.parse(r.body || '{}');
      return Array.isArray(data?.results) ? data.results : [];
    });
    const settled = await Promise.allSettled(jobs);
    const merged = settled
      .filter(s => s.status === 'fulfilled')
      .flatMap(s => s.value || []);
    const seen = new Set();
    const domainCounts = Object.create(null);
    const videos = [];
    const canonicalize = raw => {
      try {
        const unwrapped = unwrapRedirectUrl(String(raw || '').trim());
        const parsed = new URL(unwrapped);
        parsed.hash = '';
        [...parsed.searchParams.keys()].forEach(k => {
          if (/^(utm_|fbclid|gclid|si|feature|pp|spm|ref)/i.test(k)) parsed.searchParams.delete(k);
        });
        return parsed.toString();
      } catch {
        return String(raw || '').trim();
      }
    };
    for (const v of merged) {
      const canonical = canonicalize(v?.url || v?.iframe_src || '');
      if (!canonical || seen.has(canonical)) continue;
      const domain = hostFromUrl(canonical).replace(/^www\./, '') || 'unknown';
      if ((domainCounts[domain] || 0) >= 4) continue;
      seen.add(canonical);
      domainCounts[domain] = (domainCounts[domain] || 0) + 1;
      videos.push({
        title: v?.title || '',
        url: canonical,
        thumbnail: v?.thumbnail || '',
        iframe: v?.iframe_src || '',
        author: v?.author || v?.channel || '',
        length: v?.length || '',
        description: v?.content || v?.description || ''
      });
      if (videos.length >= 16) break;
    }
    send(res, 200, { videos });
  } catch (e) { send(res, 502, { error: e.message }); }
}

function normalizePodcastDate(raw) {
  if (!raw && raw !== 0) return '';
  if (typeof raw === 'number') {
    // Listen Notes often returns ms epoch.
    const n = raw > 100000000000 ? raw : raw * 1000;
    const dt = new Date(n);
    return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
  }
  const s = String(raw || '').trim();
  if (!s) return '';
  const dt = new Date(s);
  if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function stripHtmlText(v) {
  return String(v || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapListenNotesEpisode(ep) {
  const url = String(ep?.listennotes_url || ep?.audio || ep?.link || '').trim();
  const podcastTitle = String(ep?.podcast?.title_original || ep?.podcast?.title || '').trim();
  const title = String(ep?.title_original || ep?.title || '').trim();
  const summary = stripHtmlText(ep?.description_original || ep?.description || '');
  const cover = String(ep?.image || ep?.thumbnail || ep?.podcast?.image || ep?.podcast?.thumbnail || '').trim();
  const audio = String(ep?.audio || '').trim();
  return {
    title: title || 'Untitled episode',
    podcastTitle: podcastTitle || 'Podcast',
    summary: summary.slice(0, 420),
    url,
    date: normalizePodcastDate(ep?.pub_date_ms || ep?.pub_date || ep?.published || ''),
    imageUrl: cover || '',
    audioUrl: audio || '',
    source: { name: 'Listen Notes', domain: 'listennotes.com', engine: 'listen-notes' }
  };
}

function mapItunesEpisode(ep) {
  const title = String(ep?.trackName || '').trim();
  const podcastTitle = String(ep?.collectionName || '').trim();
  const summary = stripHtmlText(ep?.description || ep?.shortDescription || '');
  const episodeUrl = String(ep?.episodeUrl || '').trim();
  const pageUrl = String(ep?.trackViewUrl || ep?.collectionViewUrl || '').trim();
  const isDirectAudio = /\.(mp3|m4a|aac|ogg|wav)(?:$|[?#])/i.test(episodeUrl);
  const audioUrl = isDirectAudio ? episodeUrl : String(ep?.previewUrl || '').trim();
  const url = pageUrl || episodeUrl;
  const cover = String(ep?.artworkUrl600 || ep?.artworkUrl100 || '').trim();
  return {
    title: title || 'Untitled episode',
    podcastTitle: podcastTitle || 'Podcast',
    summary: summary.slice(0, 420),
    url,
    date: normalizePodcastDate(ep?.releaseDate || ep?.currentReleaseDate || ''),
    imageUrl: cover || '',
    audioUrl: audioUrl || '',
    source: { name: 'Apple Podcasts', domain: 'podcasts.apple.com', engine: 'itunes' }
  };
}

async function fetchListenNotesEpisodes(query, { limit = 12, timeout = 15000 } = {}) {
  const listenNotesKey = resolveLlmSecrets().listenNotesApiKey;
  if (!listenNotesKey) return [];
  const lim = Math.max(1, Math.min(limit, 20));
  const params = new URLSearchParams({
    q: String(query || '').trim(),
    type: 'episode',
    sort_by_date: '0',
    language: 'English',
    offset: '0',
    only_in: 'title,description',
    safe_mode: '0'
  });
  const url = `https://listen-api.listennotes.com/api/v2/search?${params.toString()}`;
  const r = await request(url, {
    timeout,
    headers: {
      'X-ListenAPI-Key': listenNotesKey,
      'Accept': 'application/json'
    }
  });
  if (r.status < 200 || r.status >= 300) throw new Error(`Listen Notes ${r.status}`);
  const data = JSON.parse(r.body || '{}');
  const eps = Array.isArray(data?.results) ? data.results : [];
  return eps.map(mapListenNotesEpisode).filter(x => x.url || x.audioUrl).slice(0, lim);
}

function mapPodcastIndexEpisode(ep) {
  const title = String(ep?.title || '').trim();
  const podcastTitle = String(ep?.feedTitle || ep?.podcast_title || '').trim();
  const summary = stripHtmlText(ep?.description || ep?.content || '');
  const url = String(ep?.link || ep?.enclosureUrl || '').trim();
  const audioUrl = String(ep?.enclosureUrl || '').trim();
  const cover = String(ep?.image || ep?.feedImage || '').trim();
  const transcriptUrl = String(ep?.transcriptUrl || (Array.isArray(ep?.transcripts) && ep.transcripts[0]?.url) || '').trim();
  return {
    title: title || 'Untitled episode',
    podcastTitle: podcastTitle || 'Podcast',
    summary: summary.slice(0, 420),
    url,
    date: normalizePodcastDate(ep?.datePublished || ''),
    imageUrl: cover || '',
    audioUrl: audioUrl || '',
    transcriptUrl: transcriptUrl || '',
    source: { name: 'Podcast Index', domain: 'podcastindex.org', engine: 'podcast-index' }
  };
}

function podcastIndexAuthHeaders(apiKey, apiSecret) {
  const authDate = String(Math.floor(Date.now() / 1000));
  const authHash = crypto.createHash('sha1').update(apiKey + apiSecret + authDate).digest('hex');
  return {
    'X-Auth-Key': apiKey,
    'X-Auth-Date': authDate,
    'Authorization': authHash,
    'User-Agent': 'Lateral/1.0',
    'Accept': 'application/json'
  };
}

async function fetchPodcastIndexEpisodes(query, { limit = 12, timeout = 15000 } = {}) {
  const { podcastIndexApiKey: apiKey, podcastIndexApiSecret: apiSecret } = resolveLlmSecrets();
  if (!apiKey || !apiSecret) return [];
  const lim = Math.max(1, Math.min(limit, 20));
  // Step 1: find top matching shows
  const searchParams = new URLSearchParams({ q: String(query || '').trim(), max: '5', fulltext: '1' });
  const searchUrl = `https://api.podcastindex.org/api/1.0/search/byterm?${searchParams.toString()}`;
  const searchR = await request(searchUrl, { timeout, headers: podcastIndexAuthHeaders(apiKey, apiSecret) });
  if (searchR.status < 200 || searchR.status >= 300) throw new Error(`Podcast Index search ${searchR.status}`);
  const shows = JSON.parse(searchR.body || '{}')?.feeds;
  if (!Array.isArray(shows) || !shows.length) return [];
  // Step 2: fetch recent episodes from top 3 shows in parallel
  const topShows = shows.slice(0, 3).filter(s => s?.id);
  const epPerShow = Math.ceil(lim / topShows.length);
  const settled = await Promise.allSettled(topShows.map(show => {
    const epParams = new URLSearchParams({ id: String(show.id), max: String(epPerShow), fulltext: '1' });
    const epUrl = `https://api.podcastindex.org/api/1.0/episodes/byfeedid?${epParams.toString()}`;
    return request(epUrl, { timeout, headers: podcastIndexAuthHeaders(apiKey, apiSecret) })
      .then(r => {
        if (r.status < 200 || r.status >= 300) return [];
        const items = JSON.parse(r.body || '{}')?.items;
        return Array.isArray(items) ? items.map(mapPodcastIndexEpisode).filter(x => x.url || x.audioUrl) : [];
      });
  }));
  return settled
    .filter(s => s.status === 'fulfilled')
    .flatMap(s => s.value)
    .slice(0, lim);
}

async function fetchItunesPodcastEpisodes(query, { limit = 12, timeout = 12000 } = {}) {
  const lim = Math.max(1, Math.min(limit, 30));
  const params = new URLSearchParams({
    term: String(query || '').trim(),
    media: 'podcast',
    entity: 'podcastEpisode',
    limit: String(lim),
    country: 'US'
  });
  const url = `https://itunes.apple.com/search?${params.toString()}`;
  const r = await request(url, { timeout, headers: { 'Accept': 'application/json' } });
  if (r.status < 200 || r.status >= 300) throw new Error(`iTunes ${r.status}`);
  const data = JSON.parse(r.body || '{}');
  const rows = Array.isArray(data?.results) ? data.results : [];
  return rows.map(mapItunesEpisode).filter(x => x.url).slice(0, limit);
}

function mergePodcastResults(rows = [], cap = 16) {
  const out = [];
  const seen = new Set();
  const srcCount = Object.create(null);
  for (const row of rows) {
    if (!row) continue;
    const key = String(row.url || `${row.podcastTitle}::${row.title}`).toLowerCase();
    if (!key || seen.has(key)) continue;
    const src = String(row.source?.engine || row.source?.name || 'unknown').toLowerCase();
    if ((srcCount[src] || 0) >= 10) continue;
    seen.add(key);
    srcCount[src] = (srcCount[src] || 0) + 1;
    out.push(row);
    if (out.length >= cap) break;
  }
  out.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return out;
}

async function handlePodcasts(reqUrl, res) {
  const q = String(reqUrl.searchParams.get('q') || '').trim();
  if (!q) return send(res, 400, { error: 'Missing query' });
  const limit = Math.max(1, Math.min(Number(reqUrl.searchParams.get('limit') || 16), 24));
  try {
    const sec = resolveLlmSecrets();
    const hasPodcastIndexCreds = !!(sec.podcastIndexApiKey && sec.podcastIndexApiSecret);
    const podcastIndexHalfConfigured = !!(sec.podcastIndexApiKey && !sec.podcastIndexApiSecret);
    const baseCalls = hasPodcastIndexCreds
      ? [
          fetchPodcastIndexEpisodes(q, { limit, timeout: 20000 }),
          fetchItunesPodcastEpisodes(q, { limit, timeout: 12000 }),
        ]
      : [
          fetchItunesPodcastEpisodes(q, { limit, timeout: 12000 }),
        ];
    const baseSettled = await Promise.allSettled(baseCalls);
    let merged = mergePodcastResults(
      baseSettled
        .filter(s => s.status === 'fulfilled')
        .flatMap(s => s.value || []),
      limit
    );

    // Quota protection: only hit Listen Notes when needed to backfill sparse results.
    if (!podcastIndexHalfConfigured && merged.length < Math.min(8, limit)) {
      try {
        const ln = await fetchListenNotesEpisodes(q, { limit, timeout: 15000 });
        merged = mergePodcastResults([...merged, ...ln], limit);
      } catch {}
    }

    if (!merged.length) {
      const msg =
        baseSettled.find(s => s.status === 'rejected')?.reason?.message ||
        'No podcast episodes found';
      return send(res, 200, { podcasts: [], query: q, warning: msg });
    }
    return send(res, 200, { podcasts: merged, query: q });
  } catch (e) {
    return send(res, 502, { error: e.message || 'Podcast search failed' });
  }
}

async function handleImageSearch(reqUrl, res) {
  const q = String(reqUrl.searchParams.get('q') || '').trim();
  const articleUrl = String(reqUrl.searchParams.get('url') || '').trim();
  const sourceDomainParam = String(reqUrl.searchParams.get('sourceDomain') || '').trim().replace(/^www\./, '');
  const sourceNameParam = String(reqUrl.searchParams.get('sourceName') || '').trim();
  if (!q && !articleUrl) return send(res, 400, { error: 'Missing query' });

  let hostHint = '';
  if (sourceDomainParam && !/(^|\.)(news\.google\.com|bing\.com|search\.brave\.com|duckduckgo\.com|startpage\.com|qwant\.com)$/.test(sourceDomainParam)) {
    hostHint = sourceDomainParam;
  } else {
    try { hostHint = new URL(articleUrl).hostname.replace(/^www\./, ''); } catch {}
  }
  const hostQuery = hostHint ? `site:${hostHint}` : '';
  const query = [q, sourceNameParam, hostQuery].filter(Boolean).join(' ').trim();
  const params = new URLSearchParams({
    q: query,
    categories: 'images',
    format: 'json',
    language: 'en-US',
    safesearch: '0'
  });
  const imageUrl = `${SEARXNG_URL}/search?${params.toString()}`;

  try {
    const r = await request(imageUrl, { timeout: 12000 });
    if (r.status !== 200) return send(res, 200, { imageUrl: null });
    const data = JSON.parse(r.body || '{}');
    const rows = Array.isArray(data.results) ? data.results : [];

    const score = (row) => {
      let s = 0;
      const u = String(row?.img_src || row?.thumbnail || '').toLowerCase();
      const t = String(row?.title || '').toLowerCase();
      const srcUrl = String(row?.url || '').toLowerCase();
      if (/^https?:\/\//i.test(u)) s += 2;
      if (hostHint && srcUrl.includes(hostHint)) s += 3;
      if (hostHint && !srcUrl.includes(hostHint)) s -= 2;
      if (hostHint && t.includes(hostHint.split('.')[0])) s += 1;
      if (/\.(svg)(?:$|[?#])/.test(u)) s -= 6;
      if (/(logo|icon|sprite|avatar|favicon|pixel|blank|spacer|placeholder|default-image|noimage|no-image)\b/i.test(u)) s -= 5;
      if (/(download|app-?store|play-?store|badge|chevron|arrow|glyph)\b/i.test(u)) s -= 6;
      if (/(download|app\s*store|play\s*store|logo|icon|badge|arrow|glyph)\b/i.test(t)) s -= 5;
      if (/(download|app-?store|play-?store|badge|chevron|arrow|glyph|logo|icon)\b/i.test(srcUrl)) s -= 5;
      if (/(gstatic|googleusercontent|twimg|gravatar|ui-avatars|cdn-icons|iconfinder|flaticon|favicon)/i.test(u + ' ' + srcUrl)) s -= 4;
      if (/(pinterest|pinimg|shutterstock|gettyimages|istockphoto)/i.test(u + ' ' + srcUrl)) s -= 4;
      return s;
    };

    const best = rows
      .map(row => {
        const img = String(row?.img_src || row?.thumbnail || '').trim();
        return { img, s: score(row) };
      })
      .filter(x => /^https?:\/\//i.test(x.img))
      .sort((a, b) => b.s - a.s)[0];

    return send(res, 200, { imageUrl: best?.img || null });
  } catch {
    return send(res, 200, { imageUrl: null });
  }
}

// ─── Intelligence proxy (Tavily search + Ollama synthesis) ───────────────────

// Use a fast, small model for web synthesis
const VALE_CHAT_MODEL = process.env.VALE_CHAT_MODEL || 'qwen3:latest';
const VALE_TIMEOUT_MS = Number(process.env.VALE_TIMEOUT_MS || 85000);

// Serialize background intelligence requests (intelligence reports) — one at a time
// Chat requests bypass the queue and run immediately so the user isn't blocked
let _valeQueue = Promise.resolve();
let _valeBusy = false;
async function handleVale(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch(e) { return send(res, 400, { error: 'Bad JSON' }); }
    if (body.chat) {
      // Chat: run immediately, don't block on queue
      runVale(res, body).catch(() => {});
    } else {
      // Background intelligence: serialize, but do not allow deep queue pileups
      if (_valeBusy) return send(res, 429, { error: 'Intelligence engine is busy. Try again in a moment.' });
      _valeBusy = true;
      _valeQueue = _valeQueue
        .then(() => runVale(res, body))
        .catch(() => {})
        .finally(() => { _valeBusy = false; });
    }
  });
}

async function runValeInternal(body) {
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (!query) throw new Error('Missing query');
  const { systemInstructions } = body || {};
  const timeoutMs = Math.max(10000, Math.min(180000, Number(body?.timeoutMs || VALE_TIMEOUT_MS)));

  console.log(`[Intelligence] Starting request: "${query.slice(0, 60)}..."`);

  // 1. Search Tavily for sources
  let searchResults = [];
  try {
    searchResults = await tavilySearch({ query, maxResults: 8, timeout: Math.min(timeoutMs, 15000) });
  } catch (e) {
    console.warn(`[Intelligence] Tavily search failed: ${e.message}`);
  }

  if (!searchResults.length) {
    throw new Error('No search results available');
  }

  // 2. Build prompt with sources
  const sourcesText = searchResults.map((r, i) =>
    `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content.slice(0, 500)}`
  ).join('\n\n');

  const prompt = systemInstructions
    ? `${systemInstructions}\n\nUSER QUERY: ${query}\n\nWEB SOURCES:\n${sourcesText}\n\nProvide a comprehensive response based on the sources above. Cite specific information.`
    : `You are an intelligence analyst. Answer the user's query using the web sources provided.\n\nUSER QUERY: ${query}\n\nWEB SOURCES:\n${sourcesText}\n\nProvide a comprehensive, well-sourced response.`;

  // 3. Call Ollama for synthesis
  const ollamaBase = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  const ollamaPayload = {
    model: VALE_CHAT_MODEL,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    think: false, // qwen3 reasoning roughly doubles synthesis time and blows the 25s chat tier budget
    options: { temperature: 0.3 }
  };

  const or = await request(`${ollamaBase}/api/chat`, {
    method: 'POST',
    body: JSON.stringify(ollamaPayload),
    timeout: Math.min(timeoutMs, 60000)
  });

  if (or.status < 200 || or.status >= 300) {
    throw new Error(`Ollama synthesis failed (${or.status})`);
  }

  const od = JSON.parse(or.body || '{}');
  const message = String(od?.message?.content || '').trim();

  if (!message) {
    throw new Error('Ollama returned empty synthesis');
  }

  console.log(`[Intelligence] Done. Message length: ${message.length}`);

  return {
    message,
    sources: searchResults.map(r => ({
      title: r.title,
      url: r.url
    }))
  };
}

async function runVale(res, body) {
  const isChat = !!body?.chat;
  if (!isChat) {
    try {
      const out = await withHardTimeout(runValeInternal(body), 88000, 'Vale request timed out — try again');
      send(res, 200, out);
    } catch (e) {
      console.error(`[Intelligence] Error: ${e.message}`);
      send(res, 502, { error: e.message });
    }
    return;
  }
  // Chat: 3-tier chain — Tavily + Ollama synthesis (25s) → full article fetch → snippet fallback
  try {
    const bodyForSynthesis = { ...body, disableRetries: true, timeoutMs: 22000 };
    const out = await withHardTimeout(runValeInternal(bodyForSynthesis), 25000, 'Intelligence synthesis timed out');
    console.log('[Chat] Answered via Tavily + Ollama synthesis');
    send(res, 200, out);
    return;
  } catch (e) {
    console.warn(`[Chat] Synthesis tier failed (${e.message}); trying full-article search`);
  }
  try {
    const out = await runChatSearch(body);
    console.log('[Chat] Answered via full-article search');
    send(res, 200, out);
    return;
  } catch (e) {
    console.warn(`[Chat] Full-article search failed (${e.message}); trying snippet fallback`);
  }
  try {
    const out = await runChatFallback(body);
    console.log('[Chat] Answered via snippet fallback');
    send(res, 200, out);
  } catch (fe) {
    console.error(`[Chat] All tiers failed: ${fe.message}`);
    send(res, 502, { error: 'Web search unavailable — all search paths failed.' });
  }
}

function extractArticleText(html, maxChars = 3000) {
  return String(html || '')
    .replace(/<(script|style|nav|header|footer|aside|noscript|figure|figcaption)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

async function fetchArticleText(url, timeoutMs = 8000) {
  try {
    const r = await withHardTimeout(
      request(url, { timeout: timeoutMs }),
      timeoutMs + 500,
      'Article fetch timed out'
    );
    if (r.status !== 200) return null;
    const ct = String(r.headers?.['content-type'] || '');
    if (!ct.includes('html')) return null;
    const text = extractArticleText(r.body, 3000);
    return text.length > 100 ? text : null;
  } catch (_) {
    return null;
  }
}

async function runChatSearch(body) {
  const query = String(body?.query || '').trim();
  if (!query) throw new Error('Missing query');
  const ollamaBase = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  const storyCtx = body?.storyContext || null;
  const disambig = storyCtx?.title && !query.toLowerCase().includes(storyCtx.title.toLowerCase())
    ? `${query} ${storyCtx.title}`.trim()
    : query;

  // Tier 1: Tavily web search (primary since Vane/SearXNG is deprecated)
  let searchResults = [];
  try {
    const tavilyResults = await tavilySearch({ query: disambig, maxResults: 8, timeout: 15000 });
    searchResults = tavilyResults.map(r => ({
      title: r.title,
      url: r.url,
      source: 'tavily',
      publishedDate: null,
      content: r.content,
    }));
  } catch (e) {
    console.warn(`[Chat] Tavily search failed: ${e.message}`);
  }

  // Tier 2: RSS direct feeds if Tavily came up sparse
  if (searchResults.length < 3) {
    try {
      const [gRss, bRss] = await Promise.all([
        fetchGoogleNewsFallback(disambig, { timeout: 12000, limit: 8 }).catch(() => []),
        fetchBingNewsFallback(disambig, { timeout: 12000, limit: 8 }).catch(() => []),
      ]);
      const rssItems = [...gRss, ...bRss].map(r => ({
        title: r.title || '',
        url: r.url || '',
        source: r.source?.domain || 'rss',
        publishedDate: r.date || null,
        content: r.summary || '',
      }));
      // Merge deduped by URL
      const seen = new Set(searchResults.map(r => r.url));
      for (const item of rssItems) {
        if (!seen.has(item.url)) { searchResults.push(item); seen.add(item.url); }
      }
    } catch (_) {}
  }

  if (!searchResults.length) throw new Error('No results from any source');

  // Fetch top 5 article bodies in parallel — skip on timeout, no total block
  const topResults = searchResults.slice(0, 5);
  const fetched = await Promise.all(
    topResults.map(async r => {
      const fullText = await fetchArticleText(r.url, 8000);
      return {
        title: String(r.title || '').trim(),
        url: String(r.url || '').trim(),
        source: String(r.engine || '').trim(),
        date: r.publishedDate ? new Date(r.publishedDate).toDateString() : 'recent',
        snippet: String(r.content || '').slice(0, 400),
        fullText,
      };
    })
  );

  const articles = fetched.filter(a => a.fullText || a.snippet);
  if (!articles.length) throw new Error('No article content retrieved');

  const webContext = articles.map((a, i) =>
    `[${i + 1}] ${a.title}\nSource: ${a.source} | Date: ${a.date} | URL: ${a.url}\n${(a.fullText || a.snippet).slice(0, 2500)}`
  ).join('\n\n---\n\n');

  const storyLine = storyCtx?.title ? `\nTracked story context: "${storyCtx.title}"` : '';
  const prompt = `You are an intelligence analyst.${storyLine}

USER QUERY: "${query}"

ARTICLE CONTENT (${articles.length} articles):
${webContext}

Read the articles and answer the query. Ignore articles that are clearly off-topic.
Return JSON:
{
  "headline": "5-8 word title for this intelligence note",
  "summary": "3-5 sentence executive summary naming specific facts, dates, and actors from the articles",
  "keyPoints": ["3-5 specific bullet-point takeaways drawn from article content"],
  "informationGaps": ["1-2 things not addressed in the sources that matter for the query"],
  "sourcesUsed": [1, 2]
}`;

  const ollamaPayload = {
    model: VALE_CHAT_MODEL,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    format: 'json',
    options: { temperature: 0.15 }
  };
  const or = await request(`${ollamaBase}/api/chat`, { method: 'POST', body: JSON.stringify(ollamaPayload), timeout: 50000 });
  if (or.status < 200 || or.status >= 300) throw new Error(`Ollama ${or.status}`);
  let parsed = {};
  try { parsed = JSON.parse(JSON.parse(or.body || '{}')?.message?.content || '{}'); } catch (_) {}
  const summary = String(parsed.summary || '').trim();
  if (!summary) throw new Error('Empty synthesis from Ollama');

  const usedSet = new Set((parsed.sourcesUsed || []).map(n => Number(n) - 1));
  const sources = articles
    .filter((_, i) => !parsed.sourcesUsed?.length || usedSet.has(i))
    .filter(a => a.url)
    .slice(0, 6)
    .map(a => ({ title: a.title, url: a.url }));

  return {
    headline: String(parsed.headline || query).slice(0, 100),
    message: summary,
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 5) : [],
    informationGaps: Array.isArray(parsed.informationGaps) ? parsed.informationGaps.slice(0, 2) : [],
    sources,
    fallback: true,
  };
}

async function runChatFallback(body) {
  const query = String(body?.query || '').trim();
  if (!query) throw new Error('Missing query');
  const ollamaBase = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  // Disambiguate query with story context when available
  const storyCtx = body?.storyContext || null;
  const disambig = storyCtx?.title
    ? `${query} ${(storyCtx.actors || []).slice(0, 2).join(' ')}`.trim()
    : query;

  // Use Tavily instead of deprecated SearXNG/Vane
  let rawResults = [];
  try {
    const tavilyResults = await tavilySearch({ query: disambig, maxResults: 10, timeout: 15000 });
    rawResults = tavilyResults.map(r => ({
      title: r.title,
      url: r.url,
      engine: 'tavily',
      publishedDate: null,
      content: r.content,
    }));
  } catch (e) {
    console.warn(`[ChatFallback] Tavily search failed: ${e.message}`);
  }

  const snippets = rawResults.map(r => ({
    title: r.title || '',
    url: r.url || '',
    source: r.engine || '',
    date: r.publishedDate ? new Date(r.publishedDate).toDateString() : 'recent',
    content: String(r.content || '').slice(0, 280),
  }));
  const webContext = snippets.length
    ? snippets.map((s, i) => `[${i+1}] ${s.title} (${s.source}, ${s.date})\n${s.content}`).join('\n\n')
    : '(No web results retrieved — answer from training knowledge only.)';
  const storyLine = storyCtx?.title ? `\nStory context: "${storyCtx.title}"` : '';
  const prompt = `You are an intelligence analyst. The user is asking about a news topic.${storyLine}

RECENT WEB RESULTS:
${webContext}

USER QUERY: ${query}

Return a JSON object with exactly these fields:
{
  "headline": "5-8 word summary title for this intelligence note",
  "summary": "3-5 sentence executive summary of the latest developments. Be specific — name sources, dates, and key actors. Discard any results that are clearly off-topic for the query.",
  "keyPoints": ["3-5 bullet-point key takeaways or developments"],
  "informationGaps": ["1-2 things that remain unclear or unconfirmed"],
  "sourcesUsed": [indices of the numbered results you actually used, e.g. [1,3,5]]
}`;
  const ollamaPayload = {
    model: VALE_CHAT_MODEL,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    format: 'json',
    options: { temperature: 0.15 }
  };
  const or = await request(`${ollamaBase}/api/chat`, {
    method: 'POST',
    body: JSON.stringify(ollamaPayload),
    timeout: 45000
  });
  if (or.status < 200 || or.status >= 300) throw new Error(`Ollama fallback ${or.status}`);
  const od = JSON.parse(or.body || '{}');
  let parsed = {};
  try { parsed = JSON.parse(od?.message?.content || '{}'); } catch (_) {}
  const summary = String(parsed.summary || od?.message?.content || '').trim();
  if (!summary) throw new Error('Ollama fallback returned empty content');
  const usedIndices = new Set((parsed.sourcesUsed || []).map(n => Number(n) - 1));
  const sources = snippets
    .filter((_, i) => !parsed.sourcesUsed || usedIndices.has(i))
    .filter(s => s.url)
    .slice(0, 6)
    .map(s => ({ title: s.title, url: s.url }));
  return {
    headline: String(parsed.headline || query).slice(0, 100),
    message: summary,
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 5) : [],
    informationGaps: Array.isArray(parsed.informationGaps) ? parsed.informationGaps.slice(0, 2) : [],
    sources,
    fallback: true,
  };
}

function buildHomeValePayload(stories, brief) {
  const safeStories = Array.isArray(stories) ? stories : [];
  const storyBriefs = Array.isArray(brief?.storyBriefs) ? brief.storyBriefs : [];
  const storyLines = safeStories.map((s, idx) => {
    const sb = storyBriefs.find(x => String(x?.story?.id || '') === String(s?.id || ''));
    // Use the LLM-generated summary if available, otherwise fall back to story metadata
    const hint = String(
      sb?.brief?.summary
      || sb?.brief?.keyPoints?.[0]
      || sb?.brief?.keyDevelopments?.[0]
      || s?.summary
      || ''
    ).trim();
    const velocity = String(sb?.brief?.velocity || '').trim();
    return `${idx + 1}. **${s?.title || 'Untitled story'}**${velocity ? ` [${velocity}]` : ''}${hint ? `\n   Context: ${hint.slice(0, 300)}` : ''}`;
  }).join('\n\n');
  // IMPORTANT: `query` is what the search backend actually searches the web with — keep it a clean
  // topic list. Instructional/essay language here gets parsed for search terms and can
  // surface unrelated junk (dictionary definitions, tracking-page spam) instead of the topics.
  const titleList = safeStories.map(s => String(s?.title || '').trim()).filter(Boolean).join('; ');
  const query = titleList || 'latest news';
  const systemInstructions = `You are a senior intelligence analyst providing a cross-story synthesis for a tracked narrative monitoring system.

Tracked narratives:

${storyLines}

Write a flowing, analytical report of approximately 600-800 words. Structure it as follows:
1. A 2-3 sentence overview of the most significant patterns across all tracked stories
2. For each story: one paragraph covering the latest developments, key players, and what the coverage signals
3. A cross-story synthesis section: identify connections, shared themes, convergences, or systemic patterns linking two or more stories

Write in active voice. Do not use bullet points. Focus on what is actually happening in the world right now — new events, recent decisions, emerging tensions. If a story is quiet, say so briefly and move on. Include at least 10 distinct web sources in the output metadata.`;
  return { query, systemInstructions };
}

function buildStoryValePayload(story) {
  // IMPORTANT: `query` is what the search backend actually searches the web with — keep it a clean
  // topic phrase. Instructional/essay language here gets parsed for search terms and can
  // surface unrelated junk (dictionary definitions, tracking-page spam) instead of the topic.
  const title = String(story?.title || '').trim();
  const query = title || 'latest news';
  const systemInstructions = `You are a professional senior intelligence analyst. Provide a comprehensive, multi-paragraph analysis (approximately 400-600 words) of the latest web information and context regarding this specific topic: "${title}". Structure your response with a summary of recent events, an analysis of systemic significance, and potential future trajectories. Focus on developments from the last 14 days. Include at least 8 distinct, high-quality web sources in the output metadata.`;
  return { query, systemInstructions };
}

function cacheStoryIntelligence(storyId, briefObj) {
  updateCacheFile((cache) => {
    const sc = { ...(cache.storyCache || {}) };
    const cur = { ...(sc[storyId] || {}) };
    cur.intelligence = { generatedAt: nowIso(), brief: briefObj };
    sc[storyId] = cur;
    cache.storyCache = sc;
    return cache;
  });
}

function cacheHomeBrief(brief) {
  updateCacheFile((cache) => {
    cache.brief = { ...brief };
    return cache;
  });
}

function cacheHomeVale(vale) {
  updateCacheFile((cache) => {
    cache.vale = { ...vale };
    return cache;
  });
}

function beginIntelJob(scope, storyId = '') {
  _intelJob = {
    id: makeJobId(),
    scope,
    storyId: storyId || '',
    state: 'running',
    progress: 'Starting…',
    startedAt: nowIso(),
    updatedAt: nowIso(),
    error: '',
    generatedAt: '',
    message: 'Intelligence generation started',
    cancelRequested: false,
  };
  return _intelJob;
}

function updateIntelJob(patch) {
  if (!_intelJob) return;
  _intelJob = { ..._intelJob, ...(patch || {}), updatedAt: nowIso() };
}

function throwIfIntelCancelled() {
  if (_intelJob?.state === 'running' && _intelJob?.cancelRequested) {
    const e = new Error('Intelligence generation cancelled');
    e.code = 'cancelled';
    throw e;
  }
}

async function runHomeIntelligenceJob(body) {
  logIntel('run_home_begin', { jobId: _intelJob?.id || '', scope: 'home' });
  throwIfIntelCancelled();
  const requestStories = Array.isArray(body?.stories) ? body.stories : [];
  const fileStories = readStoriesFile();
  const storyMap = new Map();
  for (const s of fileStories) {
    const sid = String(s?.id || '').trim();
    if (!sid) continue;
    storyMap.set(sid, s);
  }
  for (const s of requestStories) {
    const sid = String(s?.id || '').trim();
    if (!sid) continue;
    const prev = storyMap.get(sid);
    if (!prev) {
      storyMap.set(sid, s);
      continue;
    }
    const prevUpdated = new Date(prev?.updatedAt || prev?.createdAt || 0).getTime();
    const nextUpdated = new Date(s?.updatedAt || s?.createdAt || 0).getTime();
    const prevEpCount = Array.isArray(prev?.episodes) ? prev.episodes.length : 0;
    const nextEpCount = Array.isArray(s?.episodes) ? s.episodes.length : 0;
    if (nextUpdated > prevUpdated || nextEpCount > prevEpCount) {
      storyMap.set(sid, s);
    }
  }
  const stories = storyMap.size > 0 ? Array.from(storyMap.values()) : (requestStories.length ? requestStories : fileStories);
  const activeStories = stories.filter((s) => {
    const status = String(s?.status || '').toLowerCase();
    return (s?.episodes || []).length > 0 && status !== 'resolved' && status !== 'deleted';
  });
  logIntel('run_home_storyset', {
    jobId: _intelJob?.id || '',
    scope: 'home',
    requestStories: requestStories.length,
    fileStories: fileStories.length,
    mergedStories: stories.length,
    activeStories: activeStories.length
  });
  const settings = body?.settings || {};
  const force = !!body?.force;
  // Default: reuse home brief for up to 24h unless explicitly overridden by env.
  const HOME_REUSE_TTL_MS = Number(process.env.HOME_BRIEF_REUSE_TTL_MS || (24 * 60 * 60 * 1000));
  const cacheSnapshot = readCacheFile() || {};
  const priorBrief = cacheSnapshot?.brief || null;
  const priorVale = cacheSnapshot?.vale || null;
  const storyCache = cacheSnapshot?.storyCache || {};
  const nowMs = Date.now();
  const toMs = (v) => {
    const n = new Date(v || 0).getTime();
    return Number.isFinite(n) ? n : 0;
  };
  if (!activeStories.length) throw new Error('No active stories to analyze');

  const fallbackStoryBrief = (story, reason, prev) => {
    if (prev && typeof prev === 'object') {
      return {
        ...prev,
        warning: `Using cached story brief due to timeout/error: ${String(reason || 'unknown')}`
      };
    }
    return {
      velocity: 'steady',
      velocityNote: 'Fresh web delta unavailable in this run.',
      sourceDiversityFlag: 'yellow',
      sourceDiversityNote: 'Fallback mode: web-source diversity analysis unavailable.',
      keyDevelopments: ['No reliable fresh developments were retrieved in this run.'],
      keyPoints: ['Retry to refresh for new web developments.'],
      keyPlayers: (story?.actors || []).slice(0, 6).map(name => ({ name, role: 'Actor from story metadata' })),
      watchSignals: ['Watch for new coverage and rerun the daily brief.'],
      informationGaps: ['Fresh coverage may be delayed or temporarily unavailable.'],
      actionableItems: ['Run regenerate to refresh the web-development brief.'],
      likelyNextSteps: ['Monitor for new developments over the next 24 hours.'],
      warning: `Generated fallback story brief due to timeout/error: ${String(reason || 'unknown')}`
    };
  };

  const priorStoryIds = Array.isArray(priorBrief?.storyBriefs)
    ? priorBrief.storyBriefs.map(x => String(x?.story?.id || '')).filter(Boolean).sort()
    : [];
  const activeStoryIds = activeStories.map(s => String(s?.id || '')).filter(Boolean).sort();
  const sameStorySet = priorStoryIds.length === activeStoryIds.length
    && priorStoryIds.every((id, i) => id === activeStoryIds[i]);
  const priorBriefFresh = (toMs(priorBrief?.generatedAt) > 0) && ((nowMs - toMs(priorBrief?.generatedAt)) <= HOME_REUSE_TTL_MS);

  const plan = activeStories.map(story => {
    const sid = String(story?.id || '');
    const entry = storyCache?.[sid]?.intelligence || null;
    const cachedBrief = entry?.brief || null;
    const cachedGenMs = toMs(entry?.generatedAt);
    const storyTouchedMs = Math.max(toMs(story?.updatedAt), toMs(story?.createdAt));
    const unchangedSinceCache = !!(cachedGenMs && storyTouchedMs && storyTouchedMs <= cachedGenMs);
    const cacheAgeMs = cachedGenMs ? (nowMs - cachedGenMs) : Number.POSITIVE_INFINITY;
    const reusable = !force && !!cachedBrief && unchangedSinceCache && cacheAgeMs <= HOME_REUSE_TTL_MS;
    return { story, sid, entry, cachedBrief, reusable };
  });

  const reusableCount = plan.filter(p => p.reusable).length;
  const allReusable = reusableCount === plan.length && plan.length > 0;

  let execSummary = '';
  let crossBrief = null;
  let homeValeFromDelta = null;
  let deltaValeError = '';
  const storyBriefs = [];

  const priorIsDeltaMode = String(priorBrief?.briefMode || '') === 'vane-delta';
  if (allReusable && priorIsDeltaMode && priorBriefFresh && sameStorySet && String(priorBrief?.execSummary || '').trim()) {
    updateIntelJob({ progress: `Reusing cached briefs for ${plan.length} unchanged stor${plan.length === 1 ? 'y' : 'ies'}…` });
    for (const p of plan) {
      storyBriefs.push({
        story: p.story,
        brief: { ...p.cachedBrief, reused: true, reuseReason: 'unchanged' }
      });
      logIntel('run_home_story_reused', { jobId: _intelJob?.id || '', scope: 'home', storyId: p.sid });
    }
    execSummary = String(priorBrief.execSummary || '').trim();
    crossBrief = priorBrief.crossBrief || null;
  } else {
    const pending = [];
    for (const p of plan) {
      if (p.reusable) {
        storyBriefs.push({
          story: p.story,
          brief: { ...p.cachedBrief, reused: true, reuseReason: 'unchanged' }
        });
        logIntel('run_home_story_reused', { jobId: _intelJob?.id || '', scope: 'home', storyId: p.sid });
      } else {
        pending.push(p);
      }
    }
    let bundle = null;
    if (pending.length) {
      updateIntelJob({ progress: `Searching fresh developments for ${pending.length} stor${pending.length === 1 ? 'y' : 'ies'}…` });
      try {
        const deltaVale = await runValeInternal({
          ...buildHomeDeltaValePayload(pending.map(p => p.story)),
          timeoutMs: 80000,   // 80s per attempt — qwen3:latest completes in ~50-60s when warm
          disableRetries: true // one attempt only; fail fast rather than burning 6+ minutes
        });
        homeValeFromDelta = { ...deltaVale, generatedAt: nowIso() };
        bundle = parseModelJson(String(deltaVale?.message || '{}'));
        bundle = decorateDeltaBundleWithTitles(bundle, pending.map(p => p.story));
        try {
          homeValeFromDelta.message = JSON.stringify(bundle, null, 2);
        } catch {}
        logIntel('run_home_vane_delta_parsed', {
          jobId: _intelJob?.id || '',
          scope: 'home',
          msgLength: String(deltaVale?.message || '').length,
          msgPreview: String(deltaVale?.message || '').replace(/\s+/g, ' ').slice(0, 300),
          bundleKeys: Object.keys(bundle || {}),
          storyRowCount: Array.isArray(bundle?.stories) ? bundle.stories.length : (Array.isArray(bundle?.storyBriefs) ? bundle.storyBriefs.length : 0),
          allNoNews: Array.isArray(bundle?.stories) && bundle.stories.length > 0
            && bundle.stories.every(r => r.noNews === true || String(r.noNews).toLowerCase() === 'true')
        });
      } catch (e) {
        const msg = String(e?.message || 'unknown');
        deltaValeError = msg;
        logIntel('run_home_vane_delta_failed', { jobId: _intelJob?.id || '', scope: 'home', error: msg });
        bundle = null;
      }
      throwIfIntelCancelled();
    }

    const rows = Array.isArray(bundle?.stories)
      ? bundle.stories
      : (Array.isArray(bundle?.storyBriefs) ? bundle.storyBriefs : []);
    const byStoryId = new Map();
    const byStoryTitle = new Map();
    for (const row of rows) {
      const sid = String(
        row?.storyId ||
        row?.id ||
        row?.story?.id ||
        ''
      ).trim();
      if (sid) byStoryId.set(sid, row);
      const t = normalizeStoryKey(
        row?.title ||
        row?.storyTitle ||
        row?.story?.title ||
        ''
      );
      if (t) byStoryTitle.set(t, row);
    }

    const arr = v => Array.isArray(v) ? v.filter(Boolean) : [];
    const keyPlayersFrom = (v, fallbackActors = []) => {
      const raw = Array.isArray(v) ? v : [];
      const out = raw
        .map(p => (typeof p === 'string'
          ? { name: String(p).trim(), role: 'Key player in current developments' }
          : { name: String(p?.name || '').trim(), role: String(p?.role || 'Key player in current developments').trim() }))
        .filter(p => p.name);
      if (out.length) return out.slice(0, 6);
      return (fallbackActors || []).slice(0, 4).map(name => ({ name, role: 'Actor from story metadata' }));
    };

    // Guardrail: if Vane reports no-news but fresh items are present, override with evidence-backed brief.
    const evidenceByStory = new Map();
    await Promise.all(pending.map(async (p) => {
      const cachedHeadlines = Array.isArray(storyCache?.[p.sid]?.headlines?.items)
        ? storyCache[p.sid].headlines.items
        : [];
      const ev = await fetchFreshEvidenceForStory(p.story, cachedHeadlines).catch(() => ({ fresh: [] }));
      evidenceByStory.set(p.sid, ev);
    }));

    // Fix C: If ALL pending stories still show evCount=0 (SearxNG returned nothing usable),
    // do a single broad fallback pass — bare title query, no time filter, take any results.
    const allEvidenceEmpty = pending.every(p => {
      const ev = evidenceByStory.get(p.sid) || { fresh: [] };
      return (Array.isArray(ev.fresh) ? ev.fresh.length : 0) === 0;
    });
    if (allEvidenceEmpty && pending.length > 0) {
      logIntel('run_home_evidence_broad_fallback', { jobId: _intelJob?.id || '', scope: 'home', pendingCount: pending.length });
      await Promise.all(pending.map(async (p) => {
        try {
          const title = String(p.story?.title || '').trim();
          if (!title) return;
          const r = await fetchNewsFromSearx(title, { engines: NEWS_ENGINE_LIST, timeRange: 'week', timeout: 10000 });
          const broadRows = normalizeNewsResults(r.results || []).slice(0, 6);
          if (broadRows.length > 0) evidenceByStory.set(p.sid, { query: title, fresh: broadRows });
        } catch {}
      }));
    }

    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      const titleKey = normalizeStoryKey(p.story?.title || '');
      const row = byStoryId.get(p.sid)
        || byStoryTitle.get(titleKey)
        || (rows.length === pending.length ? rows[i] : null);
      let ev = evidenceByStory.get(p.sid) || { fresh: [] };
      let evCount = Array.isArray(ev.fresh) ? ev.fresh.length : 0;
      if (evCount === 0) {
        const cachedFallback = normalizeCachedHeadlineRows(storyCache?.[p.sid]?.headlines?.items || []).slice(0, 6);
        if (cachedFallback.length) {
          ev = { ...(ev || {}), fresh: cachedFallback };
          evCount = cachedFallback.length;
        }
      }
      const noNewsFromVane = String(row?.noNews || '').toLowerCase() === 'true' || row?.noNews === true;
      const noNewsFlag = noNewsFromVane && evCount === 0;
      let brief;
      // Evidence wins whenever Vane says no-news OR Vane has no row for this story at all.
      if (evCount > 0 && (noNewsFromVane || !row)) {
        brief = await generateEvidenceBackedBrief(p.story, ev.fresh, settings);
      } else if (!row || noNewsFlag) {
        brief = buildNoNewsBrief(p.story);
      } else {
        brief = {
          velocity: ['accelerating', 'steady', 'decelerating', 'stalled'].includes(String(row.velocity || '').toLowerCase())
            ? String(row.velocity).toLowerCase()
            : 'steady',
          velocityNote: String(row.velocityNote || '').trim() || 'Based on net-new web developments since the last episode date.',
          keyDevelopments: arr(row.keyDevelopments).slice(0, 3),
          keyPlayers: keyPlayersFrom(row.keyPlayers, p.story?.actors || []),
          keyPoints: arr(row.keyPoints).slice(0, 3),
          actionableItems: arr(row.actionableItems).slice(0, 2),
          watchSignals: arr(row.watchSignals).slice(0, 2),
          informationGaps: arr(row.informationGaps).slice(0, 2),
          likelyNextSteps: arr(row.likelyNextSteps).slice(0, 2),
          sourceDiversityFlag: ['green', 'yellow', 'red'].includes(String(row.sourceDiversityFlag || '').toLowerCase())
            ? String(row.sourceDiversityFlag).toLowerCase()
            : 'yellow',
          sourceDiversityNote: String(row.sourceDiversityNote || '').trim() || 'Generated from web-search delta.'
        };
      }
      storyBriefs.push({ story: p.story, brief });
      logIntel('run_home_story_delta_done', {
        jobId: _intelJob?.id || '',
        scope: 'home',
        storyId: p.sid,
        via: 'vane',
        hasRow: !!row,
        noNews: !!noNewsFlag,
        evidenceCount: evCount,
        overriddenByEvidence: noNewsFromVane && evCount > 0,
        matchedBy: byStoryId.get(p.sid) ? 'id' : (byStoryTitle.get(titleKey) ? 'title' : (rows.length === pending.length ? 'index' : 'none'))
      });
      throwIfIntelCancelled();
    }

    // Build execSummary from actual brief data if Vane delta returned boilerplate no-news
    const rawVaneExecSummary = String(bundle?.execSummary || bundle?.summary || '').trim();
    const vaneExecIsBoilerplate = !rawVaneExecSummary
      || /no significant new|no notable new|no new develop|most stories.*stagnant|no recent activity/i.test(rawVaneExecSummary);
    if (vaneExecIsBoilerplate) {
      const accel = storyBriefs.filter(s => s?.brief?.velocity === 'accelerating').length;
      const steady = storyBriefs.filter(s => s?.brief?.velocity === 'steady').length;
      const stalled = storyBriefs.filter(s => s?.brief?.velocity === 'stalled' || s?.brief?.velocity === 'decelerating').length;
      const topTitles = storyBriefs.slice(0, 4).map(s => String(s?.story?.title || '')).filter(Boolean);
      execSummary = `Monitoring ${storyBriefs.length} tracked stor${storyBriefs.length === 1 ? 'y' : 'ies'}: ${accel} accelerating, ${steady} steady, ${stalled} stalled. Tracking: ${topTitles.join(', ')}${storyBriefs.length > 4 ? ', and others' : ''}.`;
    } else {
      execSummary = rawVaneExecSummary;
    }
    crossBrief = null;
  }

  const briefOut = { generatedAt: nowIso(), briefMode: 'vane-delta', execSummary, storyBriefs, crossBrief };
  cacheHomeBrief(briefOut);
  throwIfIntelCancelled();

  // ── Live Web Intelligence: genuine Vane cross-story synthesis ─────────
  // This is a separate Vane call that asks for a real narrative synthesis
  // across all tracked stories — not a rehash of per-story bullet data.
  updateIntelJob({ progress: 'Running live web synthesis across all stories…' });
  let valeWarning = '';
  try {
    const valePayload = buildHomeValePayload(activeStories, { storyBriefs, crossBrief });
    const valeSynthesis = await runValeInternal({
      ...valePayload,
      timeoutMs: 90000,
      disableRetries: true
    });
    throwIfIntelCancelled();
    if (!String(valeSynthesis?.message || '').trim()) throw new Error('Intelligence synthesis returned empty message');
    cacheHomeVale({ ...valeSynthesis, generatedAt: nowIso() });
    logIntel('run_home_vale_synthesis_ok', { jobId: _intelJob?.id || '', scope: 'home', msgLength: valeSynthesis.message.length });
  } catch (e) {
    valeWarning = String(e?.message || 'Intelligence synthesis failed');
    logIntel('run_home_vale_synthesis_failed', { jobId: _intelJob?.id || '', scope: 'home', error: valeWarning });
    // Fallback: build structured brief from story data
    const synthesized = buildHomeValeFromStoryBriefs(execSummary, storyBriefs, `Live web synthesis unavailable: ${valeWarning}`);
    if (priorVale && String(priorVale.message || '').trim() && !priorVale.error) {
      // Preserve most recent good vale with a staleness note
      cacheHomeVale({ ...priorVale, stale: true, warning: 'Showing previous live web report — synthesis temporarily unavailable.', failedAt: nowIso() });
    } else {
      cacheHomeVale({ ...synthesized, generatedAt: nowIso() });
    }
  }

  updateIntelJob({
    state: 'completed',
    generatedAt: nowIso(),
    progress: 'Completed',
    message: valeWarning
      ? `Intelligence completed; live web synthesis failed (${valeWarning})`
      : 'Intelligence and live web synthesis completed'
  });
  logIntel('run_home_completed', { jobId: _intelJob?.id || '', scope: 'home' });
}

async function runStoryIntelligenceJob(body) {
  logIntel('run_story_begin', { jobId: _intelJob?.id || '', scope: 'story', storyId: body?.story?.id || '', title: body?.story?.title || '' });
  throwIfIntelCancelled();
  const story = body?.story;
  if (!story?.id) throw new Error('Missing story payload');
  const settings = body?.settings || {};
  const prev = readCacheFile()?.storyCache?.[story.id]?.intelligence?.brief || null;
  const preservedVale = prev?.valeReport || null;

  updateIntelJob({ progress: `Analyzing "${story.title}"…` });
  const b = await generateStoryBriefServer(story, settings);
  throwIfIntelCancelled();
  const baseBrief = preservedVale ? { ...b, valeReport: preservedVale } : b;
  cacheStoryIntelligence(story.id, baseBrief);
  throwIfIntelCancelled();

  updateIntelJob({ progress: 'Starting live web intelligence…' });
  await new Promise(r => setTimeout(r, 4000));
  throwIfIntelCancelled();
  try {
    const vr = await runValeInternal(buildStoryValePayload(story));
    throwIfIntelCancelled();
    cacheStoryIntelligence(story.id, { ...b, valeReport: vr });
  } catch {
    cacheStoryIntelligence(story.id, baseBrief);
  }

  updateIntelJob({
    state: 'completed',
    generatedAt: nowIso(),
    progress: 'Completed',
    message: `Story intelligence completed: ${story.title}`
  });
  logIntel('run_story_completed', { jobId: _intelJob?.id || '', scope: 'story', storyId: story.id || '' });
}

async function handleIntelligenceStart(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { return send(res, 400, { error: 'Bad JSON' }); }
  const scope = String(body?.scope || '').toLowerCase();
  const storyId = String(body?.storyId || body?.story?.id || '').trim();
  if (!scope || !['home', 'story'].includes(scope)) return send(res, 400, { error: 'Invalid scope' });
  if (scope === 'story' && !storyId) return send(res, 400, { error: 'Missing storyId' });

  const cur = cleanFinishedJob(_intelJob);
  _intelJob = cur;
  if (cur && cur.state === 'running') {
    logIntel('start_blocked_409', {
      requestedScope: scope,
      requestedStoryId: storyId,
      activeJobId: cur.id || '',
      activeScope: cur.scope || '',
      activeStoryId: cur.storyId || ''
    });
    return send(res, 409, {
      error: 'Another intelligence process is already in progress and should complete soon.',
      activeJob: cur
    });
  }

  const job = beginIntelJob(scope, scope === 'story' ? storyId : '');
  logIntel('start_accepted', { jobId: job.id || '', scope, storyId: job.storyId || '' });
  send(res, 202, { ok: true, job });

  Promise.resolve().then(async () => {
    try {
      if (scope === 'home') await runHomeIntelligenceJob(body);
      else await runStoryIntelligenceJob(body);
    } catch (e) {
      if (e?.code === 'cancelled') {
        logIntel('run_cancelled', { jobId: _intelJob?.id || '', scope: _intelJob?.scope || scope, storyId: _intelJob?.storyId || storyId });
        return updateIntelJob({
          state: 'cancelled',
          progress: 'Cancelled',
          message: 'Intelligence generation cancelled',
          error: ''
        });
      }
      logIntel('run_error', {
        jobId: _intelJob?.id || '',
        scope: _intelJob?.scope || scope,
        storyId: _intelJob?.storyId || storyId,
        error: e?.message || 'Intelligence generation failed'
      });
      updateIntelJob({
        state: 'error',
        error: e?.message || 'Intelligence generation failed',
        message: 'Intelligence generation failed'
      });
    }
  }).catch(() => {});
}

async function handleIntelligenceStatus(reqUrl, res) {
  const scope = String(reqUrl.searchParams.get('scope') || '').toLowerCase();
  const storyId = String(reqUrl.searchParams.get('storyId') || '').trim();
  if (!scope || !['home', 'story'].includes(scope)) return send(res, 400, { error: 'Invalid scope' });
  const status = getIntelligenceStatus(scope, storyId);
  return send(res, 200, status);
}

async function handleIntelligenceCancel(req, res) {
  let body = {};
  try { body = await readJsonBody(req); } catch { body = {}; }
  const scope = String(body?.scope || '').toLowerCase();
  const storyId = String(body?.storyId || '').trim();
  const cur = cleanFinishedJob(_intelJob);
  _intelJob = cur;
  if (!cur || cur.state !== 'running') return send(res, 200, { ok: true, cancelled: false, message: 'No running intelligence job' });
  if (scope && scope !== cur.scope) return send(res, 200, { ok: true, cancelled: false, message: 'No matching running job' });
  if (scope === 'story' && storyId && String(cur.storyId || '') !== storyId) {
    return send(res, 200, { ok: true, cancelled: false, message: 'No matching running story job' });
  }
  updateIntelJob({
    cancelRequested: true,
    state: 'running',
    progress: 'Cancelling…',
    message: 'Cancellation requested'
  });
  return send(res, 200, { ok: true, cancelled: true, job: _intelJob });
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function send(res, status, obj) {
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const reqUrl = new URL(req.url, 'http://localhost');
  const rawPathname = reqUrl.pathname || '/';
  const pathname = rawPathname.length > 1 ? rawPathname.replace(/\/+$/, '') : rawPathname;

  // Handle both /data and /api/lateral/data just in case
  const isData   = pathname === '/data'   || pathname === '/api/lateral/data';
  const isCache  = pathname === '/cache'  || pathname === '/api/lateral/cache';
  const isSettings = pathname === '/settings' || pathname === '/api/lateral/settings';
  const isVale   = pathname === '/vale'   || pathname === '/api/lateral/vale';
  const isSearch = pathname === '/search' || pathname === '/api/lateral/search';
  const isVideos = pathname === '/videos' || pathname === '/api/lateral/videos';
  const isPodcasts = pathname === '/podcasts' || pathname === '/api/lateral/podcasts';
  const isImage = pathname === '/image' || pathname === '/api/lateral/image';
  const isFetch  = pathname === '/fetch'  || pathname === '/api/lateral/fetch';
  const isOg     = pathname === '/og'     || pathname === '/api/lateral/og';
  const isLlmChat = pathname === '/llm/chat' || pathname === '/api/lateral/llm/chat';
  const isLlmProviders = pathname === '/llm/providers' || pathname === '/api/lateral/llm/providers';
  const isLlmSecrets = pathname === '/llm/secrets' || pathname === '/api/lateral/llm/secrets';
  const isLlmModels = pathname === '/llm/models' || pathname === '/api/lateral/llm/models';
  const isLlmPing = pathname === '/llm/ping' || pathname === '/api/lateral/llm/ping';
  const isIntelStart  = pathname === '/intelligence/start'  || pathname === '/api/lateral/intelligence/start';
  const isIntelStatus = pathname === '/intelligence/status' || pathname === '/api/lateral/intelligence/status';
  const isIntelCancel = pathname === '/intelligence/cancel' || pathname === '/api/lateral/intelligence/cancel';
  const isRefreshLog  = pathname === '/refresh-log'         || pathname === '/api/lateral/refresh-log';
  const isTavilySocial = pathname === '/tavily-social' || pathname === '/api/lateral/tavily-social';
  const isTavilyUsage  = pathname === '/tavily/usage'  || pathname === '/api/lateral/tavily/usage';
  const isRelCheck    = pathname === '/relevance/check'    || pathname === '/api/lateral/relevance/check';
  const isRelOverride = pathname === '/relevance/override' || pathname === '/api/lateral/relevance/override';
  const isImgResolve  = pathname === '/images/resolve' || pathname === '/api/lateral/images/resolve';
  const isImgStats    = pathname === '/images/stats'   || pathname === '/api/lateral/images/stats';

  const isBackup  = pathname === '/backup'       || pathname === '/api/lateral/backup';
  const isRestore = pathname === '/restore'      || pathname === '/api/lateral/restore';
  const isHealth  = pathname === '/health/check' || pathname === '/api/lateral/health/check';
  const isAgentsConfig = pathname === '/agents/config' || pathname === '/api/lateral/agents/config';
  const isAgentsTest   = pathname === '/agents/test'   || pathname === '/api/lateral/agents/test';
  const opsCtx = { dataDir: DATA_DIR, send, getTavilyKey: () => resolveLlmSecrets().tavilyApiKey };
  if (/^(\/api\/lateral)?\/article-audio\//.test(pathname)) {
    if (await require('./article-audio').route(req, reqUrl, res, send) !== false) return;
  }
  if (pathname.startsWith('/archive/') || pathname.startsWith('/api/lateral/archive/')) {
    if (await archive.route(req, reqUrl, res, send) !== false) return;
  }
  if (/^(\/api\/lateral)?\/foryou(\/|$)/.test(pathname)) {
    if (await require('./foryou').route(req, reqUrl, res, send) !== false) return;
  }
  if (/^(\/api\/lateral)?\/calendar\//.test(pathname)) {
    if (await require('./calendar').route(req, reqUrl, res, send) !== false) return;
  }
  if (/^(\/api\/lateral)?\/feeds?\//.test(pathname)) {
    if (await feeds.route(req, reqUrl, res, send) !== false) return;
  }
  if (pathname.startsWith('/alerts/') || pathname.startsWith('/api/lateral/alerts/')) {
    if (await alerts.route(req, reqUrl, res, send) !== false) return;
  }
  if (pathname.startsWith('/civic/') || pathname.startsWith('/api/lateral/civic/')) {
    if (await civic.route(req, reqUrl, res, send) !== false) return;
  }
  if (pathname.startsWith('/podcast/') || pathname.startsWith('/api/lateral/podcast/')) {
    if (await podcasts.route(req, reqUrl, res, send) !== false) return;
  }
  if (pathname.startsWith('/dedupe/') || pathname.startsWith('/api/lateral/dedupe/')) {
    if (await dedupe.route(req, reqUrl, res, send) !== false) return;
  }
  if (isBackup  && req.method === 'GET')  return ops.handleBackup(res, opsCtx);
  if (isRestore && req.method === 'POST') return ops.handleRestore(req, res, opsCtx);
  if (isHealth  && req.method === 'GET')  return await ops.handleHealth(res, opsCtx);
  if (isImgResolve && req.method === 'POST') return await handleImagesResolve(req, res);
  if (isImgStats && req.method === 'GET') return send(res, 200, images.getStats());
  if (isRelCheck && req.method === 'POST') return await handleRelevanceCheck(req, res);
  if (isRelOverride && req.method === 'POST') return await handleRelevanceOverride(req, res);
  if (pathname === '/relevance/sweep' || pathname === '/api/lateral/relevance/sweep') return send(res, 200, req.method === 'POST' ? await sweepHeadlines() : sweepState);

  if (isData) {
    if (req.method === 'GET')  return await handleDataGet(res);
    if (req.method === 'POST') return await handleDataPost(req, res);
  }
  if (isCache) {
    if (req.method === 'GET')  return await handleCacheGet(res);
    if (req.method === 'POST') return await handleCachePost(req, res);
  }
  if (isSettings) {
    if (req.method === 'GET')  return await handleSettingsGet(res);
    if (req.method === 'POST') return await handleSettingsPost(req, res);
  }
  if (isAgentsConfig) {
    if (req.method === 'GET')  return await handleAgentsGet(res);
    if (req.method === 'POST') return await handleAgentsPost(req, res);
  }
  if (isAgentsTest && req.method === 'POST') return await handleAgentsTest(req, res);
  if (isVale && req.method === 'POST') return await handleVale(req, res);
  if (isLlmProviders && req.method === 'GET') return await handleLlmProviders(res);
  if (isLlmModels && req.method === 'GET') return await handleLlmModels(reqUrl, res);
  if (isLlmChat && req.method === 'POST') return await handleLlmChat(req, res);
  if (isLlmPing && req.method === 'POST') return await handleLlmPing(req, res);
  if (isLlmSecrets && req.method === 'GET') return await handleLlmSecretsGet(res);
  if (isLlmSecrets && req.method === 'POST') return await handleLlmSecretsPost(req, res);
  if (isIntelStart && req.method === 'POST') return await handleIntelligenceStart(req, res);
  if (isIntelStatus && req.method === 'GET') return await handleIntelligenceStatus(reqUrl, res);
  if (isIntelCancel && req.method === 'POST') return await handleIntelligenceCancel(req, res);
  if (isRefreshLog  && req.method === 'GET')  return send(res, 200, readRefreshLog());
  if (isTavilySocial && req.method === 'GET') {
    try {
      const q = reqUrl.searchParams.get('q') || '';
      const domains = (reqUrl.searchParams.get('domains') || '').split(',').map(s => s.trim()).filter(Boolean);
      const maxResults = Number(reqUrl.searchParams.get('max')) || 8;
      if (!q.trim()) return send(res, 400, { error: 'Missing q' });
      const results = await tavilySearch({ query: q, domains, maxResults });
      return send(res, 200, { results });
    } catch (e) {
      return send(res, 502, { error: e.message || 'Tavily search failed' });
    }
  }
  if (isTavilyUsage && req.method === 'GET') return await handleTavilyUsage(res);
  if (isSearch) return await handleVaneSearch(reqUrl, res);
  if (isVideos) return await handleVideos(reqUrl, res);
  if (isPodcasts) return await handlePodcasts(reqUrl, res);
  if (isImage) return await handleImageSearch(reqUrl, res);
  if (isOg) return await handleOg(reqUrl, res);

  if (isFetch) {
    const target = reqUrl.searchParams.get('url');
    try { const r = await request(target); send(res, 200, { content: r.body }); }
    catch (e) { send(res, 502, { error: e.message }); }
    return;
  }

  // Lateral v2 routes
  const llmConfig = {
    apiKey: resolveLlmSecrets().moonshotApiKey || ANTHROPIC_API_KEY_ENV || GEMINI_API_KEY_ENV,
    baseUrl: resolveLlmSecrets().moonshotBaseUrl || 'https://api.moonshot.ai/v1',
  };
  const v2Handled = v2.route(req, reqUrl, res, llmConfig);
  if (v2Handled !== false) return;

  res.statusCode = 404;
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => { console.log(`Lateral proxy ready on :${PORT}`); });
alerts.init({ getTavilyKey: () => resolveLlmSecrets().tavilyApiKey, runChecks: () => ops.runChecks({ dataDir: DATA_DIR, getTavilyKey: () => resolveLlmSecrets().tavilyApiKey }) });

// ── Auto-refresh scheduler ─────────────────────────────────────────────────────
async function runAutoRefresh() {
  const stories = readStoriesFile();
  const active = stories.filter(s => s.status !== 'resolved' && s.status !== 'buried');
  if (!active.length) return;
  const settings = readJsonFileSafe(SETTINGS_FILE, {});
  const baseHours = Math.max(1, Number(settings?.autoRefreshHours ?? 8));
  const MAX_INTERVAL_HOURS = Math.max(baseHours, 72);
  console.log(`[AutoRefresh] Tick — checking ${active.length} active stories (base interval ${baseHours}h)`);
  const cache = readCacheFile();
  const run = { at: nowIso(), stories: [] };
  let checkedCount = 0;

  for (const story of active) {
    const sc = cache?.storyCache?.[story.id] || {};
    const refreshState = sc.refreshState || {};
    const nextCheckAtMs = refreshState.nextCheckAt ? new Date(refreshState.nextCheckAt).getTime() : 0;
    // Adaptive cadence: a story that's gone quiet for a while doesn't need
    // checking every tick — skip it until its own back-off interval is up,
    // rather than spending a search (and Tavily/SearXNG credits) on every
    // active story every single tick regardless of how fast it's moving.
    if (nextCheckAtMs && Date.now() < nextCheckAtMs) {
      run.stories.push({ id: story.id, title: story.title, coverage: 'skipped', intervalHours: refreshState.intervalHours || baseHours, nextCheckAt: refreshState.nextCheckAt });
      continue;
    }
    checkedCount++;
    const prev = Array.isArray(sc?.headlines?.items) ? sc.headlines.items : [];
    const prevCount   = prev.length;
    const prevDomains = new Set(prev.map(a => hostFromUrl(a.url || '')).filter(Boolean));
    const prevUrls    = new Set(prev.map(a => a.url).filter(Boolean));
    try {
      const query = buildStoryWebDeltaQuery(story);
      // Broader time range for scheduler — not just today
      // Feeds you attached to this story join the search results (and still count if the search engines are down).
      const userFeeds = feeds.hasFeeds(story.id) ? await feeds.itemsForStory(story.id) : { items: [] };
      // A Civic watch story also gets its official items (legislation, bills, rules) from civic-watch.js.
      const civicRes = civicWatch.hasWatch(story.id) ? await civicWatch.itemsForStory(story.id) : { items: [] };
      const feedRes = { items: [...userFeeds.items, ...civicRes.items] };
      let r = { results: [] };
      try { r = await fetchNewsFromSearx(query, { engines: NEWS_ENGINE_LIST, timeRange: 'week', timeout: 15000 }); }
      catch (searchErr) { if (!feedRes.items.length) throw searchErr; }
      const rawArticles = [...feedRes.items, ...normalizeNewsResults(r.results || []).slice(0, 12)];
      // Only articles that belong to the story reach its headlines (and the Home feed, and the "new coverage" alerts). Fails open:
      // an article the judge could not read is kept. Earlier headlines are re-checked too, which is quick once they have verdicts.
      const gate = await relevance.gateStory(story, rawArticles);
      const prevGate = await relevance.gateStory(story, prev);
      const articles = stampFirstSeenServer(gate.kept, prevGate.kept);
      const newCount   = articles.length;
      const newDomains = articles.map(a => hostFromUrl(a.url || '')).filter(Boolean);
      const novelDomains = [...new Set(newDomains.filter(d => !prevDomains.has(d)))];
      // The actual novel headlines, not just a count — this is what makes the
      // log a genuine record instead of a number that means nothing once the
      // moment has passed.
      const novelHeadlines = articles.filter(a => a.url && !prevUrls.has(a.url))
        .slice(0, 8)
        .map(a => ({ title: a.title, url: a.url, source: a.source }));
      const coverage = newCount === 0 ? 'silent'
        : newCount > prevCount || novelDomains.length > 0 ? 'growing' : 'stable';

      // Back off on true silence (doubling, capped); snap straight back to the
      // base interval the moment there's any real sign of life — a story
      // waking up shouldn't have to wait out a slow ramp-back-up.
      const prevStreak = Number(refreshState.consecutiveSilent) || 0;
      const consecutiveSilent = coverage === 'silent' ? prevStreak + 1 : 0;
      const intervalHours = coverage === 'silent'
        ? Math.min(MAX_INTERVAL_HOURS, baseHours * Math.pow(2, Math.min(consecutiveSilent, 4)))
        : baseHours;
      const nextCheckAtIso = new Date(Date.now() + intervalHours * 3600000).toISOString();

      // Merge with the previous list rather than wholesale-replacing it —
      // mirrors the same merge the client does in HeadlinesFeed, so a
      // background auto-refresh cycle doesn't quietly undo the client's own
      // accumulated headline list the next time this story is opened.
      const mergedByUrl = new Map();
      for (const a of articles) if (a.url) mergedByUrl.set(a.url, a);
      for (const a of prevGate.kept) if (a.url && !mergedByUrl.has(a.url)) mergedByUrl.set(a.url, a);
      const mergedItems = [...mergedByUrl.values()]
        .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
        .slice(0, 30);

      updateCacheFile(c => {
        const scc = { ...(c.storyCache || {}) };
        const cur = { ...(scc[story.id] || {}) };
        // Keep the reviewable "Filtered out" list: new rejects first, earlier ones that are still rejected after them.
        const filtered = relevance.mergeFiltered((cur.headlines && cur.headlines.filtered) || [], [...gate.filtered, ...prevGate.filtered], mergedItems);
        cur.headlines = { ...(cur.headlines || {}), items: mergedItems, filtered, generatedAt: nowIso() };
        cur.refreshState = { intervalHours, consecutiveSilent, nextCheckAt: nextCheckAtIso, lastCoverage: coverage };
        scc[story.id] = cur;
        c.storyCache = scc;
        return c;
      });

      run.stories.push({ id: story.id, title: story.title, prevCount, newCount, novelDomains, novelHeadlines, coverage, intervalHours, nextCheckAt: nextCheckAtIso });
      console.log(`[AutoRefresh] ${story.title}: ${prevCount}→${newCount} (${coverage}) — next check in ${intervalHours}h`);
    } catch (e) {
      run.stories.push({ id: story.id, title: story.title, error: e.message, coverage: 'error' });
      console.warn(`[AutoRefresh] ${story.title}: error — ${e.message}`);
    }
  }
  appendRefreshRun(run);
  try { alerts.onRefreshRun(run); } catch (e) { console.warn('[Alerts] refresh hook:', e.message); }
  console.log(`[AutoRefresh] Done. Checked: ${checkedCount}/${active.length}, Growing: ${run.stories.filter(s=>s.coverage==='growing').length}, Silent: ${run.stories.filter(s=>s.coverage==='silent').length}, Skipped: ${run.stories.filter(s=>s.coverage==='skipped').length}`);
}

function scheduleAutoRefresh() {
  const settings = readJsonFileSafe(SETTINGS_FILE, {});
  const hours = Math.max(0, Number(settings?.autoRefreshHours ?? 8));
  if (hours === 0) { console.log('[AutoRefresh] Disabled (autoRefreshHours=0)'); return; }
  const ms = hours * 60 * 60 * 1000;
  // A container restart (deploys, debugging, etc.) used to unconditionally fire
  // a fresh run 30s after every boot, regardless of how recently the last real
  // run happened — meaning a handful of restarts in one day could re-run the
  // refresh far more often than the configured interval, for no benefit, since
  // nothing new had actually changed between them. Check the persisted last-run
  // timestamp and only run early if we're actually overdue.
  const log = readRefreshLog();
  const lastRunAt = log?.lastRunAt ? new Date(log.lastRunAt).getTime() : 0;
  const elapsed = lastRunAt ? Date.now() - lastRunAt : Infinity;
  const initialDelay = elapsed >= ms ? 30000 : (ms - elapsed);
  console.log(`[AutoRefresh] Scheduled every ${hours}h (next run in ~${Math.round(initialDelay / 60000)}m)`);
  setTimeout(function fire() {
    runAutoRefresh().catch(e => console.error('[AutoRefresh] Error:', e.message));
    setInterval(() => runAutoRefresh().catch(e => console.error('[AutoRefresh] Error:', e.message)), ms);
  }, initialDelay);
}

scheduleAutoRefresh();

// "For you" (the top of Home) gathers alerts, the calendar and a daily podcast pass. The pass reuses the same podcast search the app uses.
require('./foryou').init({
  searchPodcasts: async (q, limit = 12) => {
    let out = {};
    const capture = { headersSent: false, writeHead() {}, end(b) { try { out = JSON.parse(b); } catch { out = {}; } this.headersSent = true; } };
    await handlePodcasts(new URL('http://localhost/api/lateral/podcasts?q=' + encodeURIComponent(q) + '&limit=' + limit), capture);
    return out.podcasts || [];
  },
});

// ─── Headline sweep ──────────────────────────────────────────────────────────
// Re-checks the headlines already cached for every active story (the Home feed shows them): articles that were stored before the
// background refresh was gated, or while the judge was down, get judged now, and the off-topic ones move to the story's reviewable
// "Filtered out" list. Quick once an article has a verdict. One run at a time; started by POST /relevance/sweep, and once after the
// first start of this version.
const SWEEP_FLAG = path.join(DATA_DIR, 'relevance-sweep.json');
let sweepState = { state: 'idle' };
async function sweepHeadlines() {
  if (sweepState.state === 'running') return sweepState;
  const stories = readStoriesFile().filter(s => s.status !== 'resolved' && s.status !== 'buried');
  sweepState = { state: 'running', startedAt: nowIso(), done: 0, total: stories.length, checked: 0, removed: 0, failedOpen: 0, errors: [] };
  const st = sweepState;
  (async () => {
    for (const story of stories) {
      try {
        const items = readCacheFile()?.storyCache?.[story.id]?.headlines?.items || [];
        if (items.length) {
          const gate = await relevance.gateStory(story, items);
          st.checked += items.length; st.failedOpen += (gate.stats && gate.stats.failedOpen) || 0;
          if (gate.stats && gate.stats.error) st.errors.push(gate.stats.error);
          if (gate.filtered.length) {
            const gone = new Set(gate.filtered.map(a => a.url));
            updateCacheFile(c => {
              const scc = { ...(c.storyCache || {}) };
              const cur = { ...(scc[story.id] || {}) };
              const h = { ...(cur.headlines || {}) };
              h.items = (h.items || []).filter(a => !gone.has(a.url));
              h.filtered = relevance.mergeFiltered(h.filtered || [], gate.filtered, h.items);
              cur.headlines = h; scc[story.id] = cur; c.storyCache = scc;
              return c;
            });
            st.removed += gate.filtered.length;
          }
        }
      } catch (e) { st.errors.push(e.message); }
      st.done++;
    }
    st.state = 'done'; st.finishedAt = nowIso(); st.errors = [...new Set(st.errors)].slice(0, 3);
    console.log(`[Sweep] Checked ${st.checked} cached headlines in ${st.total} stories: ${st.removed} moved to Filtered out${st.failedOpen ? `, ${st.failedOpen} could not be judged` : ''}`);
    try { fs.writeFileSync(SWEEP_FLAG, JSON.stringify({ version: 1, at: st.finishedAt, removed: st.removed, failedOpen: st.failedOpen })); } catch { /* not fatal */ }
  })().catch(e => { st.state = 'error'; st.errors.push(e.message); });
  return st;
}
// Once, shortly after the first start of this version, and again when an earlier sweep could not judge everything.
setTimeout(() => {
  let prev = null; try { prev = JSON.parse(fs.readFileSync(SWEEP_FLAG, 'utf8')); } catch { /* first time */ }
  if (!prev || prev.failedOpen > 0) sweepHeadlines().catch(() => {});
}, 90 * 1000);


// ── Model warmup (opt-in) ──────────────────────────────────────────────────────
// Keeps the chat model loaded in Ollama memory so the first AI request is fast.
// OFF by default: pinning a model every 4 minutes evicts any larger model sharing a
// small GPU, forcing it to reload and lose its prompt cache. Set LATERAL_MODEL_WARMUP=1
// to enable. When enabled it runs once on startup (after a short delay) and then every 4 minutes.
const LATERAL_MODEL_WARMUP = process.env.LATERAL_MODEL_WARMUP === '1';
const VANE_WARMUP_OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const VANE_WARMUP_MODEL      = VALE_CHAT_MODEL;
const VANE_WARMUP_INTERVAL   = 4 * 60 * 1000; // 4 min (just under Ollama's 5-min eviction)

async function warmVaneModel() {
  try {
    const r = await request(`${VANE_WARMUP_OLLAMA_URL}/api/generate`, {
      method:  'POST',
      // No prompt = Ollama preloads the model without running inference.
      // This extends keep_alive without competing with real Vane requests.
      body:    JSON.stringify({ model: VANE_WARMUP_MODEL, keep_alive: '10m' }),
      timeout: 15000,
    });
    if (r.status === 200) {
      console.log(`[Warmup] Model ${VANE_WARMUP_MODEL} warmed and pinned (keep_alive=10m)`);
    } else {
      console.warn(`[Warmup] HTTP ${r.status}`);
    }
  } catch (e) {
    console.warn(`[Warmup] Failed: ${e.message}`);
  }
}

if (LATERAL_MODEL_WARMUP) {
  setTimeout(() => {
    warmVaneModel();
    setInterval(warmVaneModel, VANE_WARMUP_INTERVAL);
  }, 10000); // wait 10s for Ollama to be ready after container start
}
