import { state } from './state.js';
import { ctx, $ } from './ctx.js';
import { idbGet, idbPut } from './db.js';
import { getModel, providerLabel, providerConfig } from './providers.js';
import { parseApiKeyText } from './api-keys.js';
import { normalizeMemory } from './memory.js';

/* ── Settings ───────────────────────────────────────────────── */
const KEY_FIELDS = ['groq','openrouter','gemini','antigravity','pollinations','pollinationsModel'];

const providerModelCache = new Map();
const providerModelRequests = new Map();
const MODEL_CACHE_TTL = 5 * 60 * 1000;

const MODEL_FALLBACKS = {
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  openrouter: ['openai/gpt-oss-120b'],
  gemini: ['gemini-3.6-flash'],
};

export function updateKeyStatuses() {
  for (const key of KEY_FIELDS) {
    const el = $(`key-status-${key}`);
    const input = $(`key-${key}`);
    if (!el || !input) continue;
    const configured = Boolean(state.apiKeys[key]);
    const fromFile = ctx.apiKeyFileKeys.has(key);
    const fileLabel = ctx.apiKeyFileName ? `loaded from ${ctx.apiKeyFileName}` : 'saved locally';
    el.textContent = configured ? (fromFile ? fileLabel : 'saved locally') : 'not configured';
    el.classList.toggle('configured', configured);
    input.classList.toggle('configured', configured);
  }
}

export function populateSettings() {
  for (const key of KEY_FIELDS) {
    const input = $(`key-${key}`);
    if (input) input.value = state.apiKeys[key] || '';
  }
  const nameInput = $('setting-user-name');
  if (nameInput) nameInput.value = state.userName || '';
  const memoryInput = $('setting-memory');
  if (memoryInput) memoryInput.value = state.memory || '';
  const memoryStatus = $('memory-status');
  if (memoryStatus) memoryStatus.textContent = state.memory ? `${state.memory.split('\n').length} saved memory entr${state.memory.split('\n').length === 1 ? 'y' : 'ies'}. Stored only in this browser.` : 'No memories saved yet. Stored only in this browser.';
  const appearance = $('setting-appearance');
  if (appearance) appearance.value = localStorage.getItem('rexAppearance') || 'system';
  updateKeyStatuses();
}

export function openSettings(forceSetup = false, page = 'general') {
  populateSettings();
  $('setup-note').textContent = forceSetup
    ? 'Configure the providers you want, or upload an API Keys.txt-style file. Values are saved locally in IndexedDB.'
    : `Saved locally in this browser using IndexedDB.${ctx.apiKeyFileName ? ` ${ctx.apiKeyFileName} was loaded.` : ''}`;
  const fileStatus = $('api-key-file-status');
  if (fileStatus) fileStatus.textContent = ctx.apiKeyFileName ? `loaded: ${ctx.apiKeyFileName}` : 'none imported';
  const exaStatus = $('exa-key-status');
  if (exaStatus) exaStatus.textContent = ctx.apiKeyFileExaOverride
    ? `Exa is using the key from ${ctx.apiKeyFileName || 'the imported API key file'}. The web UI cannot change it.`
    : 'Exa is loaded from API_Keys.txt. Add Exa: YOUR_EXA_API_KEY to configure it.';
  ctx.settingsModal.classList.add('open');
  switchSettingsPage(page);
}

export function switchSettingsPage(page) {
  document.querySelectorAll('.settings-page').forEach(el => el.hidden = el.dataset.page !== page);
  document.querySelectorAll('.settings-nav-btn').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  const title = $('settings-page-title');
  const subtitles = {
    general: 'Appearance and personal preferences',
    'api-keys': 'Provider credentials and API key import',
    models: 'Choose a model separately for each provider',
    memory: 'Review and edit what Rex remembers about you',
    prompts: 'Reusable prompt snippets for quick insertion',
    credits: 'The humans and AIs behind Rex',
  };
  const titles = {
    general: 'General',
    'api-keys': 'API Keys',
    models: 'Model',
    memory: 'Memory',
    prompts: 'Prompts',
    credits: 'Credits',
  };
  if (title) title.textContent = titles[page] || 'General';
  const subtitle = $('settings-page-subtitle');
  if (subtitle) subtitle.textContent = subtitles[page] || '';
  if (page === 'models') renderModelSettings();
  if (page === 'prompts') ctx.renderPromptLibrary();
}


