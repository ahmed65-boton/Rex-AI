/* ============================================================
   HYBRID AGENT ENGINE — app.js
   Dual-engine AI pipeline: Multi-Provider Cloud + Client-Side WASM
   Terminal execution bridge via WebSocket ws://127.0.0.1:8765
   File System Access API with root-guard protection
   ============================================================ */

'use strict';

// Provider credentials are loaded from API_Keys.txt or Settings.
const BUILTIN_API_KEYS = { gemini: "REPLACE---ME----WITH----YOUR----GEMINI----KEY" };
const API_KEY_FILENAMES = ['API Keys.txt', 'API_Keys.txt', 'api keys.txt', 'api_keys.txt'];
let apiKeyFileName = null;
let apiKeyFileExaOverride = null;
let apiKeyFileKeys = new Set();
let apiKeyFileSource = null;

/* ── App State ─────────────────────────────────────────────── */
const state = {
  engine: 'cloud',           // 'cloud' | 'wasm'
  provider: 'groq',          // groq | openrouter | gemini | antigravity
  modelSelections: {
    groq: 'openai/gpt-oss-120b',
    openrouter: 'openai/gpt-oss-120b',
    gemini: 'gemini-3.6-flash',
    antigravity: 'gemini-3.8-flash',
  },
  userName: '',
  chatLastAccess: null,
  streaming: false,
  abortController: null,
  wsocket: null,
  wsConnected: false,
  workspaceHandle: null,     // FileSystemDirectoryHandle
  workspaceRootName: null,   // locked root name for guard
  wasmEngine: null,          // wllama instance (if loaded)
  wasmLoaded: false,
  exaEnabled: false,
  apiKeys: {},               // provider keys persisted in IndexedDB; Exa comes from API_Keys.txt
  chatId: null,
  bridgeWorkspace: false,
  pendingCommands: {},       // id → { resolve }
  remoteMode: false,
  remoteAccessCode: sessionStorage.getItem('rexRemoteAccessCode') || '',
  remoteGateReady: null,
};

/* ── IndexedDB persistence ─────────────────────────────────── */
const DB_NAME = 'rex_ai_db';
const DB_VERSION = 10;
let dbPromise;
let historyStorage = 'indexeddb';
let scrollFrame = 0;
let streamFrame = 0;
let pendingStreamBubble = null;
let pendingStreamText = '';

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
      if (!db.objectStoreNames.contains('chats')) {
        const chats = db.createObjectStore('chats', { keyPath: 'id' });
        chats.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, value, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = key === undefined ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value, key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function parseApiKeyText(text) {
  const result = {};
  const aliases = {
    'gemini': 'gemini',
    'antigravity': 'antigravity',
    'antigravity api key': 'antigravity',
    'google antigravity': 'antigravity',
    'google gemini': 'gemini',
    'open router': 'openrouter',
    'openrouter': 'openrouter',
    'openrouter api key': 'openrouter',
    'openrouter model': 'openrouterModel',
    'groq model': 'groqModel',
    'gemini model': 'geminiModel',
    'antigravity model': 'antigravityModel',
    'pollinations': 'pollinations',
    'pollinations api key': 'pollinations',
    'pollinations model': 'pollinationsModel',
    'open code': 'openrouter',
    'opencode': 'openrouter',
    'open code api key': 'openrouter',
    'exa': 'exa',
    'exa search': 'exa',
    'groqcloud': 'groq',
    'groq': 'groq',
  };
  let pendingKey = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    if (line.includes(':')) {
      const [rawLabel, ...rest] = line.split(':');
      const key = aliases[rawLabel.trim().toLowerCase()];
      const value = rest.join(':').trim();
      if (key) {
        if (value) { result[key] = value; pendingKey = null; }
        else pendingKey = key;
        continue;
      }
    }
    if (pendingKey) {
      result[pendingKey] = line;
      pendingKey = null;
    }
  }
  return result;
}

async function loadApiKeyFile() {
  // Prefer the local bridge because it can read exact filenames even in Firefox.
  try {
    const result = await bridgeRequest({ action: 'load_api_keys' });
    if (result?.ok && result.keys) {
      apiKeyFileName = result.fileName || null;
      apiKeyFileKeys = new Set(Object.keys(result.keys));
      return result.keys;
    }
  } catch (_) {}

  // Fallback for the HTTP-served app when the bridge is not running.
  for (const filename of API_KEY_FILENAMES) {
    try {
      const res = await fetch(encodeURI(filename), { cache: 'no-store' });
      if (!res.ok) continue;
      const text = await res.text();
      const keys = parseApiKeyText(text);
      if (Object.keys(keys).length) {
        apiKeyFileName = filename;
        apiKeyFileKeys = new Set(Object.keys(keys));
        return keys;
      }
    } catch (_) {}
  }
  return {};
}

async function loadKeys() {
  // Precedence: web-saved key > API Keys.txt > built-in fallback.
  // This means the bundled API Keys.txt is used on first launch, but a key
  // explicitly changed in Rex Settings remains the user's override.
  let storedKeys = {};
  try { storedKeys = (await idbGet('settings', 'apiKeys')) || {}; } catch (err) {
    console.warn('IndexedDB settings unavailable:', err);
  }
  state.apiKeys = { ...BUILTIN_API_KEYS, ...storedKeys };
  apiKeyFileName = (await idbGet('settings', 'apiKeyFileName')) || null;
  apiKeyFileSource = (await idbGet('settings', 'apiKeyFileSource')) || null;
  apiKeyFileExaOverride = (await idbGet('settings', 'apiKeyFileExaOverride')) || null;
  const persistedFileKeys = (await idbGet('settings', 'apiKeyFileKeys')) || [];
  apiKeyFileKeys = new Set(Array.isArray(persistedFileKeys) ? persistedFileKeys : []);
  state.apiKeys.exa = apiKeyFileExaOverride || state.apiKeys.exa || '';

  const fileKeys = await loadApiKeyFile();
  if (Object.keys(fileKeys).length) {
    const { exa, ...fileProviderKeys } = fileKeys;
    // Only fill missing/default provider keys from API Keys.txt.
    // A key changed through the web UI wins over the file.
    const mergedKeys = { ...state.apiKeys };
    for (const [key, value] of Object.entries(fileProviderKeys)) {
      const current = String(mergedKeys[key] || '').trim();
      const isBuiltinFallback = !current || current === BUILTIN_API_KEYS[key] || current.startsWith('REPLACE---ME');
      if (isBuiltinFallback) mergedKeys[key] = value;
    }
    state.apiKeys = { ...mergedKeys, exa: exa || apiKeyFileExaOverride || state.apiKeys.exa || '' };
    if (fileKeys.groqModel) state.modelSelections.groq = fileKeys.groqModel;
    if (fileKeys.openrouterModel) state.modelSelections.openrouter = fileKeys.openrouterModel;
    if (fileKeys.geminiModel) state.modelSelections.gemini = fileKeys.geminiModel;
    if (fileKeys.antigravityModel) state.modelSelections.antigravity = fileKeys.antigravityModel;
    apiKeyFileExaOverride = exa || apiKeyFileExaOverride || null;
    apiKeyFileSource = 'auto-detected';
    await idbPut('settings', state.apiKeys, 'apiKeys');
    await idbPut('settings', apiKeyFileName, 'apiKeyFileName');
    await idbPut('settings', apiKeyFileSource, 'apiKeyFileSource');
    await idbPut('settings', apiKeyFileExaOverride, 'apiKeyFileExaOverride');
    await idbPut('settings', Object.keys(fileKeys), 'apiKeyFileKeys');
  }
}

async function saveKeys(keys) {
  const nextKeys = { ...keys };
  delete nextKeys.exa;
  // Exa cannot be changed through the web UI. It remains the built-in key or the
  // value supplied by one of the supported API Keys.txt filenames.
  state.apiKeys = { ...state.apiKeys, ...nextKeys, exa: apiKeyFileExaOverride || state.apiKeys.exa || '' };
  await idbPut('settings', state.apiKeys, 'apiKeys');
  updateKeyStatuses();
}

/* ── DOM References ────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const engineSelect    = $('engine-select');
const providerWrap    = $('provider-select-wrap');
const providerSelect  = $('provider-select');
const wasmUploadWrap  = $('wasm-upload-wrap');
const wasmFileInput   = $('wasm-file-input');
const wasmLoadBtn     = $('wasm-load-btn');
const btnSettings     = $('btn-settings');
const statusDot       = $('status-dot');
const statusText      = $('status-text');
const wsDot           = $('ws-dot');
const wsLabel         = $('ws-label');
const btnAttach       = $('btn-attach');
const workspacePathEl = $('workspace-path');
const exaToggle       = $('exa-toggle');
const btnNewChat      = $('btn-new-chat');
const btnChatHistory  = $('btn-chat-history');
const chatModal       = $('chat-modal');
const chatClose       = $('chat-close');
const chatList        = $('chat-list');
const chatThread      = $('chat-thread');
const userInput       = $('user-input');
const btnSend         = $('btn-send');
const btnStop         = $('btn-stop');
const btnMic         = $('btn-mic');
const btnRemoteAccess = $('btn-remote-access');
const remoteModal = $('remote-modal');
const remoteClose = $('remote-close');
const remoteStart = $('remote-start');
const remoteStop = $('remote-stop');
const remoteUrl = $('remote-url');
const remoteCode = $('remote-code');
const remoteStatus = $('remote-status');
const remoteGate = $('remote-gate');
const remoteGateInput = $('remote-gate-input');
const remoteGateConnect = $('remote-gate-connect');
const remoteGateError = $('remote-gate-error');
const settingsModal   = $('settings-modal');
const settingsClose   = $('settings-close');
const settingsSave    = $('settings-save');
const wasmProgressWrap= $('wasm-progress-wrap');
const wasmProgressFill= $('wasm-progress-fill');
const wasmProgressLabel=$('wasm-progress-label');
const wasmProgressPct  =$('wasm-progress-pct');

/* ── Status helpers ────────────────────────────────────────── */
function setStatus(type, text) {
  statusDot.className = 'status-dot ' + type;
  statusText.textContent = text;
}

/* ── WebSocket Terminal Bridge ─────────────────────────────── */
function isLocalOrigin() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]';
}

function connectWS() {
  if (state.remoteMode) return;
  if (state.wsocket && state.wsocket.readyState < 2) return;
  try {
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = isLocalOrigin() ? '127.0.0.1:8765' : `${location.host}/bridge`;
    const ws = new WebSocket(`${wsProtocol}//${wsHost}`);
    ws.onopen = () => {
      state.wsConnected = true;
      wsDot.className = 'ws-dot connected';
      wsLabel.textContent = 'Bridge: connected';
      appendSystemMsg('Terminal bridge connected.');
    };
    ws.onclose = () => {
      state.wsConnected = false;
      wsDot.className = 'ws-dot disconnected';
      wsLabel.textContent = 'Bridge: offline';
      setTimeout(connectWS, 5000);
    };
    ws.onerror = () => {
      state.wsConnected = false;
      wsDot.className = 'ws-dot disconnected';
      wsLabel.textContent = 'Bridge: offline';
    };
    ws.onmessage = e => {
      try {
        const data = JSON.parse(e.data);
        const id = data.requestId || Object.keys(state.pendingCommands)[0];
        const pending = id && state.pendingCommands[id];
        if (pending) {
          delete state.pendingCommands[id];
          pending.resolve(data);
        }
      } catch (_) {}
    };
    state.wsocket = ws;
  } catch (_) {}
}

