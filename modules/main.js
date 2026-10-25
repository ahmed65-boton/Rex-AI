/**
 * Rex AI — thin entry.
 * Logic + DOM wiring live in src/app.js; smaller helpers in src/* modules.
 */
import { state } from './state.js';
import { openDB, idbGet } from './db.js';
import { connectWS, bridgeRequest, isLocalOrigin } from './ws.js';
import { normalizeMemory } from './memory.js';
import { loadApiKeySchema } from './api-keys.js';
import { loadTerminalBlocklist } from './command-risk.js';
import {
  ensureCryptoReady, loadProviderSettings, loadKeys, loadLatestChat,
  updateHeaderModel, updateKeyStatuses, refreshAttachVisibility, setStatus,
  showRemoteGate, hideRemoteGate, appendSystemMsg,
} from './app.js';

// Importing app.js also registers DOM listeners and configures providers/bridge/attachments.
import './app.js';

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
    const btnRemoteAccess = document.getElementById('btn-remote-access');
    const wsDot = document.getElementById('ws-dot');
    const wsLabel = document.getElementById('ws-label');
    btnRemoteAccess?.setAttribute('hidden', '');
    if (wsDot) wsDot.className = 'ws-dot connected';
    if (wsLabel) wsLabel.textContent = 'Remote bridge';
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
  await ensureCryptoReady();
  try { await loadApiKeySchema('api_keys_schema.json'); } catch (err) {
    console.warn('Could not load api_keys_schema.json:', err);
  }
  try { await loadTerminalBlocklist('terminal_blocklist.json'); } catch (err) {
    console.warn('Could not load terminal_blocklist.json:', err);
  }
  await loadProviderSettings();
  state.memory = normalizeMemory(await idbGet('settings', 'memory') || '');
  if (!state.remoteMode || state.remoteAccessCode) await loadKeys();
  const savedAppearance = await idbGet('settings', 'appearance');
  if (savedAppearance) {
    localStorage.setItem('rexAppearance', savedAppearance);
    document.documentElement.dataset.appearance = savedAppearance;
  }
  updateHeaderModel();
  state.exaEnabled = (await idbGet('settings', 'exaEnabled')) ?? true;
  const exaToggle = document.getElementById('exa-toggle');
  if (exaToggle) exaToggle.checked = state.exaEnabled;
  updateKeyStatuses();
  await loadLatestChat();
  if (!state.remoteMode) connectWS();
  refreshAttachVisibility();
  setStatus('idle', 'Ready');
  setTimeout(() => {
    if (!state.wsConnected && !state.remoteMode) appendSystemMsg('BackEnd not connected');
  }, 3000);
}

init().catch(err => {
  console.error(err);
  setStatus('error', 'Init failed');
});
