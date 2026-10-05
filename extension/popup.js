/**
 * Lateral Chrome Extension — popup.js
 * Clip the current page as a new story or episode in Lateral.
 */

const DEFAULT_URL = 'http://localhost:8080';
const DEFAULT_OLLAMA_MODEL = 'qwen3:latest';

// ── State ──────────────────────────────────────────────────────────────────
let stories      = [];
let currentTab   = { url: '', title: '' };
let mode         = 'story';  // 'story' | 'episode'
let settings     = { lateralUrl: DEFAULT_URL, ollamaModel: DEFAULT_OLLAMA_MODEL };
let submitting   = false;
let analyzing    = false;

// ── DOM helpers ────────────────────────────────────────────────────────────
const $  = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const show = sel => $(sel)?.classList.remove('hidden');
const hide = sel => $(sel)?.classList.add('hidden');

function setInlineStatus(sel, msg, type = '') {
  const el = $(sel);
  if (!el) return;
  el.textContent = msg;
  el.className = 'inline-status' + (type ? ` ${type}` : '');
  el.classList.toggle('hidden', !msg);
}

// ── API ────────────────────────────────────────────────────────────────────
function buildApiBaseCandidates() {
  const raw = String(settings.lateralUrl || DEFAULT_URL).trim().replace(/\/+$/, '');
  let parsed = null;
  try { parsed = new URL(raw); } catch {}
  const out = [];
  const push = v => { if (v && !out.includes(v)) out.push(v); };

  if (raw) {
    push(raw + '/api/lateral');
    push(raw);
  }
  if (parsed) {
    const origin = parsed.origin;
    const path = parsed.pathname.replace(/\/+$/, '');
    push(origin + '/api/lateral');
    if (path.endsWith('/lateral')) push(origin + '/lateral/api/lateral');
    push(`${parsed.protocol}//${parsed.hostname}:3005/api/lateral`);
  }
  push('http://localhost/lateral/api/lateral');
  push('http://localhost/api/lateral');
  push('http://localhost:3005/api/lateral');
  push('http://127.0.0.1:3005/api/lateral');
  return out;
}

async function apiFetch(pathname, options = {}) {
  const path = String(pathname || '').startsWith('/') ? pathname : `/${pathname}`;
  let lastErr = 'network';
  let lastStatus = 0;
  for (const base of buildApiBaseCandidates()) {
    const url = base.replace(/\/+$/, '') + path;
    try {
      const r = await fetch(url, options);
      if (!r.ok) {
        lastStatus = r.status;
        lastErr = `HTTP ${r.status}`;
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e?.message || 'network';
    }
  }
  throw new Error(`API unavailable (${lastStatus || lastErr})`);
}

async function apiFetchJson(pathname, options = {}) {
  const path = String(pathname || '').startsWith('/') ? pathname : `/${pathname}`;
  let lastErr = 'network';
  let lastStatus = 0;
  for (const base of buildApiBaseCandidates()) {
    const url = base.replace(/\/+$/, '') + path;
    try {
      const r = await fetch(url, options);
      if (!r.ok) {
        lastStatus = r.status;
        lastErr = `HTTP ${r.status}`;
        continue;
      }
      const ct = String(r.headers.get('content-type') || '').toLowerCase();
      const text = await r.text();
      if (ct.includes('application/json') || ct.includes('text/json') || /^[\s\r\n]*[\[{]/.test(text)) {
        try {
          return JSON.parse(text || '{}');
        } catch (e) {
          lastErr = `Invalid JSON at ${url}: ${e.message}`;
          continue;
        }
      }
      // HTML or non-JSON response; try next candidate.
      lastErr = `Non-JSON response at ${url}`;
    } catch (e) {
      lastErr = e?.message || 'network';
    }
  }
  throw new Error(`API JSON unavailable (${lastStatus || lastErr})`);
}

async function fetchStories() {
  const d = await apiFetchJson('/data', { cache: 'no-store' });
  const all = Array.isArray(d?.stories) ? d.stories : [];
  return all.filter(s => String(s?.status || '').toLowerCase() !== 'deleted');
}

async function saveData(updatedStories) {
  await apiFetch('/data', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ stories: updatedStories }),
  });
}

function buildOllamaCandidates() {
  const raw = String(settings.lateralUrl || DEFAULT_URL).trim().replace(/\/+$/, '');
  let parsed = null;
  try { parsed = new URL(raw); } catch {}
  const out = [];
  const push = v => { if (v && !out.includes(v)) out.push(v); };
  const path = parsed ? parsed.pathname.replace(/\/+$/, '') : '';
  const isLateralSubpath = path.endsWith('/lateral');
  if (parsed && isLateralSubpath) {
    const origin = parsed.origin;
    push(origin + '/ollama/api/chat');
    push(`${parsed.protocol}//${parsed.hostname}:11434/api/chat`);
    push('http://localhost:11434/api/chat');
  } else if (raw) {
    push(raw + '/ollama/api/chat');
    push(raw + '/api/chat');
  }
  if (parsed && !isLateralSubpath) {
    const origin = parsed.origin;
    push(origin + '/ollama/api/chat');
    push(`${parsed.protocol}//${parsed.hostname}:11434/api/chat`);
    push('http://localhost:11434/api/chat');
  }
  return out;
}