function sendCommand(command, rawPayload = false) {
  return new Promise((resolve, reject) => {
    if (!state.wsConnected || !state.wsocket) {
      reject(new Error('Terminal bridge not connected. Start terminal_bridge.py on port 8765.'));
      return;
    }
    const id = Date.now().toString();
    state.pendingCommands[id] = { resolve, reject };
    const payload = rawPayload ? { ...command, requestId: id } : { action: 'terminal', command, requestId: id };
    state.wsocket.send(JSON.stringify(payload));
  });
}

/* ── Engine / Provider Switcher ────────────────────────────── */
engineSelect.addEventListener('change', () => {
  state.engine = engineSelect.value;
  if (state.engine === 'wasm') {
    wasmUploadWrap.classList.add('visible');
    providerWrap.style.display = 'none';
  } else {
    wasmUploadWrap.classList.remove('visible');
    providerWrap.style.display = 'flex';
    setStatus('idle', 'Idle — Cloud mode');
  }
});

providerSelect.addEventListener('change', async () => {
  state.provider = providerSelect.value;
  await persistProviderSettings();
  updateHeaderModel();
  setStatus('idle', `Idle — ${providerLabel(state.provider)} · ${getModel(state.provider)}`);
});

exaToggle.addEventListener('change', () => {
  state.exaEnabled = exaToggle.checked;
  idbPut('settings', state.exaEnabled, 'exaEnabled').catch(() => {});
});

/* ── WASM Engine (wllama) ──────────────────────────────────── */
wasmFileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) $('wasm-filename').textContent = file.name;
});

wasmLoadBtn.addEventListener('click', async () => {
  const file = wasmFileInput.files[0];
  if (!file) { alert('Select a .gguf model file first.'); return; }

  // Memory guard: 2.2 GB rough limit (leave room for KV cache)
  const MAX_WASM_BYTES = 2.2 * 1024 * 1024 * 1024;
  if (file.size > MAX_WASM_BYTES) {
    setStatus('error', 'Error: WASM Memory Boundary Exceeded');
    appendWasmOomAlert(file.size);
    engineSelect.value = 'cloud';
    state.engine = 'cloud';
    providerWrap.style.display = 'flex';
    wasmUploadWrap.classList.remove('visible');
    return;
  }

  setStatus('loading', `Loading WASM: ${file.name}`);
  wasmProgressWrap.style.display = 'block';
  wasmProgressFill.style.width = '0%';

  try {
    // Dynamically import wllama (CDN)
    if (!window.Wllama) {
      appendSystemMsg('Loading @wllama/wllama runtime…');
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@wllama/wllama/dist/wllama.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }

    const arrayBuffer = await readFileWithProgress(file);
    const wllama = new window.Wllama({
      'single-thread/wllama.wasm': 'https://cdn.jsdelivr.net/npm/@wllama/wllama/dist/single-thread/wllama.wasm',
      'multi-thread/wllama.wasm':  'https://cdn.jsdelivr.net/npm/@wllama/wllama/dist/multi-thread/wllama.wasm',
    });

    await wllama.loadModelFromBuffer(arrayBuffer, {
      n_ctx: 2048,
      n_threads: 6,        // 2 perf cores + 4 efficient cores
      n_gpu_layers: 0,     // CPU-only WASM
    });

    state.wasmEngine = wllama;
    state.wasmLoaded = true;
    wasmProgressFill.style.width = '100%';
    wasmProgressLabel.querySelector('#wasm-progress-pct').textContent = '100%';
    setStatus('active', `WASM loaded: ${file.name}`);
    appendSystemMsg(`Model ready: ${file.name} — running on 6 CPU threads`);
    setTimeout(() => { wasmProgressWrap.style.display = 'none'; }, 1500);

  } catch (err) {
    if (err.message && (err.message.includes('memory') || err.message.includes('OOM') || err.message.includes('alloc'))) {
      setStatus('error', 'Error: WASM Memory Boundary Exceeded');
      appendWasmOomAlert(file.size);
      // Failover to cloud
      engineSelect.value = 'cloud';
      state.engine = 'cloud';
      providerWrap.style.display = 'flex';
      wasmUploadWrap.classList.remove('visible');
    } else {
      setStatus('error', `WASM Error: ${err.message}`);
      appendSystemMsg(`Failed to load model: ${err.message}`);
    }
    wasmProgressWrap.style.display = 'none';
  }
});

function readFileWithProgress(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = e => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        wasmProgressFill.style.width = pct + '%';
        wasmProgressPct.textContent = pct + '%';
      }
    };
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

/* ── Workspace access ───────────────────────────────────────── */
function hasNativeDirectoryPicker() {
  return typeof window.showDirectoryPicker === 'function' && window.isSecureContext;
}

async function bridgeRequest(payload) {
  if (state.remoteMode) {
    if (!state.remoteAccessCode) throw new Error('Enter the Rex remote access code first.');
    const response = await fetch('/api/bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rex-Access-Token': state.remoteAccessCode },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
    if (response.status === 401) {
      state.remoteAccessCode = '';
      sessionStorage.removeItem('rexRemoteAccessCode');
      showRemoteGate('That access code is not valid or remote access was stopped.');
      throw new Error('Rex remote access code rejected.');
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) throw new Error(result.error || `Remote bridge request failed (${response.status}).`);
    return result;
  }
  if (!state.wsConnected || !state.wsocket) {
    throw new Error('Terminal/workspace bridge is offline. Start terminal_bridge.py first.');
  }
  return sendCommand(payload, true);
}

function showRemoteGate(error = '') {
  if (!remoteGate) return;
  if (remoteGateError) remoteGateError.textContent = error;
  remoteGate.classList.add('open');
  setTimeout(() => remoteGateInput?.focus(), 50);
}

function hideRemoteGate() {
  remoteGate?.classList.remove('open');
  if (remoteGateError) remoteGateError.textContent = '';
}

function setRemoteAccessInfo(result) {
  if (!result?.url) return;
  if (remoteUrl) { remoteUrl.value = result.shareUrl || result.url; remoteUrl.dataset.href = result.shareUrl || result.url; }
  if (remoteCode) remoteCode.value = result.accessCode || '';
  if (remoteStatus) remoteStatus.textContent = 'Remote access is active.';
  remoteStart?.setAttribute('hidden', '');
  remoteStop?.removeAttribute('hidden');
}

async function startRemoteAccess() {
  if (!state.wsConnected) {
    remoteStatus.textContent = 'Start Rex locally first; the bridge must be connected.';
    return;
  }
  remoteStart.disabled = true;
  remoteStatus.textContent = 'Starting Cloudflare Quick Tunnel…';
  try {
    const result = await bridgeRequest({ action: 'remote_access_start' });
    if (!result?.ok) throw new Error(result?.error || 'Could not start remote access.');
    setRemoteAccessInfo(result);
  } catch (err) {
    remoteStatus.textContent = err.message;
  } finally {
    remoteStart.disabled = false;
  }
}

async function stopRemoteAccess() {
  if (!state.wsConnected) return;
  remoteStop.disabled = true;
  try {
    await bridgeRequest({ action: 'remote_access_stop' });
    remoteUrl.value = '';
    remoteCode.value = '';
    remoteStatus.textContent = 'Remote access stopped.';
    remoteStart.removeAttribute('hidden');
    remoteStop.setAttribute('hidden', '');
  } catch (err) {
    remoteStatus.textContent = err.message;
  } finally {
    remoteStop.disabled = false;
  }
}

if (btnRemoteAccess) btnRemoteAccess.addEventListener('click', async () => {
  remoteModal?.classList.add('open');
  if (!state.remoteMode && state.wsConnected) {
    try {
      const result = await bridgeRequest({ action: 'remote_access_status' });
      if (result?.running) setRemoteAccessInfo(result);
    } catch (_) {}
  }
});
remoteClose?.addEventListener('click', () => remoteModal?.classList.remove('open'));
remoteModal?.addEventListener('click', e => { if (e.target === remoteModal) remoteModal.classList.remove('open'); });
remoteStart?.addEventListener('click', startRemoteAccess);
remoteStop?.addEventListener('click', stopRemoteAccess);
remoteUrl?.addEventListener('click', () => { if (remoteUrl.value) window.open(remoteUrl.value, '_blank', 'noopener'); });
remoteGateConnect?.addEventListener('click', async () => {
  const code = remoteGateInput?.value.trim();
  if (!code) { showRemoteGate('Enter the access code shown on the computer running Rex.'); return; }
  state.remoteAccessCode = code;
  sessionStorage.setItem('rexRemoteAccessCode', code);
  remoteGateConnect.disabled = true;
  try {
    const result = await bridgeRequest({ action: 'ping' });
    if (!result?.ok) throw new Error(result?.error || 'Connection failed.');
    hideRemoteGate();
    state.remoteGateReady?.();
    state.remoteGateReady = null;
    await loadKeys();
  } catch (err) {
    state.remoteAccessCode = '';
    sessionStorage.removeItem('rexRemoteAccessCode');
    showRemoteGate(err.message);
  } finally { remoteGateConnect.disabled = false; }
});
remoteGateInput?.addEventListener('keydown', e => { if (e.key === 'Enter') remoteGateConnect.click(); });

let workspacePickerEl = null;
let workspacePickerPath = '';

