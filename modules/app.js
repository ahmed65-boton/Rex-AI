import { parseApiKeyText, loadApiKeySchema } from './api-keys.js';
import { assessRisk } from './command-risk.js';
import { escHtml, formatMessage } from './markdown.js';
import { state } from './state.js';
import { openDB, idbGet, idbPut, idbDelete, idbAll } from './db.js';
import { configureBridge, connectWS, sendCommand, bridgeRequest, isLocalOrigin } from './ws.js';
import { configureProviders, getModel, providerLabel, providerConfig } from './providers.js';
import { TOOLS_SCHEMA, GEMINI_TOOLS } from './tools.js';
import { normalizeMemory, applyMemoryChanges } from './memory.js';
import { openRexDialog, addDialogButton, showTextEntryModal } from './ui.js';
import { initCryptoKey, hasSessionKey, clearSessionKey, encryptJSON, decryptJSON } from './crypto.js';
import { computeDiff, renderDiffHtml } from './diff.js';
import { logEvent } from './debug.js';
import { savePrompt, listPrompts, deletePrompt } from './prompts.js';
import {
  configureAttachments, bindAttachmentUI, clearAttachmentPreview, handleAttachedFile,
} from './attachments.js';
import { configureRisk, renderRiskCard } from './risk.js';
import { configureInfer, cloudInfer, wasmInfer } from './infer.js';
import { ctx, $, assignCtx } from './ctx.js';

import {
  loadApiKeyFile, loadKeys, saveKeys, promptPassphrase, ensureCryptoReady,
} from './keys.js';
import {
  hasNativeDirectoryPicker, showRemoteGate, hideRemoteGate, setRemoteAccessInfo,
  startRemoteAccess, stopRemoteAccess, ensureWorkspacePicker, renderWorkspacePicker,
  openWorkspacePicker, updateWorkspaceUI, guardedDelete, writeFile, readFile, bindWorkspaceUI,
} from './workspace-ui.js';
import { exaSearch } from './exa.js';
import { dispatchTool } from './tools-dispatch.js';
import {
  modelIdentity, identityText, buildRuntimeSystemPrompt,
  persistProviderSettings, loadProviderSettings, updateHeaderModel, buildMessages,
} from './identity.js';
import {
  SYSTEM_PROMPT, conversationHistory,
  newChatId, chatPath, chatIdFromPath, syncChatUrl, copyCurrentChatLink,
  showNewChatStartupMessages, createNewChat, normalizeChat, mergeChats,
  getSavedChats, saveCurrentChat, generateChatTitle, loadLatestChat,
  openChatFromUrl, renderStoredChat, openChatHistory,
} from './chats.js';
import {
  updateBubble, renderGeneratedImage, appendUserMsg, stopTTS, pcmToWav, handleTTS,
  appendMsgControls, renderVariantNavigator, handleRetry, startRecording, resetRecordingUI,
  stopRecording, appendStoredAgentMsg, appendAgentBubble, appendSystemMsg, appendWasmOomAlert,
  scrollBottom, scheduleStreamRender,
} from './messages.js';
import { sendMessage, bindSendUI } from './send.js';
import {
  hidePromptSuggest, applyPromptSuggestion, updatePromptSuggest, movePromptSuggest,
  promptSaveFromText, promptEditorDialog, renderPromptLibrary, bindPromptsUI,
} from './prompts-ui.js';
import {
  updateKeyStatuses, populateSettings, openSettings, switchSettingsPage,
  fetchProviderModels, loadModelOptions, renderModelSettings, importApiKeysFile, bindSettingsUI,
} from './settings-ui.js';
import { exportCurrentChat, searchChatHistory, bindChatControls } from './chat-controls.js';

'use strict';

