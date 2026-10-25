import { logEvent } from './debug.js';
/* WebSocket and remote bridge transport. UI callbacks are injected by main.js. */
let runtime = {};
export function configureBridge(options) { runtime = options; }

export function isLocalOrigin() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]';
}

export function connectWS() {
  const { state, wsDot, wsLabel, appendSystemMsg } = runtime;
  if (!state || state.remoteMode) return;
  if (state.wsocket && state.wsocket.readyState < 2) return;
  try {
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = isLocalOrigin() ? '127.0.0.1:8765' : `${location.host}/bridge`;
    const ws = new WebSocket(`${wsProtocol}//${wsHost}`);
    state.wsocket = ws;
    wsDot.className = 'ws-dot connecting';
    wsLabel.textContent = 'Bridge: connecting…';
    ws.onopen = () => {
      if (state.wsocket !== ws) return;
      state.wsConnected = true;
      if (state.backendStatusTimer) {
        clearTimeout(state.backendStatusTimer);
        state.backendStatusTimer = null;
      }
      wsDot.className = 'ws-dot connected';
      wsLabel.textContent = 'Bridge: connected';
      if (state.isNewChat && state.chatId && state.bridgeConnectedNoticeChatId !== state.chatId) {
        appendSystemMsg('Terminal bridge connected.');
        state.bridgeConnectedNoticeChatId = state.chatId;
      }
    };
    ws.onclose = () => {
      if (state.wsocket !== ws) return;
      state.wsConnected = false;
      wsDot.className = 'ws-dot disconnected';
      wsLabel.textContent = 'Bridge: offline';
      setTimeout(connectWS, 5000);
    };
    ws.onerror = () => {
      if (state.wsocket !== ws) return;
      state.wsConnected = false;
      wsDot.className = 'ws-dot disconnected';
      wsLabel.textContent = 'Bridge: offline';
    };
    ws.onmessage = e => {
      try { logEvent('ws_recv', e.data); } catch (_) {}
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
  } catch (err) {
    state.wsConnected = false;
    wsDot.className = 'ws-dot disconnected';
    wsLabel.textContent = 'Bridge: offline';
    console.warn('Bridge connection failed:', err);
  }
}

export function sendCommand(command, rawPayload = false) {
  try { logEvent('ws_send', { command, rawPayload }); } catch (_) {}
  const { state } = runtime;
  return new Promise((resolve, reject) => {
    if (!state?.wsConnected || !state.wsocket) {
      reject(new Error('BackEnd not connected'));
      return;
    }
    const id = Date.now().toString();
    state.pendingCommands[id] = { resolve, reject };
    const payload = rawPayload ? { ...command, requestId: id } : { action: 'terminal', command, requestId: id };
    state.wsocket.send(JSON.stringify(payload));
  });
}

export async function bridgeRequest(payload) {
  try { logEvent('ws_send', payload); } catch (_) {}
  const { state, showRemoteGate } = runtime;
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
    throw new Error('BackEnd not connected');
  }
  return sendCommand(payload, true);
}