function ensureWorkspacePicker() {
  if (workspacePickerEl) return workspacePickerEl;
  workspacePickerEl = document.createElement('div');
  workspacePickerEl.className = 'modal-backdrop workspace-picker-backdrop';
  workspacePickerEl.id = 'workspace-picker';
  workspacePickerEl.innerHTML = `
    <div class="modal workspace-picker-modal" role="dialog" aria-modal="true" aria-label="Select workspace">
      <div class="modal-header">
        <span>Select workspace</span>
        <button class="modal-close" id="workspace-picker-close" type="button" aria-label="Close">✕</button>
      </div>
      <div class="workspace-picker-toolbar">
        <button class="workspace-up" id="workspace-picker-up" type="button" title="Go up" aria-label="Go up">↑</button>
        <div class="workspace-breadcrumb" id="workspace-picker-breadcrumb">This PC</div>
        <button class="workspace-new-folder" id="workspace-picker-new-folder" type="button" title="Create folder" aria-label="Create folder">＋📁</button>
      </div>
      <div class="workspace-picker-list" id="workspace-picker-list"></div>
      <div class="workspace-picker-footer">
        <span class="workspace-picker-status" id="workspace-picker-status">Choose a folder.</span>
        <div class="workspace-picker-actions">
          <button class="btn-ghost" id="workspace-picker-cancel" type="button">Cancel</button>
          <button class="btn-primary" id="workspace-picker-select" type="button">Select this folder</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(workspacePickerEl);
  const close = () => workspacePickerEl.classList.remove('open');
  $('workspace-picker-close').addEventListener('click', close);
  $('workspace-picker-cancel').addEventListener('click', close);
  workspacePickerEl.addEventListener('click', e => { if (e.target === workspacePickerEl) close(); });
  $('workspace-picker-up').addEventListener('click', async () => {
    const up = $('workspace-picker-up').dataset.parent || '';
    if (!up && workspacePickerPath) workspacePickerPath = '';
    else if (up) workspacePickerPath = up;
    await renderWorkspacePicker();
  });
  $('workspace-picker-new-folder').addEventListener('click', async () => {
    if (!workspacePickerPath) {
      $('workspace-picker-status').textContent = 'Open a drive or folder first.';
      return;
    }
    const name = window.prompt('New folder name:');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      $('workspace-picker-status').textContent = 'Folder name cannot be empty.';
      return;
    }
    const button = $('workspace-picker-new-folder');
    button.disabled = true;
    try {
      const result = await bridgeRequest({ action: 'workspace_mkdir', path: workspacePickerPath, name: trimmed });
      if (!result?.ok) throw new Error(result?.error || 'Could not create folder.');
      $('workspace-picker-status').textContent = `Created: ${result.name}`;
      await renderWorkspacePicker(workspacePickerPath);
    } catch (err) {
      $('workspace-picker-status').textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
  $('workspace-picker-select').addEventListener('click', async () => {
    if (!workspacePickerPath) {
      $('workspace-picker-status').textContent = 'Select a drive or folder first.';
      return;
    }
    const result = await bridgeRequest({ action: 'workspace_select', path: workspacePickerPath });
    if (!result?.ok) throw new Error(result?.error || 'Could not select workspace.');
    state.workspaceHandle = null;
    state.bridgeWorkspace = true;
    state.workspaceRootName = result.workspaceName;
    await updateWorkspaceUI(result.workspaceName, 'Rex workspace picker');
    appendSystemMsg(`Workspace attached: ${result.workspaceName}`);
    setStatus('idle', `Workspace: ${result.workspaceName}`);
    close();
  });
  return workspacePickerEl;
}

async function renderWorkspacePicker(path = workspacePickerPath) {
  ensureWorkspacePicker();
  workspacePickerPath = path || '';
  const list = $('workspace-picker-list');
  const crumb = $('workspace-picker-breadcrumb');
  const up = $('workspace-picker-up');
  const status = $('workspace-picker-status');
  list.innerHTML = '<div class="workspace-picker-loading">Loading…</div>';
  status.textContent = 'Choose a folder.';
  try {
    const result = await bridgeRequest({ action: 'workspace_browse', path: workspacePickerPath });
    if (!result?.ok) throw new Error(result?.error || 'Could not read this folder.');
    workspacePickerPath = result.path || '';
    crumb.textContent = result.path || 'This PC';
    up.dataset.parent = result.parent || '';
    up.disabled = !result.path;
    list.innerHTML = '';
    if (!result.entries?.length) {
      list.innerHTML = '<div class="workspace-picker-empty">No folders here.</div>';
    } else {
      for (const entry of result.entries) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'workspace-picker-entry';
        row.innerHTML = `<span class="workspace-entry-icon">${entry.type === 'drive' ? '💽' : '📁'}</span><span class="workspace-entry-name">${escHtml(entry.name)}</span>`;
        row.addEventListener('dblclick', () => renderWorkspacePicker(entry.path));
        row.addEventListener('click', () => {
          document.querySelectorAll('.workspace-picker-entry.selected').forEach(el => el.classList.remove('selected'));
          row.classList.add('selected');
          $('workspace-picker-status').textContent = entry.path;
        });
        row.addEventListener('contextmenu', e => { e.preventDefault(); renderWorkspacePicker(entry.path); });
        list.appendChild(row);
      }
    }
  } catch (err) {
    list.innerHTML = `<div class="workspace-picker-empty">${escHtml(err.message)}</div>`;
    status.textContent = 'Unable to open this folder.';
  }
}

async function openWorkspacePicker() {
  ensureWorkspacePicker();
  workspacePickerPath = '';
  workspacePickerEl.classList.add('open');
  await renderWorkspacePicker('');
}

btnAttach.addEventListener('click', async () => {
  try {
    // Use the same Rex picker everywhere. This makes Chrome, Firefox, and
    // remote/mobile clients behave identically and avoids a second native UI.
    await openWorkspacePicker();
  } catch (err) {
    if (err.name !== 'AbortError') {
      setStatus('error', 'Workspace unavailable');
      appendSystemMsg(`Workspace error: ${err.message}`);
    }
  }
});

async function updateWorkspaceUI(name, mode) {
  btnAttach.classList.add('active');
  workspacePathEl.innerHTML = `<span class="path-label">workspace:</span><span class="path-val">${escHtml(name)}</span>`;
  workspacePathEl.title = `${name} — ${mode}`;
  setStatus('idle', `Workspace: ${name}`);
}

/* Root deletion guard */
function guardedDelete(handle, name, parentHandle) {
  if (name === state.workspaceRootName) {
    throw new Error(`BLOCKED: Cannot delete workspace root "${name}". Only subdirectory deletion is permitted.`);
  }
  return parentHandle.removeEntry(name, { recursive: true });
}

async function writeFile(relativePath, content) {
  if (state.bridgeWorkspace) {
    const result = await bridgeRequest({ action: 'write_file', path: relativePath, content });
    if (!result?.ok) throw new Error(result?.error || 'Bridge write failed.');
    return;
  }
  if (!state.workspaceHandle) throw new Error('No workspace attached.');
  const clean = relativePath.replace(/^[/\\]+/, '');
  const parts = clean.split('/').filter(Boolean);
  if (!parts.length || parts.some(p => p === '..' || p === '.')) throw new Error('Invalid workspace-relative path.');
  const filename = parts.pop();
  let dir = state.workspaceHandle;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  const fileHandle = await dir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try { await writable.write(content); } finally { await writable.close(); }
}

async function readFile(relativePath) {
  if (state.bridgeWorkspace) {
    const result = await bridgeRequest({ action: 'read_file', path: relativePath });
    if (!result?.ok) throw new Error(result?.error || 'Bridge read failed.');
    return result.content;
  }
  if (!state.workspaceHandle) throw new Error('No workspace attached.');
  const clean = relativePath.replace(/^[/\\]+/, '');
  const parts = clean.split('/').filter(Boolean);
  if (!parts.length || parts.some(p => p === '..' || p === '.')) throw new Error('Invalid workspace-relative path.');
  const filename = parts.pop();
  let dir = state.workspaceHandle;
  for (const part of parts) dir = await dir.getDirectoryHandle(part);
  const fileHandle = await dir.getFileHandle(filename);
  return (await fileHandle.getFile()).text();
}

/* ── Exa Web Search ─────────────────────────────────────────── */
async function exaSearch(query) {
  const key = state.apiKeys.exa;
  if (!key) throw new Error('Exa API key not configured. Add Exa: ... to API_Keys.txt.');
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults: 10,
      contents: { highlights: true },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Exa API error ${res.status}: ${data?.error || data?.message || 'request failed'}`);
  return (data.results || []).map(item => ({
    title: item.title,
    url: item.url,
    publishedDate: item.publishedDate,
    author: item.author,
    highlights: item.highlights || [],
    text: item.text || '',
  }));
}

/* ── Command Risk Assessment ───────────────────────────────── */
function assessRisk(cmd) {
  const c = cmd.toLowerCase().trim();

  // HIGH risk patterns
  const highPatterns = [
    /rmdir\s+\/s/i, /del\s+\/f\s+\/s/i, /del\s+\/s/i, /rm\s+-rf/i,
    /format\s+[a-z]:/i, /diskpart/i, /reg\s+delete/i, /reg\s+add/i,
    /netsh/i, /sc\s+(delete|create|stop|start)/i, /taskkill\s+\/f/i,
    /icacls/i, /cacls/i, /takeown/i, /bcdedit/i, /pip\s+install\s+--user/i,
    /shutdown/i, /powercfg/i, /sfc\s+\/scannow/i,
    /remove-item.*-recurse/i, /remove-item.*-force/i, /stop-computer/i, /restart-computer/i,
    /clear-disk/i, /format-volume/i, /initialize-disk/i, /set-disk/i, /set-partition/i,
  ];
  if (highPatterns.some(p => p.test(c))) {
    return {
      level: 'high',
      label: 'HIGH',
      title: 'Destructive / System-Level Command',
      assessment: 'This command may cause irreversible structural changes, recursive deletions, or system-level modifications. Review the full impact before approving.',
    };
  }

  // MEDIUM risk patterns
  const mediumPatterns = [
    /del\s+/i, /erase\s+/i, /rm\s+/i, /move\s+/i, /mv\s+/i,
    /git\s+checkout\s+\./i, /git\s+reset/i, /git\s+clean/i,
    /xcopy/i, /robocopy/i, /copy\s+.*\/y/i, /attrib/i,
    /rename\s+/i, /ren\s+/i, /remove-item/i, /move-item/i, /copy-item.*-force/i,
  ];
  if (mediumPatterns.some(p => p.test(c))) {
    return {
      level: 'medium',
      label: 'MEDIUM',
      title: 'File Modification / Non-Recursive Deletion',
      assessment: 'This command will modify or delete specific files. Targeted paths will be affected. Confirm the exact files listed above before approving.',
    };
  }

  // LOW — everything else
  return {
    level: 'low',
    label: 'LOW',
    title: 'Non-Destructive Operation',
    assessment: 'This command is read-only, installs a package to the active virtual environment, or queries system state. Minimal risk to existing data.',
  };
}

