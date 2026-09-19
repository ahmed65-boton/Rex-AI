/* ============================================================
   HYBRID AGENT ENGINE — app.js
   Dual-engine AI pipeline: Multi-Provider Cloud + Client-Side WASM
   Terminal execution bridge via WebSocket ws://127.0.0.1:8765
   File System Access API with root-guard protection
   ============================================================ */

'use strict';

// Provider credentials are loaded from API_Keys.txt or Settings.
const BUILTIN_API_KEYS = {};
const API_KEY_FILENAMES = ['API Keys.txt', 'API_Keys.txt', 'api keys.txt', 'api_keys.txt'];
let apiKeyFileName = null;
let apiKeyFileExaOverride = null;
let apiKeyFileKeys = new Set();
let apiKeyFileSource = null;

/* ── App State ─────────────────────────────────────────────── */
const state = {
  engine: 'cloud',           // 'cloud' | 'wasm'
  provider: 'groq',          // groq | openrouter | gemini
  modelSelections: {
    groq: 'openai/gpt-oss-120b',
    openrouter: 'openai/gpt-oss-120b',
    gemini: 'gemini-3.6-flash',
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
};

/* ── IndexedDB persistence ─────────────────────────────────── */
const DB_NAME = 'rex_ai_db';
const DB_VERSION = 1;
let dbPromise;
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
    'google gemini': 'gemini',
    'open router': 'openrouter',
    'openrouter': 'openrouter',
    'openrouter api key': 'openrouter',
    'openrouter model': 'openrouterModel',
    'groq model': 'groqModel',
    'gemini model': 'geminiModel',
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
  // Start with embedded defaults, then let IndexedDB values win.
  try { state.apiKeys = { ...BUILTIN_API_KEYS, ...((await idbGet('settings', 'apiKeys')) || {}) }; } catch (err) {
    state.apiKeys = { ...BUILTIN_API_KEYS };
    console.warn('IndexedDB settings unavailable:', err);
  }
  apiKeyFileName = (await idbGet('settings', 'apiKeyFileName')) || null;
  apiKeyFileSource = (await idbGet('settings', 'apiKeyFileSource')) || null;
  apiKeyFileExaOverride = (await idbGet('settings', 'apiKeyFileExaOverride')) || null;
  const persistedFileKeys = (await idbGet('settings', 'apiKeyFileKeys')) || [];
  apiKeyFileKeys = new Set(Array.isArray(persistedFileKeys) ? persistedFileKeys : []);
  state.apiKeys.exa = apiKeyFileExaOverride || state.apiKeys.exa || '';

  const fileKeys = await loadApiKeyFile();
  if (Object.keys(fileKeys).length) {
    const { exa, ...storedKeys } = fileKeys;
    state.apiKeys = { ...state.apiKeys, ...storedKeys, exa: exa || apiKeyFileExaOverride || state.apiKeys.exa || '' };
    if (fileKeys.groqModel) state.modelSelections.groq = fileKeys.groqModel;
    if (fileKeys.openrouterModel) state.modelSelections.openrouter = fileKeys.openrouterModel;
    if (fileKeys.geminiModel) state.modelSelections.gemini = fileKeys.geminiModel;
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
function connectWS() {
  if (state.wsocket && state.wsocket.readyState < 2) return;
  try {
    const ws = new WebSocket('ws://127.0.0.1:8765');
    ws.onopen = () => {
      state.wsConnected = true;
      wsDot.className = 'ws-dot connected';
      wsLabel.textContent = 'Bridge: connected';
      appendSystemMsg('Terminal bridge connected on ws://127.0.0.1:8765');
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
  if (!state.wsConnected || !state.wsocket) {
    throw new Error('Terminal/workspace bridge is offline. Start terminal_bridge.py first.');
  }
  return sendCommand(payload, true);
}

btnAttach.addEventListener('click', async () => {
  try {
    if (hasNativeDirectoryPicker()) {
      const handle = await window.showDirectoryPicker({ id: 'rex-ai-workspace', mode: 'readwrite' });
      state.workspaceHandle = handle;
      state.workspaceRootName = handle.name;
      state.bridgeWorkspace = false;
      await updateWorkspaceUI(handle.name, 'Browser File System');
      appendSystemMsg(`Workspace attached: ${handle.name} (browser read/write access)`);
      return;
    }

    if (!state.wsConnected) {
      const reason = !window.isSecureContext
        ? 'This page is not running in a secure context.'
        : 'This browser does not support showDirectoryPicker().';
      appendSystemMsg(`${reason} Starting terminal_bridge.py enables the native workspace picker fallback.`);
      throw new Error('Workspace picker unavailable. Start terminal_bridge.py and click Attach Workspace again.');
    }

    setStatus('waiting', 'Choose workspace…');
    const result = await bridgeRequest({ action: 'pick_workspace' });
    if (!result?.ok || !result.workspace) throw new Error(result?.error || 'No workspace selected.');
    state.workspaceHandle = null;
    state.bridgeWorkspace = true;
    state.workspaceRootName = result.workspaceName;
    await updateWorkspaceUI(result.workspaceName, 'Bridge');
    appendSystemMsg(`Workspace attached through local bridge: ${result.workspaceName}`);
    setStatus('idle', `Workspace: ${result.workspaceName}`);
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
      if (!state.wsConnected) return { error: 'Image generation requires the local Rex bridge. Start terminal_bridge.py first.' };
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
  if (!cfg.key || cfg.key === 'REPLACE_WITH_OPENROUTER_KEY') throw new Error(`${provider} API key not set. Open ⚙ Settings or upload an API Keys.txt file.`);

  const body = {
    model: cfg.model,
    messages,
    stream: true,
    max_tokens: 4096,
    tools: TOOLS_SCHEMA,
    tool_choice: 'auto',
  };
  state.abortController = new AbortController();
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', ...(cfg.extraHeaders || {}) },
    body: JSON.stringify(body),
    signal: state.abortController.signal,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${provider} API error ${res.status}: ${err.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  const toolCalls = {};
  let buffer = '';
  const consumeLine = rawLine => {
    const line = rawLine.trim();
    if (!line || !line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (raw === '[DONE]') return;
    try {
      const delta = JSON.parse(raw);
      const choice = delta.choices?.[0];
      const d = choice?.delta;
      if (d?.content) { fullText += d.content; onChunk(d.content); }
      for (const tc of (d?.tool_calls || [])) {
        const idx = tc.index ?? 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', args: '' };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].name = tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
      }
    } catch (_) {}
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    lines.forEach(consumeLine);
  }
  if (buffer) consumeLine(buffer);

  const calls = Object.values(toolCalls).filter(c => c.name);
  if (!calls.length) return { text: fullText, toolCalls: [], assistantToolCalls: [] };
  return { text: fullText, toolCalls: [], assistantToolCalls: calls };
}

function getModel(provider) {
  return state.modelSelections?.[provider] || (provider === 'gemini' ? 'gemini-3.6-flash' : 'openai/gpt-oss-120b');
}

function providerLabel(provider) {
  return ({ groq: 'GroqCloud', openrouter: 'OpenRouter', gemini: 'Google Gemini' })[provider] || provider;
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
  if (savedProvider && ['groq','openrouter','gemini'].includes(savedProvider)) state.provider = savedProvider;
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
  if (!key) throw new Error('Gemini API key not set. Open ⚙ Settings or upload an API Keys.txt file.');
  const model = getModel('gemini');
  const systemMsg = messages.find(m => m.role === 'system');
  const contents = openRouterToolResultsForGemini(messages.filter(m => m.role !== 'system'));
  const requestBody = {
    contents,
    tools: GEMINI_TOOLS,
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
    generationConfig: { maxOutputTokens: 4096 },
  };
  state.abortController = new AbortController();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody), signal: state.abortController.signal });
  if (!res.ok) { const errBody = await res.text().catch(()=>''); /* Suppress Gemini 4xx silently — bad tool-signature errors are Gemini-internal and unactionable */ if (res.status >= 400 && res.status < 500) return { text: '', toolCalls: [], assistantToolCalls: [] }; throw new Error(`Gemini API error ${res.status}: ${errBody.slice(0, 300)}`); }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  let fullText = '';
  const calls = [];
  for (const part of parts) {
    if (part.text) { fullText += part.text; onChunk(part.text); }
    if (part.functionCall) calls.push({ id: `gemini_${Date.now()}_${calls.length}`, name: part.functionCall.name, args: JSON.stringify(part.functionCall.args || {}) });
  }
  return { text: fullText, toolCalls: [], assistantToolCalls: calls };
}

async function cloudInfer(messages, onChunk) {
  if (state.provider === 'gemini') return geminiInfer(messages, onChunk);
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
- Use markdown so it renders — **bold**, *italic*, `code`, tables, headings. Never output raw * or _ characters as literal text.
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

async function saveCurrentChat() {
  if (!state.chatId) state.chatId = newChatId();
  const messages = conversationHistory.filter(m => m.role !== 'system');
  const firstUser = messages.find(m => m.role === 'user');
  const title = firstUser ? String(firstUser.content).replace(/\s+/g, ' ').slice(0, 70) : 'New chat';
  await idbPut('chats', { id: state.chatId, title, messages, updatedAt: Date.now() });
}

async function loadLatestChat() {
  const chats = await idbAll('chats');
  chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!chats.length) { state.chatId = newChatId(); await saveCurrentChat(); return; }
  const chat = chats[0];
  state.chatId = chat.id;
  conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }, ...(chat.messages || [])];
  renderStoredChat();
}

function renderStoredChat() {
  chatThread.innerHTML = '';
  for (const message of conversationHistory) {
    if (message.role === 'user') appendUserMsg(message.content, false);
    else if (message.role === 'assistant' && message.content) appendStoredAgentMsg(message.content);
  }
  scrollBottom();
}

async function openChatHistory() {
  const chats = (await idbAll('chats')).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  chatList.innerHTML = '';
  if (!chats.length) { chatList.innerHTML = '<div class="chat-empty">No saved chats yet.</div>'; }
  for (const chat of chats) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.innerHTML = `<button class="chat-open"><span class="chat-title">${escHtml(chat.title || 'New chat')}</span><span class="chat-date">${new Date(chat.updatedAt || Date.now()).toLocaleString()}</span></button><button class="chat-delete" title="Delete">✕</button>`;
    row.querySelector('.chat-open').addEventListener('click', async () => {
      state.chatId = chat.id;
      conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }, ...(chat.messages || [])];
      renderStoredChat();
      chatModal.classList.remove('open');
    });
    row.querySelector('.chat-delete').addEventListener('click', async e => {
      e.stopPropagation();
      await idbDelete('chats', chat.id);
      if (chat.id === state.chatId) await createNewChat();
      row.remove();
    });
    chatList.appendChild(row);
  }
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
  text = text.replace(/`([^`]+)`/g, (_, c) => { codes.push(`<code>${escHtml(c)}</code>`); return `\x01C${codes.length-1}\x01`; });
  text = escHtml(text);
  text = text.replace(/\*{3}(.+?)\*{3}/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*{2}(.+?)\*{2}/g, '<strong>$1</strong>');
  text = text.replace(/_{2}(.+?)_{2}/g,    '<strong>$1</strong>');
  text = text.replace(/\*([^*\n]+?)\*/g,   '<em>$1</em>');
  text = text.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<em>$1</em>');
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
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

function appendStoredAgentMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.innerHTML = `<div class="msg-meta">Rex</div><div class="msg-bubble">${formatMessage(text)}</div>`;
  chatThread.appendChild(div);
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

    // Gemini 4xx returns empty silently — nothing to show, clean up and exit
    if (!streamedText && !result.text && !result.assistantToolCalls?.length) {
      agentBubble.remove();
      setStatus('idle', `Idle — ${providerSelect.value}`);
      state.streaming = false;
      btnSend.disabled = false;
      btnStop.classList.remove('visible');
      return;
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
    conversationHistory.push({ role: 'assistant', content: finalText });
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

/* ── Settings ───────────────────────────────────────────────── */
const KEY_FIELDS = ['groq','openrouter','gemini','pollinations','pollinationsModel'];
const MODEL_FALLBACKS = {
  groq: ['openai/gpt-oss-120b'],
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
  const subtitles = { general: 'Appearance and personal preferences', 'api-keys': 'Provider credentials and API key import', models: 'Choose a model separately for each provider' };
  if (title) title.textContent = page === 'api-keys' ? 'API Keys' : page === 'models' ? 'Model' : 'General';
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
  let models = provider === 'gemini'
    ? (data.models || []).filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map(m => String(m.name || '').replace(/^models\//, ''))
    : (data.data || []).map(m => m.id).filter(Boolean);
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
  await openDB();
  await loadProviderSettings();
  await loadKeys();
  const savedAppearance = await idbGet('settings', 'appearance');
  if (savedAppearance) { localStorage.setItem('rexAppearance', savedAppearance); document.documentElement.dataset.appearance = savedAppearance; }
  updateHeaderModel();
  state.apiKeys.exa = apiKeyFileExaOverride || state.apiKeys.exa || '';
  state.exaEnabled = (await idbGet('settings', 'exaEnabled')) ?? true;
  exaToggle.checked = state.exaEnabled;
  updateKeyStatuses();
  await loadLatestChat();
  connectWS();

  if (!window.showDirectoryPicker || !window.isSecureContext) {
    appendSystemMsg('Workspace picker fallback: run terminal_bridge.py to attach a workspace from browsers without the File System Access picker.');
  }

  if (apiKeyFileName) appendSystemMsg(`Loaded API keys from ${apiKeyFileName}. Exa and Pollinations are available through the API key file.`);

  if (!state.apiKeys[state.provider]) {
    openSettings(true);
    appendSystemMsg('No API key is configured for the selected provider. Fill in the APIs you want in ⚙ Settings.');
  } else {
    appendSystemMsg('Rex AI ready. Cloud chat, Exa web search, workspace tools, and Pollinations image generation are available.');
  }
}

document.addEventListener('DOMContentLoaded', init);