export async function fetchProviderModels(provider) {
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
  if (!res.ok) throw new Error(`${ctx.providerLabel(provider)} model list returned HTTP ${res.status}`);
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
export async function loadModelOptions(provider, forceRefresh = false) {
  const select = $(`model-select-${provider}`);
  const status = $(`model-status-${provider}`);
  if (!select) return;
  select.disabled = true;
  if (status) status.textContent = 'Loading available models…';
  try {
    const cached = providerModelCache.get(provider);
    let models;
    if (!forceRefresh && cached && Date.now() - cached.savedAt < MODEL_CACHE_TTL) {
      models = cached.models.slice();
    } else {
      let request = providerModelRequests.get(provider);
      if (!request || forceRefresh) {
        request = fetchProviderModels(provider);
        providerModelRequests.set(provider, request);
      }
      try {
        models = await request;
        providerModelCache.set(provider, { models: models.slice(), savedAt: Date.now() });
      } finally {
        if (providerModelRequests.get(provider) === request) providerModelRequests.delete(provider);
      }
    }
    if (state.modelSelections[provider] && !models.includes(state.modelSelections[provider])) models.unshift(state.modelSelections[provider]);
    select.innerHTML = [...new Set(models)].map(model => `<option value="${ctx.escHtml(model)}">${ctx.escHtml(model)}</option>`).join('');
    select.value = state.modelSelections[provider];
    if (status) status.textContent = `${models.length} model${models.length === 1 ? '' : 's'} available${state.apiKeys[provider] ? '' : ' · add an API key to load the live list'}`;
  } catch (err) {
    const models = MODEL_FALLBACKS[provider] || [];
    if (state.modelSelections[provider] && !models.includes(state.modelSelections[provider])) models.unshift(state.modelSelections[provider]);
    select.innerHTML = models.map(model => `<option value="${ctx.escHtml(model)}">${ctx.escHtml(model)}</option>`).join('');
    select.value = state.modelSelections[provider];
    if (status) status.textContent = `Could not load live list: ${err.message}`;
  } finally {
    select.disabled = false;
  }
}
export function renderModelSettings() {
  for (const provider of ['groq','openrouter','gemini']) {
    const select = $(`model-select-${provider}`);
    if (select) {
      select.value = state.modelSelections[provider];
      if (!select.dataset.bound) {
        select.dataset.bound = '1';
        select.addEventListener('change', async () => {
          state.modelSelections[provider] = select.value;
          await ctx.persistProviderSettings();
          ctx.updateHeaderModel();
        });
      }
    }
    loadModelOptions(provider).catch(() => {});
  }
}
export async function importApiKeysFile(file) {
  if (!file) return;
  const text = await file.text();
  const imported = parseApiKeyText(text);
  if (!Object.keys(imported).length) {
    ctx.appendSystemMsg(`No recognized API keys were found in ${file.name}.`);
    return;
  }
  ctx.apiKeyFileName = file.name;
  ctx.apiKeyFileSource = 'upload';
  ctx.apiKeyFileKeys = new Set(Object.keys(imported));
  ctx.apiKeyFileExaOverride = imported.exa || null;
  const { exa, ...providerKeys } = imported;
  state.apiKeys = { ...state.apiKeys, ...providerKeys, exa: exa || ctx.apiKeyFileExaOverride || state.apiKeys.exa || '' };
  if (imported.groqModel) state.modelSelections.groq = imported.groqModel;
  if (imported.openrouterModel) state.modelSelections.openrouter = imported.openrouterModel;
  if (imported.geminiModel) state.modelSelections.gemini = imported.geminiModel;
  if (imported.antigravityModel) state.modelSelections.antigravity = imported.antigravityModel;
  await ctx.idbPut('settings', state.apiKeys, 'apiKeys');
  await ctx.idbPut('settings', ctx.apiKeyFileName, 'ctx.apiKeyFileName');
  await ctx.idbPut('settings', ctx.apiKeyFileSource, 'ctx.apiKeyFileSource');
  await ctx.idbPut('settings', ctx.apiKeyFileExaOverride, 'ctx.apiKeyFileExaOverride');
  await ctx.idbPut('settings', [...apiKeyFileKeys], 'ctx.apiKeyFileKeys');
  populateSettings();
  openSettings(false, 'api-keys');
  ctx.appendSystemMsg(`Imported API keys from ${file.name} and saved them locally in IndexedDB.`);
}

export function bindSettingsUI() {
document.querySelectorAll('.settings-nav-btn').forEach(btn => btn.addEventListener('click', () => switchSettingsPage(btn.dataset.page)));





document.querySelectorAll('.model-refresh').forEach(btn => btn.addEventListener('click', () => loadModelOptions(btn.dataset.provider, true)));

const apiKeyFileInput = $('api-key-file-input');
const apiKeyFileBtn = $('api-key-file-btn');


apiKeyFileBtn.addEventListener('click', () => apiKeyFileInput.click());
apiKeyFileInput.addEventListener('change', async () => {
  try { await importApiKeysFile(apiKeyFileInput.files?.[0]); }
  catch (err) { ctx.appendSystemMsg(`Could not import API key file: ${err.message}`); }
  finally { apiKeyFileInput.value = ''; }
});

$('settings-close').addEventListener('click', () => ctx.settingsModal.classList.remove('open'));
$('settings-close-2').addEventListener('click', () => ctx.settingsModal.classList.remove('open'));
ctx.settingsModal.addEventListener('click', e => { if (e.target === ctx.settingsModal) ctx.settingsModal.classList.remove('open'); });

$('setting-appearance').addEventListener('change', async e => {
  localStorage.setItem('rexAppearance', e.target.value);
  document.documentElement.dataset.appearance = e.target.value;
  await ctx.idbPut('settings', e.target.value, 'appearance');
});

$('memory-clear').addEventListener('click', async () => {
  state.memory = '';
  await ctx.idbPut('settings', '', 'memory');
  $('setting-memory').value = '';
  $('memory-status').textContent = 'Memory cleared. Stored only in this browser.';
});

$('settings-save').addEventListener('click', async () => {
  const next = {};
  for (const key of KEY_FIELDS) {
    const input = $(`key-${key}`);
    if (input) next[key] = input.value.trim();
  }
  await saveKeys(next);
  state.userName = $('setting-user-name').value.trim();
  await ctx.idbPut('settings', state.userName, 'userName');
  const appearance = $('setting-appearance').value;
  localStorage.setItem('rexAppearance', appearance);
  document.documentElement.dataset.appearance = appearance;
  await ctx.persistProviderSettings();
  state.memory = normalizeMemory($('setting-memory')?.value || '');
  await ctx.idbPut('settings', state.memory, 'memory');
  if ($('setting-memory')) $('setting-memory').value = state.memory;
  if ($('memory-status')) $('memory-status').textContent = state.memory ? `${state.memory.split('\n').length} saved memory entr${state.memory.split('\n').length === 1 ? 'y' : 'ies'}. Stored only in this browser.` : 'Memory cleared. Stored only in this browser.';
  ctx.updateHeaderModel();
  state.apiKeys.exa = ctx.apiKeyFileExaOverride || state.apiKeys.exa || '';
  state.exaEnabled = true;
  ctx.exaToggle.checked = true;
  await ctx.idbPut('settings', true, 'exaEnabled');
  ctx.settingsModal.classList.remove('open');
  ctx.appendSystemMsg('Settings saved locally in IndexedDB.');
  if (!state.apiKeys[state.provider]) ctx.setStatus('waiting', `${ctx.providerLabel(state.provider)} API key not configured`);
});

ctx.btnSettings.addEventListener('click', () => openSettings(false, 'general'));
}