/* ── Render Risk Card (inline in chat) ─────────────────────── */
function renderRiskCard(command, risk) {
  return new Promise(resolve => {
    const id = 'risk-' + Date.now();
    const card = document.createElement('div');
    card.className = `risk-card ${risk.level}`;
    card.id = id;
    card.innerHTML = `
      <div class="risk-header">
        <span class="risk-badge">${risk.label}</span>
        <span class="risk-title">${risk.title}</span>
      </div>
      <div class="risk-cmd">${escHtml(command)}</div>
      <div class="risk-assessment">${risk.assessment}</div>
      <div class="risk-actions">
        <button class="btn-approve">Execute</button>
        <button class="btn-deny">Deny</button>
      </div>
    `;

    // Append inside an agent message
    const bubble = appendAgentBubble();
    bubble.appendChild(card);
    scrollBottom();
    setStatus('waiting', 'Awaiting Terminal Approval');

    card.querySelector('.btn-approve').addEventListener('click', async () => {
      card.classList.add('executed');
      setStatus('active', 'Executing command…');
      try {
        const result = await sendCommand(command);
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim() || '(no output)';
        const resultDiv = document.createElement('div');
        resultDiv.className = 'risk-result';
        resultDiv.textContent = `$ ${command}\n${output}\n\nexitcode: ${result.returncode}`;
        card.appendChild(resultDiv);
        setStatus('idle', 'Command completed');
        resolve({ approved: true, output });
      } catch (err) {
        const resultDiv = document.createElement('div');
        resultDiv.className = 'risk-result';
        resultDiv.textContent = `Error: ${err.message}`;
        card.appendChild(resultDiv);
        setStatus('error', 'Command failed');
        resolve({ approved: true, error: err.message });
      }
      scrollBottom();
    });

    card.querySelector('.btn-deny').addEventListener('click', () => {
      card.classList.add('denied');
      const resultDiv = document.createElement('div');
      resultDiv.className = 'risk-result';
      resultDiv.textContent = 'Command denied by user.';
      card.appendChild(resultDiv);
      setStatus('idle', 'Command denied');
      resolve({ approved: false });
      scrollBottom();
    });
  });
}

/* ── Tool Dispatcher (called from AI response parsing) ─────── */
async function dispatchTool(toolName, args) {
  switch (toolName) {
    case 'terminal': {
      const cmd = args.command || '';
      if (!cmd) return { error: 'No command specified.' };
      const risk = assessRisk(cmd);
      const result = await renderRiskCard(cmd, risk);
      return result;
    }
    case 'read_file': {
      try {
        const content = await readFile(args.path);
        return { content };
      } catch (e) { return { error: e.message }; }
    }
    case 'write_file': {
      try {
        await writeFile(args.path, args.content || '');
        return { success: true };
      } catch (e) { return { error: e.message }; }
    }
    case 'web_search': {
      if (!state.exaEnabled) return { error: 'Exa web search is disabled. Turn on Exa search in the toolbar.' };
      try {
        const results = await exaSearch(args.query);
        return { results };
      } catch (e) { return { error: e.message }; }
    }
    case 'generate_image': {
      if (!state.remoteMode && !state.wsConnected) return { error: 'Image generation requires the local Rex bridge. Start terminal_bridge.py first.' };
      try {
        const result = await bridgeRequest({ action: 'generate_image', prompt: args.prompt, model: args.model || state.apiKeys.pollinationsModel || 'flux', width: args.width || 1024, height: args.height || 1024 });
        if (!result?.ok) return { error: result?.error || 'Image generation failed.' };
        const imageUrl = new URL(result.url, location.origin).href;
        renderGeneratedImage(imageUrl, args.prompt || 'Generated image');
        return { image_url: imageUrl, model: result.model, width: result.width, height: result.height };
      } catch (e) { return { error: e.message }; }
    }
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

/* ── Cloud Inference ──────────────────────────────────────────*/
const TOOLS_SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'terminal',
      description: 'Execute a PowerShell 7 command on the local Windows machine. The user must approve execution.',
      parameters: { type: 'object', properties: { command: { type: 'string', description: 'PowerShell 7 command to execute.' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the attached workspace directory.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write text content to a file in the attached workspace directory.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' }, content: { type: 'string', description: 'Text content to write.' } }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web with Exa for current information. Use this for recent facts, news, releases, documentation, and anything that may have changed.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Precise web search query.' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an image from a text prompt using Rex image generation. Use this when the user asks to create, draw, generate, visualize, or make an image.',
      parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'Detailed image-generation prompt.' }, model: { type: 'string', description: 'Pollinations image model, usually flux.' }, width: { type: 'integer', description: 'Image width from 256 to 2048.' }, height: { type: 'integer', description: 'Image height from 256 to 2048.' } }, required: ['prompt'] },
    },
  },
];

const GEMINI_TOOLS = [{ functionDeclarations: TOOLS_SCHEMA.map(t => ({
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters,
})) }];

function buildMessages(history) { return history; }

function providerConfig(provider) {
  const keys = state.apiKeys;
  switch (provider) {
    case 'groq': return { url: 'https://api.groq.com/openai/v1/chat/completions', key: keys.groq, model: getModel(provider) };
    case 'openrouter': return { url: 'https://openrouter.ai/api/v1/chat/completions', key: keys.openrouter, model: getModel(provider), extraHeaders: { 'HTTP-Referer': location.origin, 'X-Title': 'Rex AI' } };
    default: throw new Error('Unknown OpenAI-compatible provider: ' + provider);
  }
}

async function openAICompatibleInfer(messages, onChunk) {
  const provider = state.provider;
  const cfg = providerConfig(provider);
  if (!cfg.key || cfg.key === 'REPLACE_WITH_OPENROUTER_KEY') {
    throw new Error(`${providerLabel(provider)} API key is not configured. Open ⚙ Settings or import API Keys.txt.`);
  }
  if (!cfg.model) throw new Error(`${providerLabel(provider)} has no model selected.`);

  const request = async includeTools => {
    const body = {
      model: cfg.model,
      messages,
      stream: true,
      max_tokens: 4096,
    };
    if (includeTools) {
      body.tools = TOOLS_SCHEMA;
      body.tool_choice = 'auto';
    }

    state.abortController = new AbortController();
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        ...(cfg.extraHeaders || {}),
      },
      body: JSON.stringify(body),
      signal: state.abortController.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      const message = `${providerLabel(provider)} API error ${res.status}: ${err.slice(0, 800)}`;
      const retryWithoutTools = includeTools && (res.status === 400 || res.status === 422);
      if (retryWithoutTools) return request(false);
      throw new Error(message);
    }

    if (!res.body) throw new Error(`${providerLabel(provider)} returned an empty response body.`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    const toolCalls = {};
    let buffer = '';

    const consumeLine = rawLine => {
      const line = rawLine.trim();
      if (!line || !line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') return;
      let delta;
      try { delta = JSON.parse(raw); } catch (_) { return; }
      const choice = delta.choices?.[0];
      const d = choice?.delta;
      if (typeof d?.content === 'string' && d.content) {
        fullText += d.content;
        onChunk(d.content);
      }
      for (const tc of (d?.tool_calls || [])) {
        const idx = tc.index ?? 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', args: '' };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].name = tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer) consumeLine(buffer);

    const calls = Object.values(toolCalls).filter(call => call.name).map(call => ({
      ...call,
      id: call.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    }));
    return { text: fullText, toolCalls: [], assistantToolCalls: calls };
  };

  return request(true);
}
function getModel(provider) {
  return state.modelSelections?.[provider] || (provider === 'gemini' ? 'gemini-3.6-flash' : 'openai/gpt-oss-120b');
}

function providerLabel(provider) {
  return ({ groq: 'GroqCloud', openrouter: 'OpenRouter', gemini: 'Google Gemini', antigravity: 'Antigravity' })[provider] || provider;
}

function modelIdentity(provider = state.provider) {
  return { provider, providerName: providerLabel(provider), model: getModel(provider) };
}

function identityText(identity) {
  return `${identity.providerName}'s ${identity.model}`;
}

function buildRuntimeSystemPrompt() {
  const current = modelIdentity();
  const previous = state.chatLastAccess;
  const previousLine = previous
    ? `This chat was previously accessed by ${identityText(previous)}. If that previous identity differs from your current identity, treat the previous model as a previous participant in this same conversation, not as your own model.`
    : 'This is the first recorded model access for this chat; there is no previous provider/model identity.';
  const nameLine = state.userName ? `The user prefers to be called ${state.userName}.` : 'No preferred user name has been configured.';
  return `${SYSTEM_PROMPT}

RUNTIME MODEL IDENTITY (authoritative, supplied by Rex):
- Your current provider is ${current.providerName}.
- Your current model is ${current.model}.
- When asked what model/provider you are, answer from these runtime identity fields rather than guessing from your training data.
- ${previousLine}
- ${nameLine}`;
}

async function persistProviderSettings() {
  await idbPut('settings', state.provider, 'provider');
  await idbPut('settings', state.modelSelections, 'modelSelections');
  await idbPut('settings', state.userName, 'userName');
}

async function loadProviderSettings() {
  const savedProvider = await idbGet('settings', 'provider');
  const savedModels = await idbGet('settings', 'modelSelections');
  const savedName = await idbGet('settings', 'userName');
  if (savedProvider && ['groq','openrouter','gemini','antigravity'].includes(savedProvider)) state.provider = savedProvider;
  if (savedModels && typeof savedModels === 'object') state.modelSelections = { ...state.modelSelections, ...savedModels };
  if (typeof savedName === 'string') state.userName = savedName;
}

function updateHeaderModel() {
  providerSelect.value = state.provider;
  const option = providerSelect.querySelector(`option[value="${state.provider}"]`);
  if (option) option.textContent = `${providerLabel(state.provider)} · ${getModel(state.provider)}`;
}

function openRouterToolResultsForGemini(messages) {
  return messages.map(m => {
    if (m.role === 'tool') {
      return { role: 'user', parts: [{ functionResponse: { name: m.name, response: (() => { try { return JSON.parse(m.content); } catch (_) { return { content: m.content }; } })() } }] };
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) {}
        parts.push({ functionCall: { name: tc.function.name, args } });
      }
      return { role: 'model', parts };
    }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    };
  });
}

async function geminiInfer(messages, onChunk) {
  const key = state.apiKeys.gemini;
  if (!key) throw new Error('Google Gemini API key is not configured. Open ⚙ Settings or import API Keys.txt.');
  const model = getModel('gemini');
  if (!model) throw new Error('Google Gemini has no model selected.');

  const systemMsg = messages.find(m => m.role === 'system');
  const contents = openRouterToolResultsForGemini(messages.filter(m => m.role !== 'system'));

  const request = async includeTools => {
    const requestBody = {
      contents,
      ...(includeTools ? {
        tools: GEMINI_TOOLS,
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      } : {}),
      ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
      generationConfig: { maxOutputTokens: 4096 },
    };

    state.abortController = new AbortController();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: state.abortController.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const retryWithoutTools = includeTools && res.status === 400;
      if (retryWithoutTools) return request(false);
      throw new Error(`Google Gemini API error ${res.status}: ${errBody.slice(0, 800)}`);
    }

    const data = await res.json();
    const candidate = data?.candidates?.[0];
    if (!candidate) {
      const blockReason = data?.promptFeedback?.blockReason;
      throw new Error(blockReason ? `Google Gemini blocked this request: ${blockReason}.` : 'Google Gemini returned no candidate response.');
    }
    const parts = candidate?.content?.parts || [];
    let fullText = '';
    const calls = [];
    for (const part of parts) {
      if (typeof part.text === 'string' && part.text) {
        fullText += part.text;
        onChunk(part.text);
      }
      if (part.functionCall) {
        calls.push({
          id: `gemini_${Date.now()}_${calls.length}`,
          name: part.functionCall.name,
          args: JSON.stringify(part.functionCall.args || {}),
        });
      }
    }
    if (!fullText && !calls.length && candidate.finishReason) {
      throw new Error(`Google Gemini finished without text (${candidate.finishReason}).`);
    }
    return { text: fullText, toolCalls: [], assistantToolCalls: calls };
  };

  return request(true);
}
async function antigravityInfer(messages, onChunk) {
  const key = state.apiKeys.antigravity;
  if (!key || key.startsWith('REPLACE---ME')) throw new Error('Antigravity API key is not configured. Open ⚙ Settings.');
  if (!state.bridgeWorkspace && !state.wsConnected) throw new Error('Antigravity needs the Rex workspace bridge. Start Rex normally and attach a workspace.');
  const nonSystem = messages.filter(m => m.role !== 'system');
  const recent = nonSystem.slice(-24).map(m => {
    if (m.role === 'user') return `User: ${m.content}`;
    if (m.role === 'assistant') return `Antigravity/Rex: ${m.content || ''}`;
    return '';
  }).filter(Boolean).join('\n\n');
  const system = messages.find(m => m.role === 'system')?.content || '';
  const prompt = `${system}\n\nYou are operating as the Antigravity agent for Rex. The selected workspace is already mounted to you.\n\nConversation context:\n${recent}`;
  const result = await bridgeRequest({ action: 'antigravity', prompt, apiKey: key });
  if (!result?.ok) throw new Error(result?.error || 'Antigravity failed.');
  if (result.text) onChunk(result.text);
  return { text: result.text || '', toolCalls: [], assistantToolCalls: [] };
}