async function ollamaFetch(messages) {
  const payload = JSON.stringify({
    model:   settings.ollamaModel || DEFAULT_OLLAMA_MODEL,
    messages,
    stream:  false,
    format:  'json',
    options: { temperature: 0.3 },
  });
  let lastErr = 'network';
  let lastStatus = 0;
  for (const u of buildOllamaCandidates()) {
    try {
      const r = await fetch(u, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      if (!r.ok) {
        lastStatus = r.status;
        lastErr = `Ollama ${r.status}`;
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e?.message || 'network';
    }
  }
  throw new Error(`Ollama unavailable (${lastStatus || lastErr})`);
}

// ── AI generation ──────────────────────────────────────────────────────────

// Strip noise tags and return up to 12 000 chars of readable body text
function extractText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  ['script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript']
    .forEach(t => doc.querySelectorAll(t).forEach(e => e.remove()));
  const m = doc.querySelector('article') || doc.querySelector('main') || doc.body;
  return (m?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 12000);
}

// Single Ollama chat call; returns parsed JSON object
async function ollamaCall(messages) {
  const r = await ollamaFetch(messages);
  return JSON.parse((await r.json()).message.content);
}

// Fetch the current page via server proxy, run AI, fill the active form
async function analyzePageAI() {
  if (analyzing || submitting) return;
  analyzing = true;
  const btn = $('#analyze-btn');
  btn.disabled    = true;
  btn.textContent = '✦ Analyzing…';
  setInlineStatus('#inline-status', '');

  try {
    const url = currentTab.url;
    if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
      throw new Error('Cannot analyze this page type');
    }

    // Pull page text via the server-side fetch proxy (avoids CORS on news sites)
    let text = cleanTitle(currentTab.title);
    try {
      const fd = await apiFetchJson(`/fetch?url=${encodeURIComponent(url)}`);
      if (fd?.content) text = extractText(fd.content);
    } catch { /* fall back to page title as context */ }

    if (mode === 'story') {
      // ── New Story: extract story identity from article ──
      const result = await ollamaCall([{
        role: 'user',
        content:
          `You are a narrative intelligence analyst. Given this article, extract a longitudinal story.\n\n` +
          `ARTICLE:\n${text}\n\n` +
          `Return JSON:\n` +
          `{\n` +
          `  "title": "Concise story title (the ongoing narrative, not just this article)",\n` +
          `  "summary": "2-3 sentences: what is this story really about at a systemic level?",\n` +
          `  "tags": ["3-5 lowercase topic/theme tags"],\n` +
          `  "actors": ["key organizations and named individuals"]\n` +
          `}`,
      }]);
      if (result.title)          $('#ns-title').value   = result.title;
      if (result.summary)        $('#ns-summary').value = result.summary;
      if (result.tags?.length)   $('#ns-tags').value    = result.tags.join(', ');
      if (result.actors?.length) $('#ns-actors').value  = result.actors.join(', ');

    } else {
      // ── Add Episode: analyze article in context of selected story ──
      const storyId = $('#ep-story').value;
      const story   = stories.find(s => s.id === storyId);
      const ctx     = (story?.episodes || []).slice(-5)
        .map(e => `[${e.type}] ${e.date}: ${e.summary || e.headline}`).join('\n');

      const result = await ollamaCall([{
        role: 'user',
        content:
          `You are tracking the story: "${story?.title || '(unknown)'}"\n\n` +
          `Story so far:\n${ctx || '(no prior episodes)'}\n\n` +
          `New article:\n${text}\n\n` +
          `Return JSON:\n` +
          `{\n` +
          `  "date": "YYYY-MM-DD",\n` +
          `  "type": "seed|development|contradiction|confirmation|escalation|burial|silence_noted",\n` +
          `  "headline": "Terse headline for this specific event",\n` +
          `  "summary": "What happened, and how does it relate to the story trajectory?",\n` +
          `  "framingNote": "Framing, bias, or structural observation",\n` +
          `  "tags": ["3-5 lowercase topic/theme tags"],\n` +
          `  "actors": ["key organizations and named individuals"]\n` +
          `}`,
      }]);
      if (result.headline)    $('#ep-headline').value = result.headline;
      if (result.date)        $('#ep-date').value     = result.date;
      if (result.type)        $('#ep-type').value     = result.type;
      if (result.summary)     $('#ep-summary').value  = result.summary;
      if (result.framingNote) $('#ep-framing').value  = result.framingNote;
      if (result.tags?.length)   $('#ep-tags').value   = result.tags.join(', ');
      if (result.actors?.length) $('#ep-actors').value = result.actors.join(', ');
    }

    setInlineStatus('#inline-status', '✦ Fields filled — review before saving', 'success');

  } catch (e) {
    setInlineStatus('#inline-status', `⚠ AI failed: ${e.message}`, 'error');
  } finally {
    analyzing       = false;
    btn.disabled    = false;
    btn.textContent = '✦ Analyze page';
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────
function genId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Remove trailing "- Publisher" / "| Site Name" suffixes common in <title> tags
function cleanTitle(raw) {
  return (raw || '')
    .replace(/\s+[-–—|]\s+[^-–—|]{2,50}$/, '')
    .replace(/\s+\|\s+[^|]{2,50}$/, '')
    .trim()
    .slice(0, 120);
}

// Check if the current URL is already tracked as an episode source
function findMatchingStory(url) {
  if (!url) return null;
  for (const s of stories) {
    if (s.episodes?.some(e => e.sourceUrl === url)) return s;
  }
  return null;
}

// ── Mode switching ─────────────────────────────────────────────────────────
function setMode(m) {
  mode = m;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === m));
  $$('.panel').forEach(p => p.classList.toggle('hidden', p.dataset.mode !== m));

  if (m === 'episode') {
    populateStoryPicker();
    if (stories.length === 0) {
      show('#no-stories-msg');
      hide('#episode-form');
      $('#submit-btn').disabled = true;
    } else {
      hide('#no-stories-msg');
      show('#episode-form');
      $('#submit-btn').disabled = false;
    }
    $('#submit-btn').textContent = 'Add Episode';
  } else {
    $('#submit-btn').disabled = false;
    $('#submit-btn').textContent = 'Add Story';
  }
}