/* ── DOM → ctx ──────────────────────────────────────────────── */
assignCtx({
  engineSelect: $('engine-select'),
  providerWrap: $('provider-select-wrap'),
  providerSelect: $('provider-select'),
  wasmUploadWrap: $('wasm-upload-wrap'),
  wasmFileInput: $('wasm-file-input'),
  wasmLoadBtn: $('wasm-load-btn'),
  btnSettings: $('btn-settings'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  wsDot: $('ws-dot'),
  wsLabel: $('ws-label'),
  btnAttach: $('btn-attach'),
  workspacePathEl: $('workspace-path'),
  exaToggle: $('exa-toggle'),
  btnNewChat: $('btn-new-chat'),
  btnChatHistory: $('btn-chat-history'),
  chatModal: $('chat-modal'),
  chatClose: $('chat-close'),
  chatList: $('chat-list'),
  chatThread: $('chat-thread'),
  chatUid: $('chat-uid'),
  copyChatLink: $('copy-chat-link'),
  userInput: $('user-input'),
  btnSend: $('btn-send'),
  btnStop: $('btn-stop'),
  btnMic: $('btn-mic'),
  btnAttachImg: $('btn-attach-img'),
  imageInput: $('image-input'),
  imagePreview: $('image-preview'),
  imagePreviewThumb: $('image-preview-thumb'),
  imagePreviewRemove: $('image-preview-remove'),
  btnRemoteAccess: $('btn-remote-access'),
  remoteModal: $('remote-modal'),
  remoteClose: $('remote-close'),
  remoteStart: $('remote-start'),
  remoteStop: $('remote-stop'),
  remoteUrl: $('remote-url'),
  remoteCode: $('remote-code'),
  remoteStatus: $('remote-status'),
  remoteGate: $('remote-gate'),
  remoteGateInput: $('remote-gate-input'),
  remoteGateConnect: $('remote-gate-connect'),
  remoteGateError: $('remote-gate-error'),
  settingsModal: $('settings-modal'),
  settingsClose: $('settings-close'),
  settingsSave: $('settings-save'),
  wasmProgressWrap: $('wasm-progress-wrap'),
  wasmProgressFill: $('wasm-progress-fill'),
  wasmProgressLabel: $('wasm-progress-label'),
  wasmProgressPct: $('wasm-progress-pct'),
  // helpers used by modules via ctx
  appendSystemMsg, appendAgentBubble, appendUserMsg, updateBubble, scrollBottom,
  scheduleStreamRender, setStatus, escHtml, formatMessage,
  renderRiskCard, dispatchTool, writeFile, readFile, guardedDelete,
  cloudInfer, wasmInfer, sendCommand, bridgeRequest,
  getModel, providerLabel, providerConfig,
  openRexDialog, addDialogButton, showTextEntryModal,
  idbGet, idbPut, idbAll, idbDelete,
  savePrompt, listPrompts, deletePrompt,
  computeDiff, renderDiffHtml, logEvent,
  conversationHistory, SYSTEM_PROMPT,
});

export function visionCapableProvider() {
  return state.provider === 'gemini' || state.provider === 'openrouter';
}

export function refreshAttachVisibility() {
  if (ctx.btnAttachImg) ctx.btnAttachImg.hidden = false;
}

export function setStatus(type, text) {
  if (ctx.statusDot) ctx.statusDot.className = 'status-dot ' + type;
  if (ctx.statusText) ctx.statusText.textContent = text;
}
// keep setStatus on ctx for modules loaded before this assignment
ctx.setStatus = setStatus;
ctx.refreshAttachVisibility = refreshAttachVisibility;
ctx.visionCapableProvider = visionCapableProvider;

// Bind the cross-module services after DOM context initialization. Modules must
// not assume these properties exist during ES-module evaluation.
Object.assign(ctx, {
  sendMessage, buildRuntimeSystemPrompt, modelIdentity, persistProviderSettings,
  updateHeaderModel, updateKeyStatuses, createNewChat, getSavedChats,
  saveCurrentChat, generateChatTitle, renderPromptLibrary,
  renderGeneratedImage, appendMsgControls, appendStoredAgentMsg,
  startRecording, stopRecording, clearAttachmentPreview,
  exaSearch,
});

configureProviders(state);
configureAttachments({
  state,
  appendSystemMsg,
  userInput: ctx.userInput,
  imagePreview: ctx.imagePreview,
  imagePreviewThumb: ctx.imagePreviewThumb,
  attachFileLabel: $('attach-file-label'),
  imagePreviewRemove: ctx.imagePreviewRemove,
  btnAttachImg: ctx.btnAttachImg,
  imageInput: ctx.imageInput,
  inputDock: $('input-dock'),
  visionCapableProvider,
});
configureRisk({ appendAgentBubble, scrollBottom, setStatus, escHtml });
configureInfer({});
bindAttachmentUI();
configureBridge({ state, wsDot: ctx.wsDot, wsLabel: ctx.wsLabel, appendSystemMsg, showRemoteGate });

/* ── Engine / WASM (kept local — small) ─────────────────────── */
ctx.engineSelect?.addEventListener('change', () => {
  state.engine = ctx.engineSelect.value;
  if (state.engine === 'wasm') {
    ctx.wasmUploadWrap?.classList.add('visible');
    if (ctx.providerWrap) ctx.providerWrap.style.display = 'none';
  } else {
    ctx.wasmUploadWrap?.classList.remove('visible');
    if (ctx.providerWrap) ctx.providerWrap.style.display = 'flex';
    setStatus('idle', 'Idle — Cloud mode');
  }
});

ctx.providerSelect?.addEventListener('change', async () => {
  state.provider = ctx.providerSelect.value;
  await persistProviderSettings();
  updateHeaderModel();
  setStatus('idle', `Idle — ${providerLabel(state.provider)} · ${getModel(state.provider)}`);
  refreshAttachVisibility();
});

ctx.exaToggle?.addEventListener('change', () => {
  state.exaEnabled = !!ctx.exaToggle.checked;
  idbPut('settings', 'exaEnabled', state.exaEnabled).catch(() => {});
});

export function readFileWithProgress(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = e => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        if (ctx.wasmProgressFill) ctx.wasmProgressFill.style.width = pct + '%';
        if (ctx.wasmProgressPct) ctx.wasmProgressPct.textContent = pct + '%';
      }
    };
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