async function cloudInfer(messages, onChunk) {
  if (state.provider === 'gemini') return geminiInfer(messages, onChunk);
  if (state.provider === 'antigravity') return antigravityInfer(messages, onChunk);
  return openAICompatibleInfer(messages, onChunk);
}

/* ── WASM Local Inference ──────────────────────────────────── */
async function wasmInfer(messages, onChunk) {
  if (!state.wasmEngine || !state.wasmLoaded) {
    throw new Error('No WASM model loaded. Load a .gguf file first.');
  }

  const prompt = messages
    .map(m => (m.role === 'user' ? `User: ${m.content}` : `Assistant: ${m.content}`))
    .join('\n') + '\nAssistant: ';

  await state.wasmEngine.createCompletion(prompt, {
    nPredict: 2048,
    onNewToken: (token, _piece, currentText) => {
      onChunk(token);
    },
  });

  return { text: '', toolCalls: [] }; // streamed via onChunk
}

/* ── Conversation / chat persistence ───────────────────────── */
const SYSTEM_PROMPT = `You are Rex, a sharp and direct AI agent inside a browser on Windows 11.

TOOLS (Rex-provided only — never use provider-hosted tools):
- terminal: PowerShell 7 via local bridge. User approves every command before execution.
- read_file / write_file: File System Access API on the attached workspace.
- web_search: Exa real-time search. Use for any current or changing information.
- generate_image: Pollinations. Use when the user asks to generate, draw, or visualize something.

TOOL ROUTING:
- Simple factual question → answer directly, no tool.
- Current/changing info → web_search first.
- Write text to workspace → write_file. Run programs or shell ops → terminal.
- Generate an image → generate_image, never just describe one.
- Multi-step task → chain tools, then give a concise final answer.

RESPONSE STYLE — follow strictly:
- Be concise and direct. Start with the answer.
- Never open with filler: "Certainly!", "Great question!", "Of course!", "I'd be happy to", "Let me", "Sure!", or anything similar.
- No padding, unsolicited caveats, or alternatives after the answer is complete.
- Plain prose for simple answers. Use lists or tables only when they genuinely help.
- For web search results, summarize in 2-4 sentences max. Do not dump raw results.
- Use markdown so it renders — **bold**, *italic*, \`code\`, tables, headings. Never output raw * or _ characters as literal text.
- PowerShell 7 syntax only. Never cmd.exe or .bat syntax unless explicitly asked.
`;

let conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];

function newChatId() { return 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

async function createNewChat() {
  state.chatId = newChatId();
  conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];
  chatThread.innerHTML = '';
  const wc = document.getElementById('welcome-card');
  if (wc) wc.style.display = '';
  await saveCurrentChat();
}

function historyFallbackRead() {
  try {
    const raw = localStorage.getItem('rexChatHistory');
    const chats = raw ? JSON.parse(raw) : [];
    return Array.isArray(chats) ? chats.filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function historyFallbackWrite(chats) {
  try {
    localStorage.setItem('rexChatHistory', JSON.stringify(chats));
    return true;
  } catch (err) {
    console.warn('Could not write chat history fallback:', err);
    return false;
  }
}

function normalizeChat(chat) {
  if (!chat || !chat.id) return null;
  const messages = Array.isArray(chat.messages) ? chat.messages.filter(Boolean) : [];
  return {
    id: String(chat.id),
    title: String(chat.title || (messages.find(m => m && m.role === 'user')?.content || 'New chat')).replace(/\s+/g, ' ').slice(0, 70) || 'New chat',
    messages,
    updatedAt: Number(chat.updatedAt) || 0,
  };
}

function mergeChats(...sources) {
  const merged = new Map();
  for (const source of sources) {
    for (const raw of (Array.isArray(source) ? source : [])) {
      const chat = normalizeChat(raw);
      if (!chat) continue;
      const previous = merged.get(chat.id);
      if (!previous || chat.updatedAt >= previous.updatedAt) merged.set(chat.id, chat);
    }
  }
  return [...merged.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function getSavedChats() {
  let indexedChats = [];
  let indexedOk = false;
  try {
    indexedChats = await idbAll('chats');
    indexedOk = true;
  } catch (err) {
    console.warn('IndexedDB chat history unavailable:', err);
  }

  const fallbackChats = historyFallbackRead();
  const chats = mergeChats(indexedChats, fallbackChats);

  if (indexedOk) {
    historyStorage = 'indexeddb';
    // Keep the fallback synchronized so a future IndexedDB failure does not
    // make existing conversations disappear.
    historyFallbackWrite(chats);
  } else {
    historyStorage = 'localstorage';
  }

  return chats;
}

async function saveCurrentChat() {
  if (!state.chatId) state.chatId = newChatId();
  const messages = conversationHistory.filter(m => m.role !== 'system');
  const firstUser = messages.find(m => m.role === 'user');
  const title = firstUser ? String(firstUser.content).replace(/\s+/g, ' ').slice(0, 70) : 'New chat';
  const chat = normalizeChat({ id: state.chatId, title, messages, updatedAt: Date.now() });
  if (!chat) return;

  let indexedOk = false;
  try {
    await idbPut('chats', chat);
    indexedOk = true;
    historyStorage = 'indexeddb';
  } catch (err) {
    historyStorage = 'localstorage';
    console.warn('IndexedDB chat save failed:', err);
  }

  const merged = mergeChats(historyFallbackRead(), [chat]);
  const fallbackOk = historyFallbackWrite(merged);
  if (!indexedOk && !fallbackOk) throw new Error('Chat history could not be saved.');
}

async function loadLatestChat() {
  const chats = await getSavedChats();
  if (!chats.length) {
    state.chatId = newChatId();
    await saveCurrentChat();
    return;
  }

  const chat = chats[0];
  state.chatId = chat.id;
  conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }, ...chat.messages];
  renderStoredChat();
}

function renderStoredChat() {
  chatThread.innerHTML = '';
  const wc = document.getElementById('welcome-card');
  if (wc) wc.style.display = 'none';
  for (const message of conversationHistory) {
    if (message.role === 'user') appendUserMsg(message.content, false);
    else if (message.role === 'assistant' && message.content) appendStoredAgentMsg(message.content);
  }
  scrollBottom();
}

async function openChatHistory() {
  const chats = await getSavedChats();
  chatList.innerHTML = '';
  if (!chats.length) {
    chatList.innerHTML = '<div class="chat-empty">No saved chats yet.</div>';
    chatModal.classList.add('open');
    return;
  }

  for (const chat of chats) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.innerHTML = `<button class="chat-open"><span class="chat-title">${escHtml(chat.title || 'New chat')}</span><span class="chat-date">${new Date(chat.updatedAt || Date.now()).toLocaleString()}</span></button><button class="chat-delete" title="Delete">✕</button>`;
    row.querySelector('.chat-open').addEventListener('click', async () => {
      state.chatId = chat.id;
      conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }, ...chat.messages];
      renderStoredChat();
      chatModal.classList.remove('open');
    });
    row.querySelector('.chat-delete').addEventListener('click', async e => {
      e.stopPropagation();
      let deletedFromIndexedDB = false;
      try {
        await idbDelete('chats', chat.id);
        deletedFromIndexedDB = true;
      } catch (_) {}

      const fallback = historyFallbackRead().filter(item => String(item?.id) !== String(chat.id));
      historyFallbackWrite(fallback);

      if (chat.id === state.chatId) {
        state.chatId = newChatId();
        conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];
        chatThread.innerHTML = '';
        const wc = document.getElementById('welcome-card');
        if (wc) wc.style.display = '';
        await saveCurrentChat();
      }
      row.remove();
      if (!deletedFromIndexedDB) historyStorage = 'localstorage';
      if (!chatList.children.length) chatList.innerHTML = '<div class="chat-empty">No saved chats yet.</div>';
    });
    chatList.appendChild(row);
  }
  chatModal.classList.add('open');
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* Full markdown renderer — bold/italic/tables/lists/headings render correctly,
   raw * and _ never reach the DOM */
function formatMessage(raw) {
  if (!raw) return '';
  let text = raw;
  const blocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const label = lang ? `<span class="code-lang">${escHtml(lang)}</span>` : '';
    blocks.push(`<pre>${label}<code>${escHtml(code.trimEnd())}</code></pre>`);
    return `\x00B${blocks.length - 1}\x00`;
  });
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^[-*_]{3,}\s*$/.test(line.trim())) { out.push('<hr>'); i++; continue; }
    const hm = line.match(/^(#{1,3})\s+(.+)/);
    if (hm) { out.push(`<h${hm[1].length}>${inlineFmt(hm[2])}</h${hm[1].length}>`); i++; continue; }
    if (line.startsWith('> ')) {
      const bq = [];
      while (i < lines.length && lines[i].startsWith('> ')) { bq.push(lines[i].slice(2)); i++; }
      out.push(`<blockquote>${inlineFmt(bq.join(' '))}</blockquote>`); continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\|?[\s:|-]+\|/.test(lines[i + 1])) {
      const tbl = [];
      while (i < lines.length && lines[i].includes('|')) { tbl.push(lines[i]); i++; }
      out.push(renderMdTable(tbl)); continue;
    }
    if (/^(\s*)[-*+]\s+/.test(line)) {
      const ls = [];
      while (i < lines.length && /^(\s*)[-*+]\s+/.test(lines[i])) { ls.push(lines[i]); i++; }
      out.push('<ul>' + ls.map(l => `<li>${inlineFmt(l.replace(/^\s*[-*+]\s+/, ''))}</li>`).join('') + '</ul>'); continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const ls = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { ls.push(lines[i]); i++; }
      out.push('<ol>' + ls.map(l => `<li>${inlineFmt(l.replace(/^\d+\.\s+/, ''))}</li>`).join('') + '</ol>'); continue;
    }
    if (line.trim() === '') { out.push('\x00BR\x00'); i++; continue; }
    out.push(inlineFmt(line)); i++;
  }
  const BLOCK = /^<(h[1-3]|pre|ul|ol|blockquote|hr|div|table)/;
  let html = '', para = [];
  const flush = () => { if (para.length) { html += `<p>${para.join('<br>')}</p>`; para = []; } };
  for (const p of out) {
    if (p === '\x00BR\x00') flush();
    else if (BLOCK.test(p)) { flush(); html += p; }
    else para.push(p);
  }
  flush();
  html = html.replace(/\x00B(\d+)\x00/g, (_, n) => blocks[n]);
  return `<div class="msg-content">${html}</div>`;
}