function populateStoryPicker() {
  const sel     = $('#ep-story');
  const current = sel?.value;
  if (!sel) return;
  sel.innerHTML = stories
    .map(s => `<option value="${esc(s.id)}">${esc(s.title)}</option>`)
    .join('');
  if (current && stories.find(s => s.id === current)) sel.value = current;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Submission ─────────────────────────────────────────────────────────────
async function submitStory() {
  const title   = $('#ns-title').value.trim();
  const summary = $('#ns-summary').value.trim();
  const tags    = $('#ns-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  const actors  = $('#ns-actors').value.split(',').map(a => a.trim()).filter(Boolean);
  const url     = $('#ns-url').value.trim();

  if (!title) {
    setInlineStatus('#inline-status', '⚠ Title is required', 'warn');
    return;
  }

  const now = new Date().toISOString();
  const newStory = {
    id:        genId('s'),
    title,
    summary,
    status:    'active',
    tags,
    actors,
    createdAt: now,
    updatedAt: now,
    episodes:  url ? [{
      id:          genId('e'),
      date:        today(),
      type:        'seed',
      headline:    title,
      summary,
      framingNote: '',
      sourceUrl:   url,
      addedAt:     now,
    }] : [],
  };

  await doSave(async () => {
    const latest = await fetchStories();
    await saveData([...latest, newStory]);
    return `"${title}" added to Lateral`;
  });
}

async function submitEpisode() {
  const storyId  = $('#ep-story').value;
  const headline = $('#ep-headline').value.trim();
  const date     = $('#ep-date').value || today();
  const type     = $('#ep-type').value;
  const summary  = $('#ep-summary').value.trim();
  const framing  = $('#ep-framing').value.trim();
  const tags     = $('#ep-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  const actors   = $('#ep-actors').value.split(',').map(a => a.trim()).filter(Boolean);
  const url      = $('#ep-url').value.trim();

  if (!storyId)  { setInlineStatus('#inline-status', '⚠ Select a story', 'warn'); return; }
  if (!headline) { setInlineStatus('#inline-status', '⚠ Headline is required', 'warn'); return; }

  const newEp = {
    id:          genId('e'),
    date,
    type,
    headline,
    summary,
    framingNote: framing,
    tags,
    actors,
    sourceUrl:   url,
    addedAt:     new Date().toISOString(),
  };

  const storyTitle = stories.find(s => s.id === storyId)?.title || 'story';

  await doSave(async () => {
    const latest  = await fetchStories();
    const updated = latest.map(s => {
      if (s.id !== storyId) return s;
      return { ...s, updatedAt: new Date().toISOString(), episodes: [...(s.episodes || []), newEp] };
    });
    await saveData(updated);
    return `Episode added to "${storyTitle}"`;
  });
}

// Shared save wrapper: disables button, runs fn, shows success or error
async function doSave(fn) {
  if (submitting) return;
  submitting = true;
  $('#submit-btn').disabled  = true;
  $('#submit-btn').textContent = 'Saving…';
  setInlineStatus('#inline-status', '');

  try {
    const successMsg = await fn();
    showSuccess(successMsg);
  } catch (e) {
    setInlineStatus('#inline-status', `⚠ ${e.message}`, 'error');
    $('#submit-btn').disabled  = false;
    $('#submit-btn').textContent = mode === 'episode' ? 'Add Episode' : 'Add Story';
  } finally {
    submitting = false;
  }
}

function showSuccess(msg) {
  hide('#main');
  show('#success');
  $('#success-msg').textContent = msg;
  setTimeout(() => window.close(), 2400);
}

// ── Settings ───────────────────────────────────────────────────────────────
function openSettings() {
  hide('#main');
  hide('#error-screen');
  show('#settings-panel');
}

function closeSettings() {
  hide('#settings-panel');
  // If we have stories loaded, show main. Otherwise try to reconnect.
  if (stories.length > 0 || $('#main').dataset.loaded) {
    show('#main');
  } else {
    init();
  }
}

async function saveSettings() {
  const raw   = $('#settings-url').value.trim().replace(/\/+$/, '');
  const model = $('#settings-model').value.trim() || DEFAULT_OLLAMA_MODEL;
  if (!raw) {
    setInlineStatus('#settings-status', '⚠ URL cannot be empty', 'warn');
    return;
  }
  settings.lateralUrl  = raw;
  settings.ollamaModel = model;
  await chrome.storage.local.set({ lateralUrl: raw, ollamaModel: model });
  setInlineStatus('#settings-status', '✓ Saved', 'success');
  setTimeout(closeSettings, 800);
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  hide('#error-screen');
  hide('#main');
  hide('#success');
  hide('#settings-panel');
  show('#loading');

  // Load stored settings
  const stored = await chrome.storage.local.get(['lateralUrl', 'ollamaModel']);
  if (stored.lateralUrl)  settings.lateralUrl  = stored.lateralUrl;
  if (stored.ollamaModel) settings.ollamaModel = stored.ollamaModel;
  if (!stored.lateralUrl) {
    settings.lateralUrl = DEFAULT_URL;
  }
  // Migrate old or missing model defaults.
  if (!stored.ollamaModel || settings.ollamaModel === 'qwen2.5:14b' || settings.ollamaModel === 'qwen3:8b') {
    settings.ollamaModel = DEFAULT_OLLAMA_MODEL;
    await chrome.storage.local.set({ ollamaModel: settings.ollamaModel });
  }
  $('#settings-url').value   = settings.lateralUrl;
  $('#settings-model').value = settings.ollamaModel;

  // Get current tab
  try {
    const [tab]  = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab   = { url: tab?.url || '', title: tab?.title || '' };
  } catch { /* activeTab permission may not cover chrome:// pages */ }

  // Fetch stories from server
  try {
    stories = await fetchStories();
  } catch (e) {
    hide('#loading');
    show('#error-screen');
    $('#error-msg').textContent = `Could not reach Lateral (${e.message})`;
    return;
  }

  hide('#loading');
  show('#main');
  $('#main').dataset.loaded = '1';

  // Pre-fill fields
  const title = cleanTitle(currentTab.title);
  $('#ns-title').value    = title;
  $('#ns-url').value      = currentTab.url;
  $('#ep-headline').value = title;
  $('#ep-url').value      = currentTab.url;
  $('#ep-date').value     = today();

  // Smart default mode
  const match = findMatchingStory(currentTab.url);
  if (match) {
    setMode('episode');
    populateStoryPicker();
    $('#ep-story').value = match.id;
    setInlineStatus('#inline-status', `↳ This URL is already tracked in "${match.title}"`, 'info');
  } else {
    setMode('story');
  }
}

// ── Event listeners ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Tab switching
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    setInlineStatus('#inline-status', '');
    setMode(t.dataset.mode);
  }));

  // Submit
  $('#submit-btn').addEventListener('click', () => {
    if (mode === 'story') submitStory();
    else submitEpisode();
  });

  // Enter key on single-line inputs submits
  $$('#ns-title, #ns-tags, #ns-actors, #ep-headline, #ep-framing, #ep-tags, #ep-actors').forEach(el => {
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!submitting) {
          if (mode === 'story') submitStory();
          else submitEpisode();
        }
      }
    });
  });

  // AI analyze
  $('#analyze-btn').addEventListener('click', analyzePageAI);

  // Settings
  $('#settings-btn').addEventListener('click', openSettings);
  $('#settings-back').addEventListener('click', closeSettings);
  $('#settings-save').addEventListener('click', saveSettings);
  $('#settings-url').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveSettings();
  });

  // Error screen → settings
  $('#error-settings-btn').addEventListener('click', openSettings);

  init().catch(console.error);
});
