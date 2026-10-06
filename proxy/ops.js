'use strict';
// Operational endpoints: data backup / restore, and the setup health check.
//   GET  /backup        -> JSON bundle of your Lateral data (never includes API keys)
//   POST /restore       -> replace your data with a bundle made by /backup (current data is kept as *.pre-restore-*)
//   GET  /health/check  -> is Ollama reachable, are the models pulled, does the Tavily key work, ...

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// Files that make up "your data". Secrets (llm-secrets.json) are deliberately excluded, and so are
// caches that rebuild themselves (cache.json, image-cache.json, logs).
const BACKUP_FILES = ['stories.json', 'v2.json', 'settings.json', 'relevance-cache.json', 'purged-ids.json'];
const BUNDLE_FORMAT = 'lateral-backup';
const MAX_RESTORE_BYTES = 64 * 1024 * 1024;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function counts(files) {
  const stories = files['stories.json'];
  const v2 = files['v2.json'];
  return {
    stories: Array.isArray(stories?.stories) ? stories.stories.length : 0,
    predictions: Array.isArray(v2?.predictions) ? v2.predictions.length : 0,
    articles: Array.isArray(v2?.items) ? v2.items.length : 0,
  };
}

function handleBackup(res, { dataDir, send }) {
  const files = {};
  for (const name of BACKUP_FILES) {
    const full = path.join(dataDir, name);
    if (fs.existsSync(full)) files[name] = readJson(full, null);
  }
  const bundle = { format: BUNDLE_FORMAT, version: 1, createdAt: new Date().toISOString(), counts: counts(files), files };
  send(res, 200, bundle);
}

function validateBundle(bundle) {
  if (!bundle || bundle.format !== BUNDLE_FORMAT || typeof bundle.files !== 'object' || !bundle.files) {
    return 'That file is not a Lateral backup.';
  }
  const f = bundle.files;
  for (const name of Object.keys(f)) {
    if (!BACKUP_FILES.includes(name)) return `Unexpected file in backup: ${name}`;
  }
  if (f['stories.json'] && !Array.isArray(f['stories.json'].stories)) return 'Backup has a malformed stories file.';
  if (f['v2.json']) {
    const v = f['v2.json'];
    if (!Array.isArray(v.predictions) || !Array.isArray(v.items) || !Array.isArray(v.links)) return 'Backup has a malformed predictions file.';
  }
  if (!Object.keys(f).length) return 'The backup is empty.';
  return null;
}

function handleRestore(req, res, { dataDir, send }) {
  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > MAX_RESTORE_BYTES) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const bundle = body.bundle || body;
      const problem = validateBundle(bundle);
      if (problem) return send(res, 400, { error: problem });
      if (body.dryRun) return send(res, 200, { ok: true, dryRun: true, createdAt: bundle.createdAt || null, counts: counts(bundle.files) });

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const kept = [];
      for (const name of Object.keys(bundle.files)) {
        const full = path.join(dataDir, name);
        if (fs.existsSync(full)) { fs.copyFileSync(full, `${full}.pre-restore-${stamp}`); kept.push(name); }
        fs.writeFileSync(full, JSON.stringify(bundle.files[name]), 'utf8');
      }
      send(res, 200, { ok: true, restored: Object.keys(bundle.files), counts: counts(bundle.files), previousKept: kept.length ? `*.pre-restore-${stamp}` : null });
    } catch (e) {
      send(res, 400, { error: 'Could not read that backup: ' + e.message });
    }
  });
}

// ─── Health check ────────────────────────────────────────────────────────────────