function inlineFmt(text) {
  const codes = [];
  const links = [];
  text = text.replace(/`([^`]+)`/g, (_, c) => { codes.push(`<code>${escHtml(c)}</code>`); return `\x01C${codes.length-1}\x01`; });
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, url) => {
    const cleanUrl = url.replace(/[\"<>]/g, '');
    links.push(`<a href="${escHtml(cleanUrl)}" target="_blank" rel="noopener noreferrer">${escHtml(label)}</a>`);
    return `\x01L${links.length-1}\x01`;
  });
  text = escHtml(text);
  text = text.replace(/\*{3}(.+?)\*{3}/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*{2}(.+?)\*{2}/g, '<strong>$1</strong>');
  text = text.replace(/_{2}(.+?)_{2}/g,    '<strong>$1</strong>');
  text = text.replace(/\*([^*\n]+?)\*/g,   '<em>$1</em>');
  text = text.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<em>$1</em>');
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
  text = text.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<]+)(?=$|[\s)\]}>])/gi, (_, prefix, url) => {
    let shown = url;
    let trailing = '';
    while (/[.,!?;:]$/.test(shown)) { trailing = shown.slice(-1) + trailing; shown = shown.slice(0, -1); }
    const href = shown.toLowerCase().startsWith('www.') ? `https://${shown}` : shown;
    return `${prefix}<a href="${href}" target="_blank" rel="noopener noreferrer">${shown}</a>${trailing}`;
  });
  text = text.replace(/\x01L(\d+)\x01/g, (_, n) => links[n]);
  return text.replace(/\x01C(\d+)\x01/g, (_, n) => codes[n]);
}

function renderMdTable(lines) {
  const parse = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const heads = parse(lines[0]);
  const rows  = lines.slice(2).map(parse);
  return `<div class="md-table-wrap"><table>`
    + `<thead><tr>${heads.map(h => `<th>${inlineFmt(h)}</th>`).join('')}</tr></thead>`
    + (rows.length ? `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inlineFmt(c??'')}</td>`).join('')}</tr>`).join('')}</tbody>` : '')
    + `</table></div>`;
}

/* updateBubble — used by streaming and final render */
function updateBubble(bubble, text, streaming) {
  bubble.innerHTML = formatMessage(text);
  if (streaming) {
    const c = document.createElement('span');
    c.className = 'stream-cursor';
    bubble.appendChild(c);
  }
}

function renderGeneratedImage(url, prompt) {
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.innerHTML = `<div class="msg-meta">rex · image</div><div class="msg-bubble image-bubble"><div class="image-caption">${escHtml(prompt)}</div><img src="${escHtml(url)}" alt="Generated image" loading="lazy"></div>`;
  chatThread.appendChild(div);
  scrollBottom(true);
}

