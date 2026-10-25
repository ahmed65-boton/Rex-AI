import { state } from './state.js';
import { ctx, $ } from './ctx.js';
import { idbGet, idbPut } from './db.js';
import { initCryptoKey, hasSessionKey, encryptJSON, decryptJSON } from './crypto.js';
import { parseApiKeyText } from './api-keys.js';
import { bridgeRequest } from './ws.js';
import { openRexDialog, addDialogButton } from './ui.js';

export async function loadApiKeyFile() {
  // Prefer the local bridge because it can read exact filenames even in Firefox.
  try {
    const result = await ctx.bridgeRequest({ action: 'load_api_keys' });
    if (result?.ok && result.keys) {
      ctx.apiKeyFileName = result.fileName || null;
      ctx.apiKeyFileKeys = new Set(Object.keys(result.keys));
      return result.keys;
    }
  } catch (_) {}

  // The HTTP server intentionally blocks API key files for security.\n  // Avoid probing them over HTTP; import keys in Settings or use the local bridge.\n
  return {};
}

export async function loadKeys() {
  let storedKeys = {};
  let encrypted = null;
  try { encrypted = await ctx.idbGet('settings', 'apiKeysEnc'); } catch (_) {}
  try {
    if (encrypted && hasSessionKey()) {
      storedKeys = await decryptJSON(encrypted);
    } else if (!encrypted) {
      storedKeys = (await ctx.idbGet('settings', 'apiKeys')) || {};
    }
  } catch (err) {
    console.warn('Could not decrypt saved keys:', err);
    storedKeys = {};
  }

  state.apiKeys = { ...storedKeys };
  ctx.apiKeyFileName = (await ctx.idbGet('settings', 'ctx.apiKeyFileName')) || null;
  ctx.apiKeyFileSource = (await ctx.idbGet('settings', 'ctx.apiKeyFileSource')) || null;
  ctx.apiKeyFileExaOverride = (await ctx.idbGet('settings', 'ctx.apiKeyFileExaOverride')) || null;
  const persistedFileKeys = (await ctx.idbGet('settings', 'ctx.apiKeyFileKeys')) || [];
  ctx.apiKeyFileKeys = new Set(Array.isArray(persistedFileKeys) ? persistedFileKeys : []);
  state.apiKeys.exa = ctx.apiKeyFileExaOverride || state.apiKeys.exa || '';

  const fileKeys = await loadApiKeyFile();
  if (Object.keys(fileKeys).length) {
    const { exa, ...fileProviderKeys } = fileKeys;
    const mergedKeys = { ...state.apiKeys };
    for (const [key, value] of Object.entries(fileProviderKeys)) {
      const current = String(mergedKeys[key] || '').trim();
      const isBuiltinFallback = !current || current.startsWith('REPLACE---ME');
      if (isBuiltinFallback) mergedKeys[key] = value;
    }
    state.apiKeys = { ...mergedKeys, exa: exa || ctx.apiKeyFileExaOverride || state.apiKeys.exa || '' };
    if (fileKeys.groqModel) state.modelSelections.groq = fileKeys.groqModel;
    if (fileKeys.openrouterModel) state.modelSelections.openrouter = fileKeys.openrouterModel;
    if (fileKeys.geminiModel) state.modelSelections.gemini = fileKeys.geminiModel;
    if (fileKeys.antigravityModel) state.modelSelections.antigravity = fileKeys.antigravityModel;
    ctx.apiKeyFileExaOverride = exa || ctx.apiKeyFileExaOverride || null;
    ctx.apiKeyFileSource = 'auto-detected';
    await saveKeys(state.apiKeys);
    await ctx.idbPut('settings', ctx.apiKeyFileName, 'ctx.apiKeyFileName');
    await ctx.idbPut('settings', ctx.apiKeyFileSource, 'ctx.apiKeyFileSource');
    await ctx.idbPut('settings', ctx.apiKeyFileExaOverride, 'ctx.apiKeyFileExaOverride');
    await ctx.idbPut('settings', Object.keys(fileKeys), 'ctx.apiKeyFileKeys');
  }
}

export async function saveKeys(keys) {
  const nextKeys = { ...keys };
  delete nextKeys.exa;
  state.apiKeys = { ...state.apiKeys, ...nextKeys, exa: ctx.apiKeyFileExaOverride || state.apiKeys.exa || '' };
  if (hasSessionKey()) {
    try {
      const payload = await encryptJSON(state.apiKeys);
      await ctx.idbPut('settings', payload, 'apiKeysEnc');
      try { await ctx.idbDelete('settings', 'apiKeys'); } catch (_) {}
    } catch (err) {
      console.warn('Encryption failed, falling back to plaintext:', err);
      await ctx.idbPut('settings', state.apiKeys, 'apiKeys');
    }
  } else {
    await ctx.idbPut('settings', state.apiKeys, 'apiKeys');
  }
  ctx.updateKeyStatuses();
}

export async function promptPassphrase(firstRun) {
  const dialog = ctx.openRexDialog(
    firstRun ? 'Protect your API keys' : 'Unlock API keys',
    firstRun
      ? 'Choose a passphrase. It is never saved — you will re-enter it each session. If you forget it, saved keys cannot be recovered.'
      : 'Enter your passphrase to decrypt saved API keys.'
  );
  const input = document.createElement('input');
  input.className = 'field-input rex-dialog-input';
  input.type = 'password';
  input.autocomplete = 'off';
  input.placeholder = 'Passphrase';
  dialog.body.appendChild(input);
  ctx.addDialogButton(dialog, 'Cancel', null);
  const submit = document.createElement('button');
  submit.className = 'btn-primary';
  submit.textContent = firstRun ? 'Set passphrase' : 'Unlock';
  submit.addEventListener('click', () => { if (input.value) dialog.close(input.value); });
  dialog.footer.appendChild(submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && input.value) dialog.close(input.value); });
  requestAnimationFrame(() => input.focus());
  return dialog.promise;
}

export async function ensureCryptoReady() {
  let saltB64 = null;
  try { saltB64 = await ctx.idbGet('settings', 'cryptoSalt'); } catch (_) {}
  if (!saltB64) {
    const pass = await promptPassphrase(true);
    if (!pass) return false;
    saltB64 = await initCryptoKey(pass, null);
    await ctx.idbPut('settings', saltB64, 'cryptoSalt');
    return true;
  }
  while (true) {
    const pass = await promptPassphrase(false);
    if (!pass) return false;
    try {
      await initCryptoKey(pass, saltB64);
      const probe = await ctx.idbGet('settings', 'apiKeysEnc');
      if (probe) await decryptJSON(probe);
      return true;
    } catch (err) {
      clearSessionKey();
      await new Promise(r => setTimeout(r, 250));
    }
  }
}