function get(urlStr, { headers = {}, timeout = 4000 } = {}) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve({ error: 'bad URL' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET', headers, timeout }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', e => resolve({ error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timed out' }); });
    req.end();
  });
}

function modelMatches(installed, wanted) {
  const w = String(wanted).toLowerCase();
  const wBase = w.includes(':') ? w : `${w}:latest`;
  return installed.some(m => { const n = String(m).toLowerCase(); return n === w || n === wBase || n.split(':')[0] === w.split(':')[0] && !w.includes(':'); });
}

async function handleHealth(res, { dataDir, send, getTavilyKey }) {
  const checks = [];
  const add = (id, label, status, detail, fix) => checks.push({ id, label, status, detail, fix: fix || '' });

  // Ollama + models
  const ollama = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const tags = await get(`${ollama}/api/tags`);
  let installed = [];
  if (tags.error || tags.status !== 200) {
    add('ollama', 'Ollama (local AI)', 'fail', `Not reachable at ${ollama} (${tags.error || 'HTTP ' + tags.status}).`,
      'Start Ollama on this computer. On Linux, run it with OLLAMA_HOST=0.0.0.0 so Docker containers can reach it.');
  } else {
    try { installed = (JSON.parse(tags.body).models || []).map(m => m.name); } catch {}
    add('ollama', 'Ollama (local AI)', 'ok', `Running — ${installed.length} model${installed.length === 1 ? '' : 's'} installed.`);
    const needed = [
      [process.env.LATERAL_SCORING_MODEL || process.env.VALE_CHAT_MODEL || 'qwen3:latest', 'scoring and query generation', 'fail'],
      [process.env.LATERAL_RELEVANCE_MODEL || 'qwen3:latest', 'the relevance filter', 'fail'],
      [process.env.LATERAL_IMAGE_JUDGE_MODEL || 'qwen3:latest', 'the image-fit judge', 'warn'],
      [process.env.LATERAL_VISION_MODEL || 'moondream:latest', 'the image judge (describes pictures)', 'warn'],
    ];
    const seen = new Set();
    for (const [model, why, level] of needed) {
      if (seen.has(model)) continue;
      seen.add(model);
      if (modelMatches(installed, model)) add(`model:${model}`, `Model ${model}`, 'ok', `Installed (used for ${why}).`);
      else add(`model:${model}`, `Model ${model}`, level, `Not installed — needed for ${why}.`, `Run:  ollama pull ${model.replace(/:latest$/, '')}`);
    }
  }

  // Tavily — /usage does not spend credits
  const key = getTavilyKey();
  if (!key) {
    add('tavily', 'Tavily web search', 'fail', 'No API key saved.', 'Open Settings → Web search and paste a key (free at app.tavily.com).');
  } else {
    const r = await get('https://api.tavily.com/usage', { headers: { Authorization: `Bearer ${key}` }, timeout: 8000 });
    if (r.error) add('tavily', 'Tavily web search', 'warn', `Could not reach Tavily (${r.error}).`, 'Check your internet connection.');
    else if (r.status === 401 || r.status === 403) add('tavily', 'Tavily web search', 'fail', 'Tavily rejected the saved key.', 'Open Settings → Web search and paste a valid key.');
    else if (r.status >= 200 && r.status < 300) add('tavily', 'Tavily web search', 'ok', 'Key accepted.');
    else add('tavily', 'Tavily web search', 'warn', `Tavily answered HTTP ${r.status}.`, 'Try again in a minute.');
  }

  // SearXNG (news search)
  const sx = (process.env.SEARXNG_URL || '').replace(/\/+$/, '');
  if (!sx) add('searxng', 'News search (SearXNG)', 'warn', 'SEARXNG_URL is not set.', 'Set SEARXNG_URL on the lateral-proxy service.');
  else {
    const r = await get(`${sx}/search?q=test&format=json`, { timeout: 7000 });
    if (r.error || r.status !== 200) add('searxng', 'News search (SearXNG)', 'fail', `Not answering at ${sx} (${r.error || 'HTTP ' + r.status}).`, 'Run `docker compose ps` and check `docker compose logs searxng`. JSON output must be enabled in searxng/settings.yml.');
    else add('searxng', 'News search (SearXNG)', 'ok', 'Answering.');
  }

  // Data folder
  try {
    const probe = path.join(dataDir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    add('data', 'Data folder', 'ok', `Writable (${dataDir}).`);
  } catch (e) {
    add('data', 'Data folder', 'fail', `Cannot write to ${dataDir} (${e.code || e.message}).`, 'Check the ./data folder permissions.');
  }

  const rank = { ok: 0, warn: 1, fail: 2 };
  const worst = checks.reduce((m, c) => Math.max(m, rank[c.status]), 0);
  send(res, 200, { overall: ['ok', 'warn', 'fail'][worst], checkedAt: new Date().toISOString(), checks });
}

module.exports = { handleBackup, handleRestore, handleHealth, BACKUP_FILES };