function appendUserMsg(text, scroll = true) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="msg-meta">You</div><div class="msg-bubble">${escHtml(text)}</div>`;
  chatThread.appendChild(div);
  if (scroll) scrollBottom();
  return div;
}

const SVG_RETRY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.8-4L3 10m0 0V4m0 6h6M4 13a8 8 0 0 0 14.8 4L21 14m0 0v6m0-6h-6"/></svg>';
const SVG_SPEAKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6l-5 4H4Z"/><path d="M16 9.5a4 4 0 0 1 0 5M18.5 7a7.5 7.5 0 0 1 0 10"/></svg>';
const SVG_STOP_AUDIO = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';
let ttsState = { audio: null, activeBtn: null, objectUrl: null };

function stopTTS() {
  if (ttsState.audio) {
    ttsState.audio.pause();
    ttsState.audio.currentTime = 0;
  }
  if (ttsState.objectUrl) URL.revokeObjectURL(ttsState.objectUrl);
  if (ttsState.activeBtn) {
    ttsState.activeBtn.innerHTML = SVG_SPEAKER;
    ttsState.activeBtn.classList.remove('active', 'loading');
  }
  ttsState = { audio: null, activeBtn: null, objectUrl: null };
}

function pcmToWav(base64Audio, sampleRate = 24000, channels = 1) {
  const binary = atob(base64Audio);
  const pcm = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) pcm[i] = binary.charCodeAt(i);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + pcm.length, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, pcm.length, true);
  return new Blob([header, pcm], { type: 'audio/wav' });
}

async function handleTTS(btn, getText) {
  if (ttsState.activeBtn === btn && ttsState.audio) { stopTTS(); return; }
  if (ttsState.audio) stopTTS();
  const text = String(getText() || '').trim();
  if (!text) return;
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    const result = await bridgeRequest({ action: 'tts', text, apiKey: state.apiKeys.gemini || '' });
    if (!result.ok) throw new Error(result.error || 'Gemini TTS failed.');
    const mime = String(result.mimeType || 'audio/pcm').toLowerCase();
    let blob;
    if (mime.includes('pcm') || mime.includes('l16')) {
      const rateMatch = mime.match(/rate=(\d+)/i);
      blob = pcmToWav(result.audio, rateMatch ? Number(rateMatch[1]) : 24000);
    } else {
      const bin = atob(result.audio); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blob = new Blob([bytes], { type: result.mimeType || 'audio/wav' });
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    ttsState = { audio, activeBtn: btn, objectUrl: url };
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.classList.add('active');
    btn.innerHTML = SVG_STOP_AUDIO;
    audio.onended = stopTTS;
    audio.onerror = () => { stopTTS(); appendSystemMsg('Audio playback failed.'); };
    await audio.play();
  } catch (err) {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.innerHTML = SVG_SPEAKER;
    appendSystemMsg(`TTS error: ${err.message}`);
  }
}

function appendMsgControls(msgDiv, responseText, userPromptFn) {
  msgDiv.querySelector('.msg-controls')?.remove();
  const controls = document.createElement('div');
  controls.className = 'msg-controls';
  if (userPromptFn) {
    const retry = document.createElement('button');
    retry.className = 'msg-ctrl-btn'; retry.type = 'button';
    retry.setAttribute('aria-label', 'Retry response'); retry.title = 'Retry response'; retry.innerHTML = SVG_RETRY;
    retry.addEventListener('click', () => handleRetry(msgDiv, retry, userPromptFn));
    controls.appendChild(retry);
  }
  const speaker = document.createElement('button');
  speaker.className = 'msg-ctrl-btn'; speaker.type = 'button';
  speaker.setAttribute('aria-label', 'Read response aloud'); speaker.title = 'Read response aloud'; speaker.innerHTML = SVG_SPEAKER;
  speaker.addEventListener('click', () => handleTTS(speaker, () => msgDiv.querySelector('.msg-bubble')?.dataset.rawText || responseText));
  controls.appendChild(speaker);
  msgDiv.appendChild(controls);
}

async function handleRetry(msgDiv, retryBtn, getUserPrompt) {
  if (state.streaming) return;
  const prompt = String(getUserPrompt() || '').trim();
  const userIndex = conversationHistory.findIndex((m, i) => i > 0 && m.role === 'user' && m.content === prompt);
  if (userIndex < 0) { appendSystemMsg('Could not find the original user prompt for this response.'); return; }
  state.streaming = true;
  retryBtn.disabled = true; retryBtn.classList.add('loading');
  const bubble = msgDiv.querySelector('.msg-bubble');
  const oldHtml = bubble?.innerHTML || '';
  let streamed = '';
  try {
    const history = [{ role: 'system', content: buildRuntimeSystemPrompt() }, ...conversationHistory.slice(1, userIndex + 1)];
    const result = await cloudInfer(history, chunk => { streamed += chunk; scheduleStreamRender(bubble, streamed); });
    const finalText = streamed || result.text || '';
    updateBubble(bubble, finalText, false);
    bubble.dataset.rawText = finalText;
    let responseIndex = -1;
    for (let i = userIndex + 1; i < conversationHistory.length; i++) {
      if (conversationHistory[i].role === 'user') break;
      if (conversationHistory[i].role === 'assistant') responseIndex = i;
    }
    if (responseIndex >= 0) conversationHistory[responseIndex].content = finalText;
    else conversationHistory.push({ role: 'assistant', content: finalText });
    await saveCurrentChat();
    appendMsgControls(msgDiv, finalText, getUserPrompt);
  } catch (err) {
    bubble.innerHTML = oldHtml;
    appendSystemMsg(`Retry error: ${err.message}`);
  } finally {
    state.streaming = false;
    retryBtn.disabled = false; retryBtn.classList.remove('loading');
  }
}

function startRecording() {
  if (!btnMic || state.streaming) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    appendSystemMsg('Microphone recording is not supported by this browser.'); return;
  }
  navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 16000,
    }
  }).then(stream => {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    const mimeType = candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    state.mediaRecorder = recorder;
    recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    recorder.onerror = () => { stream.getTracks().forEach(t => t.stop()); resetRecordingUI(); appendSystemMsg('Microphone recording failed.'); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); resetRecordingUI();
      if (!chunks.length) { appendSystemMsg('No audio was recorded.'); return; }
      btnMic.disabled = true;
      try {
        setStatus('active', 'Transcribing…');
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = ''; const step = 0x8000;
        for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
        const result = await bridgeRequest({ action: 'stt', audio: btoa(binary), mimeType: blob.type || 'audio/webm' });
        if (!result.ok) throw new Error(result.error || 'Groq Whisper transcription failed.');
        userInput.value = result.text || ''; userInput.focus();
        setStatus('idle', `Idle — ${providerLabel(state.provider)} · ${getModel(state.provider)}`);
      } catch (err) {
        appendSystemMsg(`STT error: ${err.message}`); setStatus('error', 'Transcription failed');
      } finally { btnMic.disabled = false; }
    };
    recorder.start(500);
    btnMic.classList.add('recording'); btnMic.setAttribute('aria-label', 'Stop recording'); btnMic.title = 'Stop recording'; btnMic.innerHTML = SVG_STOP_AUDIO;
    userInput.classList.add('listening'); userInput.placeholder = 'Listening…';
  }).catch(err => appendSystemMsg(err.name === 'NotAllowedError' ? 'Microphone permission denied.' : `Microphone error: ${err.message}`));
}

function resetRecordingUI() {
  state.mediaRecorder = null;
  btnMic.classList.remove('recording'); btnMic.setAttribute('aria-label', 'Record voice input'); btnMic.title = 'Record voice input';
  btnMic.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3M8 21h8"/></svg>';
  userInput.classList.remove('listening'); userInput.placeholder = 'Message Rex…';
}

function stopRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') state.mediaRecorder.stop();
}

function appendStoredAgentMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg agent';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.dataset.rawText = text;
  bubble.innerHTML = formatMessage(text);
  div.innerHTML = '<div class="msg-meta">Rex</div>';
  div.appendChild(bubble);
  chatThread.appendChild(div);
  appendMsgControls(div, text, null);
}

function appendAgentBubble() {
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.innerHTML = `<div class="msg-meta">Rex</div><div class="msg-bubble"><span class="stream-cursor"></span></div>`;
  chatThread.appendChild(div);
  scrollBottom();
  return div.querySelector('.msg-bubble');
}

function appendSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.innerHTML = `<div class="msg-bubble">${escHtml(text)}</div>`;
  chatThread.appendChild(div);
  scrollBottom();
}

function appendWasmOomAlert(fileSize) {
  const sizeMB = (fileSize / 1024 / 1024).toFixed(0);
  const div = document.createElement('div');
  div.className = 'msg agent';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = `
    <div class="alert-bubble">
      <div class="alert-icon">⚠</div>
      <div class="alert-body">
        <div class="alert-title">WASM Memory Boundary Exceeded</div>
        <div>Model file is <strong>${sizeMB} MB</strong>, which exceeds the safe ~2.2 GB WebAssembly linear memory ceiling (4 GB max − KV cache allocation).</div>
        <div>The engine has automatically switched to <strong>Cloud Inference</strong> mode. Select a provider and configure your API key in ⚙ Settings.</div>
      </div>
    </div>
  `;
  div.appendChild(bubble);
  chatThread.appendChild(div);
  scrollBottom();
}

function scrollBottom(force = false) {
  if (scrollFrame) return;
  const nearBottom = force || (chatThread.scrollHeight - chatThread.scrollTop - chatThread.clientHeight < 160);
  if (!nearBottom) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    chatThread.scrollTop = chatThread.scrollHeight;
  });
}

function scheduleStreamRender(bubble, text) {
  pendingStreamBubble = bubble;
  pendingStreamText = text;
  if (streamFrame) return;
  streamFrame = requestAnimationFrame(() => {
    streamFrame = 0;
    if (!pendingStreamBubble) return;
    updateBubble(pendingStreamBubble, pendingStreamText, true);
    pendingStreamBubble = null;
    scrollBottom();
  });
}

/* ── Main Send Handler ─────────────────────────────────────── */
async function sendMessage() {
  const text = userInput.value.trim();
  if (!text || state.streaming) return;

  userInput.value = '';
  appendUserMsg(text);

  conversationHistory.push({ role: 'user', content: text });
  saveCurrentChat().catch(err => console.warn('Chat save failed:', err));

  state.streaming = true;
  btnSend.disabled = true;
  btnStop.classList.add('visible');

  const engine = state.engine;
  let agentBubble = appendAgentBubble();
  let streamedText = '';

  if (engine === 'cloud') {
    setStatus('active', `Streaming — ${providerSelect.value}`);
  } else {
    setStatus('active', 'Local WASM Inference…');
  }

  try {
    const inferFn = engine === 'wasm' ? wasmInfer : cloudInfer;
    const requestHistory = [{ role: 'system', content: buildRuntimeSystemPrompt() }, ...conversationHistory.filter(m => m.role !== 'system')];

    const onChunk = chunk => {
      streamedText += chunk;
      scheduleStreamRender(agentBubble, streamedText);
    };

    const result = await inferFn(requestHistory, onChunk);

    if (!streamedText && !result.text && !result.assistantToolCalls?.length) {
      throw new Error('The selected model returned no text or tool call. Check the model selection and API response.');
    }

    updateBubble(agentBubble, streamedText || result.text || '', false);

    // Unified agent loop: every cloud provider uses the same Rex tools.
    let currentResult = result;
    let currentText = streamedText || result.text || '';
    let rounds = 0;
    while (currentResult?.assistantToolCalls?.length && rounds < 8) {
      rounds += 1;
      conversationHistory.push({
        role: 'assistant',
        content: currentResult.text || null,
        tool_calls: currentResult.assistantToolCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.args || '{}' },
        })),
      });

      for (const call of currentResult.assistantToolCalls) {
        let args = {};
        try { args = JSON.parse(call.args || '{}'); } catch (_) { args = {}; }
        const toolResult = await dispatchTool(call.name, args);
        const pretty = JSON.stringify(toolResult, null, 2);
        const outputDiv = document.createElement('div');
        outputDiv.className = 'tool-output';
        if (call.name === 'generate_image' && toolResult.image_url) {
          // Compact one-liner: just show the key facts
          const m = toolResult.model || 'flux';
          const w = toolResult.width || 1024;
          const h = toolResult.height || 1024;
          const shortUrl = toolResult.image_url.split('/').pop();
          outputDiv.innerHTML = `<div class="tool-label">↳ generate_image · ${escHtml(m)} · ${w}×${h} · <span style="color:var(--text-muted);font-size:0.7rem">${escHtml(shortUrl)}</span></div>`;
        } else {
          outputDiv.innerHTML = `<div class="tool-label">↳ ${escHtml(call.name)}</div><pre>${escHtml(pretty.slice(0, 12000))}${pretty.length > 12000 ? '\n… output truncated in UI …' : ''}</pre>`;
        }
        agentBubble.appendChild(outputDiv);
        scrollBottom();
        conversationHistory.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: pretty });
      }

      // Detect if this round was a successful image generation
      const wasImageGen = currentResult.assistantToolCalls.some(c => c.name === 'generate_image');
      const imageGenSucceeded = wasImageGen && conversationHistory.some(m => m.role === 'tool' && m.name === 'generate_image' && (() => { try { return !JSON.parse(m.content).error; } catch(_){return false;} })());

      const followBubble = appendAgentBubble();
      let followText = '';
      const onFollowChunk = c => { followText += c; scheduleStreamRender(followBubble, followText); };
      const followHistory = [{ role: 'system', content: buildRuntimeSystemPrompt() }, ...conversationHistory.filter(m => m.role !== 'system')];
      currentResult = await inferFn(followHistory, onFollowChunk);

      if (imageGenSucceeded) {
        // Suppress any follow-up text — the image bubble already shows everything needed
        followBubble.remove();
        currentText = '';
      } else {
        updateBubble(followBubble, followText || currentResult.text || '', false);
        currentText = followText || currentResult.text || currentText;
        agentBubble = followBubble;
        streamedText = followText;
      }
    }
    if (currentResult?.assistantToolCalls?.length) {
      throw new Error('Tool loop stopped after 8 rounds to prevent an infinite tool cycle.');
    }
    const finalText = currentText;
    updateBubble(agentBubble, finalText || result.text || '', false);
    agentBubble.dataset.rawText = finalText || result.text || '';
    conversationHistory.push({ role: 'assistant', content: finalText });
    appendMsgControls(agentBubble.parentElement, finalText || result.text || '', () => text);
    state.chatLastAccess = modelIdentity();
    await saveCurrentChat();

    setStatus('idle', engine === 'cloud' ? `Idle — ${providerSelect.value}` : 'Idle — Local WASM');

  } catch (err) {
    if (err.name === 'AbortError') {
      updateBubble(agentBubble, streamedText || '', false);
      const note = document.createElement('em');
      note.style.cssText = 'color:var(--text-muted);font-size:0.8rem;display:block;margin-top:6px';
      note.textContent = '[stopped]';
      agentBubble.appendChild(note);
      setStatus('idle', 'Stopped');
    } else {
      agentBubble.innerHTML = `<span style="color:var(--danger);font-size:0.8125rem">Error: ${escHtml(err.message)}</span>`;
      setStatus('error', err.message.slice(0, 60));
    }
  } finally {
    state.streaming = false;
    btnSend.disabled = false;
    btnStop.classList.remove('visible');
    state.abortController = null;
  }
}

btnSend.addEventListener('click', sendMessage);

userInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

btnStop.addEventListener('click', () => {
  if (state.abortController) state.abortController.abort();
  if (state.wasmEngine?.exitCompletion) state.wasmEngine.exitCompletion();
});

if (btnMic) btnMic.addEventListener('click', () => {
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') stopRecording();
  else startRecording();
});

/* ── Settings ───────────────────────────────────────────────── */
const KEY_FIELDS = ['groq','openrouter','gemini','antigravity','pollinations','pollinationsModel'];
const MODEL_FALLBACKS = {
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  openrouter: ['openai/gpt-oss-120b'],
  gemini: ['gemini-3.6-flash'],
};

function updateKeyStatuses() {
  for (const key of KEY_FIELDS) {
    const el = $(`key-status-${key}`);
    const input = $(`key-${key}`);
    if (!el || !input) continue;
    const configured = Boolean(state.apiKeys[key]);
    const fromFile = apiKeyFileKeys.has(key);
    const fileLabel = apiKeyFileName ? `loaded from ${apiKeyFileName}` : 'saved locally';
    el.textContent = configured ? (fromFile ? fileLabel : 'saved locally') : 'not configured';
    el.classList.toggle('configured', configured);
    input.classList.toggle('configured', configured);
  }
}

function populateSettings() {
  for (const key of KEY_FIELDS) {
    const input = $(`key-${key}`);
    if (input) input.value = state.apiKeys[key] || '';
  }
  const nameInput = $('setting-user-name');
  if (nameInput) nameInput.value = state.userName || '';
  const appearance = $('setting-appearance');
  if (appearance) appearance.value = localStorage.getItem('rexAppearance') || 'system';
  updateKeyStatuses();
  renderModelSettings();
}

function openSettings(forceSetup = false, page = 'general') {
  populateSettings();
  $('setup-note').textContent = forceSetup
    ? 'Configure the providers you want, or upload an API Keys.txt-style file. Values are saved locally in IndexedDB.'
    : `Saved locally in this browser using IndexedDB.${apiKeyFileName ? ` ${apiKeyFileName} was loaded.` : ''}`;
  const fileStatus = $('api-key-file-status');
  if (fileStatus) fileStatus.textContent = apiKeyFileName ? `loaded: ${apiKeyFileName}` : 'none imported';
  const exaStatus = $('exa-key-status');
  if (exaStatus) exaStatus.textContent = apiKeyFileExaOverride
    ? `Exa is using the key from ${apiKeyFileName || 'the imported API key file'}. The web UI cannot change it.`
    : 'Exa is loaded from API_Keys.txt. Add Exa: YOUR_EXA_API_KEY to configure it.';
  settingsModal.classList.add('open');
  switchSettingsPage(page);
}

function switchSettingsPage(page) {
  document.querySelectorAll('.settings-page').forEach(el => el.hidden = el.dataset.page !== page);
  document.querySelectorAll('.settings-nav-btn').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  const title = $('settings-page-title');
  const subtitles = { general: 'Appearance and personal preferences', 'api-keys': 'Provider credentials and API key import', models: 'Choose a model separately for each provider', credits: 'The humans and AIs behind Rex' };
  if (title) title.textContent = page === 'api-keys' ? 'API Keys' : page === 'models' ? 'Model' : page === 'credits' ? 'Credits' : 'General';
  const subtitle = $('settings-page-subtitle');
  if (subtitle) subtitle.textContent = subtitles[page] || '';
  if (page === 'models') renderModelSettings();
}

document.querySelectorAll('.settings-nav-btn').forEach(btn => btn.addEventListener('click', () => switchSettingsPage(btn.dataset.page)));

async function fetchProviderModels(provider) {
  const key = state.apiKeys[provider];
  if (!key) return MODEL_FALLBACKS[provider] || [];
  let url, headers = {};
  if (provider === 'groq') {
    url = 'https://api.groq.com/openai/v1/models';
    headers = { Authorization: `Bearer ${key}` };
  } else if (provider === 'openrouter') {
    url = 'https://openrouter.ai/api/v1/models';
    headers = { Authorization: `Bearer ${key}` };
  } else {
    url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${providerLabel(provider)} model list returned HTTP ${res.status}`);
  const data = await res.json();
  let models;
  if (provider === 'gemini') {
    models = (data.models || [])
      .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean);
  } else if (provider === 'groq') {
    models = (data.data || [])
      .filter(m => m.active !== false)
      .filter(m => Number(m.max_completion_tokens || 1) > 1)
      .map(m => m.id)
      .filter(id => id && !/whisper|tts|audio|guard|safeguard/i.test(id));
  } else {
    models = (data.data || [])
      .filter(m => {
        const input = m.architecture?.input_modalities;
        const output = m.architecture?.output_modalities;
        return (!Array.isArray(input) || input.includes('text')) && (!Array.isArray(output) || output.includes('text'));
      })
      .map(m => m.id)
      .filter(Boolean);
  }
  models = [...new Set(models)].sort((a,b) => a.localeCompare(b));
  return models.length ? models : (MODEL_FALLBACKS[provider] || []);
}