ctx.wasmFileInput?.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) {
    const el = $('wasm-filename');
    if (el) el.textContent = file.name;
  }
});

ctx.wasmLoadBtn?.addEventListener('click', async () => {
  const file = ctx.wasmFileInput?.files?.[0];
  if (!file) { alert('Select a .gguf model file first.'); return; }
  const MAX_WASM_BYTES = 2.2 * 1024 * 1024 * 1024;
  if (file.size > MAX_WASM_BYTES) {
    setStatus('error', 'Error: WASM Memory Boundary Exceeded');
    appendWasmOomAlert(file.size);
    if (ctx.engineSelect) ctx.engineSelect.value = 'cloud';
    state.engine = 'cloud';
    if (ctx.providerWrap) ctx.providerWrap.style.display = 'flex';
    ctx.wasmUploadWrap?.classList.remove('visible');
    return;
  }
  setStatus('loading', `Loading WASM: ${file.name}`);
  if (ctx.wasmProgressWrap) ctx.wasmProgressWrap.style.display = 'block';
  if (ctx.wasmProgressFill) ctx.wasmProgressFill.style.width = '0%';
  try {
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
    const { Wllama } = window;
    state.wasmEngine = new Wllama({
      'single-thread/wllama.wasm': 'https://cdn.jsdelivr.net/npm/@wllama/wllama/dist/single-thread/wllama.wasm',
      'multi-thread/wllama.wasm': 'https://cdn.jsdelivr.net/npm/@wllama/wllama/dist/multi-thread/wllama.wasm',
    });
    await state.wasmEngine.loadModel([new Uint8Array(arrayBuffer)]);
    state.wasmLoaded = true;
    setStatus('idle', `WASM ready — ${file.name}`);
    appendSystemMsg(`Loaded local model: ${file.name}`);
    if (ctx.wasmProgressWrap) ctx.wasmProgressWrap.style.display = 'none';
  } catch (err) {
    setStatus('error', `WASM Error: ${err.message}`);
    appendSystemMsg(`Failed to load model: ${err.message}`);
    if (ctx.wasmProgressWrap) ctx.wasmProgressWrap.style.display = 'none';
  }
});

/* ── Bind domain UI listeners (ctx is ready) ────────────────── */
bindSendUI();
bindWorkspaceUI();
bindPromptsUI();
bindSettingsUI();
bindChatControls();

/* Re-export surface used by main.js */
export {
  loadKeys, ensureCryptoReady, loadProviderSettings, persistProviderSettings,
  updateHeaderModel, updateKeyStatuses,
  sendMessage, createNewChat, openWorkspacePicker, openSettings, openChatHistory,
  exportCurrentChat, searchChatHistory, startRemoteAccess, stopRemoteAccess,
  showRemoteGate, hideRemoteGate, copyCurrentChatLink, openChatFromUrl,
  loadLatestChat, switchSettingsPage, updatePromptSuggest, startRecording, stopRecording,
  appendSystemMsg, appendAgentBubble, scrollBottom,
};