async function loadModelOptions(provider) {
  const select = $(`model-select-${provider}`);
  const status = $(`model-status-${provider}`);
  if (!select) return;
  select.disabled = true;
  if (status) status.textContent = 'Loading available models…';
  try {
    const models = await fetchProviderModels(provider);
    if (state.modelSelections[provider] && !models.includes(state.modelSelections[provider])) models.unshift(state.modelSelections[provider]);
    select.innerHTML = [...new Set(models)].map(model => `<option value="${escHtml(model)}">${escHtml(model)}</option>`).join('');
    select.value = state.modelSelections[provider];
    if (status) status.textContent = `${models.length} model${models.length === 1 ? '' : 's'} available${state.apiKeys[provider] ? '' : ' · add an API key to load the live list'}`;
  } catch (err) {
    const models = MODEL_FALLBACKS[provider] || [];
    if (state.modelSelections[provider] && !models.includes(state.modelSelections[provider])) models.unshift(state.modelSelections[provider]);
    select.innerHTML = models.map(model => `<option value="${escHtml(model)}">${escHtml(model)}</option>`).join('');
    select.value = state.modelSelections[provider];
    if (status) status.textContent = `Could not load live list: ${err.message}`;
  } finally {
    select.disabled = false;
  }
}

function renderModelSettings() {
  for (const provider of ['groq','openrouter','gemini']) {
    const select = $(`model-select-${provider}`);
    if (select) {
      select.value = state.modelSelections[provider];
      if (!select.dataset.bound) {
        select.dataset.bound = '1';
        select.addEventListener('change', async () => {
          state.modelSelections[provider] = select.value;
          await persistProviderSettings();
          updateHeaderModel();
        });
      }
    }
    loadModelOptions(provider).catch(() => {});
  }
}

document.querySelectorAll('.model-refresh').forEach(btn => btn.addEventListener('click', () => loadModelOptions(btn.dataset.provider)));

const apiKeyFileInput = $('api-key-file-input');
const apiKeyFileBtn = $('api-key-file-btn');

async function importApiKeysFile(file) {
  if (!file) return;
  const text = await file.text();
  const imported = parseApiKeyText(text);
  if (!Object.keys(imported).length) {
    appendSystemMsg(`No recognized API keys were found in ${file.name}.`);
    return;
  }
  apiKeyFileName = file.name;
  apiKeyFileSource = 'upload';
  apiKeyFileKeys = new Set(Object.keys(imported));
  apiKeyFileExaOverride = imported.exa || null;
  const { exa, ...providerKeys } = imported;
  state.apiKeys = { ...state.apiKeys, ...providerKeys, exa: exa || apiKeyFileExaOverride || state.apiKeys.exa || '' };
  if (imported.groqModel) state.modelSelections.groq = imported.groqModel;
  if (imported.openrouterModel) state.modelSelections.openrouter = imported.openrouterModel;
  if (imported.geminiModel) state.modelSelections.gemini = imported.geminiModel;
  if (imported.antigravityModel) state.modelSelections.antigravity = imported.antigravityModel;
  await idbPut('settings', state.apiKeys, 'apiKeys');
  await idbPut('settings', apiKeyFileName, 'apiKeyFileName');
  await idbPut('settings', apiKeyFileSource, 'apiKeyFileSource');
  await idbPut('settings', apiKeyFileExaOverride, 'apiKeyFileExaOverride');
  await idbPut('settings', [...apiKeyFileKeys], 'apiKeyFileKeys');
  populateSettings();
  openSettings(false, 'api-keys');
  appendSystemMsg(`Imported API keys from ${file.name} and saved them locally in IndexedDB.`);
}

apiKeyFileBtn.addEventListener('click', () => apiKeyFileInput.click());
apiKeyFileInput.addEventListener('change', async () => {
  try { await importApiKeysFile(apiKeyFileInput.files?.[0]); }
  catch (err) { appendSystemMsg(`Could not import API key file: ${err.message}`); }
  finally { apiKeyFileInput.value = ''; }
});

$('settings-close').addEventListener('click', () => settingsModal.classList.remove('open'));
$('settings-close-2').addEventListener('click', () => settingsModal.classList.remove('open'));
settingsModal.addEventListener('click', e => { if (e.target === settingsModal) settingsModal.classList.remove('open'); });

$('setting-appearance').addEventListener('change', async e => {
  localStorage.setItem('rexAppearance', e.target.value);
  document.documentElement.dataset.appearance = e.target.value;
  await idbPut('settings', e.target.value, 'appearance');
});

$('settings-save').addEventListener('click', async () => {
  const next = {};
  for (const key of KEY_FIELDS) {
    const input = $(`key-${key}`);
    if (input) next[key] = input.value.trim();
  }
  await saveKeys(next);
  state.userName = $('setting-user-name').value.trim();
  await idbPut('settings', state.userName, 'userName');
  const appearance = $('setting-appearance').value;
  localStorage.setItem('rexAppearance', appearance);
  document.documentElement.dataset.appearance = appearance;
  await persistProviderSettings();
  updateHeaderModel();
  state.apiKeys.exa = apiKeyFileExaOverride || state.apiKeys.exa || '';
  state.exaEnabled = true;
  exaToggle.checked = true;
  await idbPut('settings', true, 'exaEnabled');
  settingsModal.classList.remove('open');
  appendSystemMsg('Settings saved locally in IndexedDB.');
  if (!state.apiKeys[state.provider]) setStatus('waiting', `${providerLabel(state.provider)} API key not configured`);
});

btnSettings.addEventListener('click', () => openSettings(false, 'general'));

/* ── Chat controls ─────────────────────────────────────────── */
btnNewChat.addEventListener('click', createNewChat);
btnChatHistory.addEventListener('click', openChatHistory);
chatClose.addEventListener('click', () => chatModal.classList.remove('open'));
chatModal.addEventListener('click', e => { if (e.target === chatModal) chatModal.classList.remove('open'); });

/* ── Init ───────────────────────────────────────────────────── */
async function init() {
  setStatus('idle', 'Loading…');
  state.remoteMode = !isLocalOrigin();
  if (state.remoteMode) {
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
    const fragmentCode = fragment.get('access');
    if (fragmentCode) {
      state.remoteAccessCode = fragmentCode;
      sessionStorage.setItem('rexRemoteAccessCode', fragmentCode);
      history.replaceState(null, '', location.pathname + location.search);
    }
  }
  if (state.remoteMode) {
    btnRemoteAccess?.setAttribute('hidden', '');
    wsDot.className = 'ws-dot connected';
    wsLabel.textContent = 'Remote bridge';
    if (!state.remoteAccessCode) {
      showRemoteGate();
      setStatus('idle', 'Waiting for remote access code');
      await new Promise(resolve => { state.remoteGateReady = resolve; });
    } else {
      try {
        await bridgeRequest({ action: 'ping' });
        hideRemoteGate();
      } catch (_) {
        showRemoteGate('Your saved access code is no longer valid.');
        await new Promise(resolve => { state.remoteGateReady = resolve; });
      }
    }
  }
  await openDB();
  await loadProviderSettings();
  if (!state.remoteMode || state.remoteAccessCode) await loadKeys();
  const savedAppearance = await idbGet('settings', 'appearance');
  if (savedAppearance) { localStorage.setItem('rexAppearance', savedAppearance); document.documentElement.dataset.appearance = savedAppearance; }
  updateHeaderModel();
  state.apiKeys.exa = apiKeyFileExaOverride || state.apiKeys.exa || '';
  state.exaEnabled = (await idbGet('settings', 'exaEnabled')) ?? true;
  exaToggle.checked = state.exaEnabled;
  updateKeyStatuses();
  await loadLatestChat();
  if (historyStorage === 'localstorage') appendSystemMsg('Chat history is using the browser fallback storage.');
  if (!state.remoteMode) connectWS();

  if (!state.remoteMode && (!window.showDirectoryPicker || !window.isSecureContext)) {
    appendSystemMsg('Workspace picker fallback: run terminal_bridge.py to attach a workspace from browsers without the File System Access picker.');
  }
  if (state.remoteMode) appendSystemMsg('Rex is connected remotely through a Cloudflare Quick Tunnel.');

  if (apiKeyFileName) appendSystemMsg(`Loaded API keys from ${apiKeyFileName}. Exa and Pollinations are available through the API key file.`);

  if (!state.apiKeys[state.provider]) {
    openSettings(true);
    appendSystemMsg('No API key is configured for the selected provider. Fill in the APIs you want in ⚙ Settings.');
  } else {
    appendSystemMsg('Rex AI ready. Cloud chat, Exa web search, workspace tools, and Pollinations image generation are available.');
  }
}

document.addEventListener('DOMContentLoaded', init);
