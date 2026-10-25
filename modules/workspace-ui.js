import { state } from './state.js';
import { ctx, $ } from './ctx.js';
import { bridgeRequest } from './ws.js';
import { openRexDialog, addDialogButton } from './ui.js';

/* ── Workspace access ───────────────────────────────────────── */
export function hasNativeDirectoryPicker() {
  return typeof window.showDirectoryPicker === 'function' && window.isSecureContext;
}

export function showRemoteGate(error = '') {
  if (!ctx.remoteGate) return;
  if (ctx.remoteGateError) ctx.remoteGateError.textContent = error;
  ctx.remoteGate.classList.add('open');
  setTimeout(() => ctx.remoteGateInput?.focus(), 50);
}

export function hideRemoteGate() {
  ctx.remoteGate?.classList.remove('open');
  if (ctx.remoteGateError) ctx.remoteGateError.textContent = '';
}

export function setRemoteAccessInfo(result) {
  if (!result?.url) return;
  if (ctx.remoteUrl) { ctx.remoteUrl.value = result.shareUrl || result.url; ctx.remoteUrl.dataset.href = result.shareUrl || result.url; }
  if (ctx.remoteCode) ctx.remoteCode.value = result.accessCode || '';
  if (ctx.remoteStatus) ctx.remoteStatus.textContent = 'Remote access is active.';
  ctx.remoteStart?.setAttribute('hidden', '');
  ctx.remoteStop?.removeAttribute('hidden');
}

export async function startRemoteAccess() {
  if (!state.wsConnected) {
    ctx.remoteStatus.textContent = 'Start Rex locally first; the bridge must be connected.';
    return;
  }
  ctx.remoteStart.disabled = true;
  ctx.remoteStatus.textContent = 'Starting Cloudflare Quick Tunnel…';
  try {
    const result = await ctx.bridgeRequest({ action: 'remote_access_start' });
    if (!result?.ok) throw new Error(result?.error || 'Could not start remote access.');
    setRemoteAccessInfo(result);
  } catch (err) {
    ctx.remoteStatus.textContent = err.message;
  } finally {
    ctx.remoteStart.disabled = false;
  }
}

export async function stopRemoteAccess() {
  if (!state.wsConnected) return;
  ctx.remoteStop.disabled = true;
  try {
    await ctx.bridgeRequest({ action: 'remote_access_stop' });
    ctx.remoteUrl.value = '';
    ctx.remoteCode.value = '';
    ctx.remoteStatus.textContent = 'Remote access stopped.';
    ctx.remoteStart.removeAttribute('hidden');
    ctx.remoteStop.setAttribute('hidden', '');
  } catch (err) {
    ctx.remoteStatus.textContent = err.message;
  } finally {
    ctx.remoteStop.disabled = false;
  }
}

if (ctx.btnRemoteAccess) ctx.btnRemoteAccess.addEventListener('click', async () => {
  ctx.remoteModal?.classList.add('open');
  if (!state.remoteMode && state.wsConnected) {
    try {
      const result = await ctx.bridgeRequest({ action: 'remote_access_status' });
      if (result?.running) setRemoteAccessInfo(result);
    } catch (_) {}
  }
});

export function ensureWorkspacePicker() {
  if (ctx.workspacePickerEl) return ctx.workspacePickerEl;
  ctx.workspacePickerEl = document.createElement('div');
  ctx.workspacePickerEl.className = 'modal-backdrop workspace-picker-backdrop';
  ctx.workspacePickerEl.id = 'workspace-picker';
  ctx.workspacePickerEl.innerHTML = `
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
  document.body.appendChild(ctx.workspacePickerEl);
  const close = () => ctx.workspacePickerEl.classList.remove('open');
  $('workspace-picker-close').addEventListener('click', close);
  $('workspace-picker-cancel').addEventListener('click', close);
  ctx.workspacePickerEl.addEventListener('click', e => { if (e.target === ctx.workspacePickerEl) close(); });
  $('workspace-picker-up').addEventListener('click', async () => {
    const up = $('workspace-picker-up').dataset.parent || '';
    if (!up && ctx.workspacePickerPath) ctx.workspacePickerPath = '';
    else if (up) ctx.workspacePickerPath = up;
    await renderWorkspacePicker();
  });
  $('workspace-picker-new-folder').addEventListener('click', async () => {
    if (!ctx.workspacePickerPath) {
      $('workspace-picker-status').textContent = 'Open a drive or folder first.';
      return;
    }
    const name = await ctx.showTextEntryModal('Create folder', 'Choose a name for the new folder.', 'Folder name', 'Create');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      $('workspace-picker-status').textContent = 'Folder name cannot be empty.';
      return;
    }
    const button = $('workspace-picker-new-folder');
    button.disabled = true;
    try {
      const result = await ctx.bridgeRequest({ action: 'workspace_mkdir', path: ctx.workspacePickerPath, name: trimmed });
      if (!result?.ok) throw new Error(result?.error || 'Could not create folder.');
      $('workspace-picker-status').textContent = `Created: ${result.name}`;
      await renderWorkspacePicker(ctx.workspacePickerPath);
    } catch (err) {
      $('workspace-picker-status').textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
  $('workspace-picker-select').addEventListener('click', async () => {
    if (!ctx.workspacePickerPath) {
      $('workspace-picker-status').textContent = 'Select a drive or folder first.';
      return;
    }
    const selectBtn = $('workspace-picker-select');
    selectBtn.disabled = true;
    $('workspace-picker-status').textContent = 'Attaching…';
    try {
      const result = await ctx.bridgeRequest({ action: 'workspace_select', path: ctx.workspacePickerPath });
      if (!result?.ok) throw new Error(result?.error || 'Could not select workspace.');
      state.workspaceHandle = null;
      state.bridgeWorkspace = true;
      state.workspaceRootName = result.workspaceName;
      await updateWorkspaceUI(result.workspaceName, 'Rex workspace picker');
      ctx.appendSystemMsg(`Workspace attached: ${result.workspaceName}`);
      ctx.setStatus('idle', `Workspace: ${result.workspaceName}`);
      close();
    } catch (err) {
      $('workspace-picker-status').textContent = err.message || 'Could not select workspace.';
    } finally {
      selectBtn.disabled = false;
    }
  });
  return ctx.workspacePickerEl;
}
export async function renderWorkspacePicker(path = ctx.workspacePickerPath) {
  ensureWorkspacePicker();
  ctx.workspacePickerPath = path || '';
  const list = $('workspace-picker-list');
  const crumb = $('workspace-picker-breadcrumb');
  const up = $('workspace-picker-up');
  const status = $('workspace-picker-status');
  list.innerHTML = '<div class="workspace-picker-loading">Loading…</div>';
  status.textContent = 'Choose a folder.';
  try {
    const result = await ctx.bridgeRequest({ action: 'workspace_browse', path: ctx.workspacePickerPath });
    if (!result?.ok) throw new Error(result?.error || 'Could not read this folder.');
    ctx.workspacePickerPath = result.path || '';
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
        row.innerHTML = `<span class="workspace-entry-icon">${entry.type === 'drive' ? '💽' : '📁'}</span><span class="workspace-entry-name">${ctx.escHtml(entry.name)}</span>`;
        row.addEventListener('dblclick', () => renderWorkspacePicker(entry.path));
        row.addEventListener('click', () => {
          document.querySelectorAll('.workspace-picker-entry.selected').forEach(el => el.classList.remove('selected'));
          row.classList.add('selected');
          // Single-click must set the path used by "Select this folder".
          ctx.workspacePickerPath = entry.path;
          status.textContent = entry.path;
        });
        row.addEventListener('contextmenu', e => { e.preventDefault(); renderWorkspacePicker(entry.path); });
        list.appendChild(row);
      }
    }
  } catch (err) {
    list.innerHTML = `<div class="workspace-picker-empty">${ctx.escHtml(err.message)}</div>`;
    status.textContent = 'Unable to open this folder.';
  }
}
export async function openWorkspacePicker() {
  ensureWorkspacePicker();
  ctx.workspacePickerPath = '';
  ctx.workspacePickerEl.classList.add('open');
  await renderWorkspacePicker('');
}
export async function updateWorkspaceUI(name, mode) {
  ctx.btnAttach.classList.add('active');
  ctx.workspacePathEl.innerHTML = `<span class="path-label">workspace:</span><span class="path-val">${ctx.escHtml(name)}</span>`;
  ctx.workspacePathEl.title = `${name} — ${mode}`;
  ctx.setStatus('idle', `Workspace: ${name}`);
}
export function guardedDelete(handle, name, parentHandle) {
  if (name === state.workspaceRootName) {
    throw new Error(`BLOCKED: Cannot delete workspace root "${name}". Only subdirectory deletion is permitted.`);
  }
  return parentHandle.removeEntry(name, { recursive: true });
}
export async function writeFile(relativePath, content) {
  if (state.bridgeWorkspace) {
    const result = await ctx.bridgeRequest({ action: 'write_file', path: relativePath, content });
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
export async function readFile(relativePath) {
  if (state.bridgeWorkspace) {
    const result = await ctx.bridgeRequest({ action: 'read_file', path: relativePath });
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

export function bindWorkspaceUI() {
ctx.remoteClose?.addEventListener('click', () => ctx.remoteModal?.classList.remove('open'));
ctx.remoteModal?.addEventListener('click', e => { if (e.target === ctx.remoteModal) ctx.remoteModal.classList.remove('open'); });
ctx.remoteStart?.addEventListener('click', startRemoteAccess);
ctx.remoteStop?.addEventListener('click', stopRemoteAccess);
ctx.remoteUrl?.addEventListener('click', () => { if (ctx.remoteUrl.value) window.open(ctx.remoteUrl.value, '_blank', 'noopener'); });
ctx.remoteGateConnect?.addEventListener('click', async () => {
  const code = ctx.remoteGateInput?.value.trim();
  if (!code) { showRemoteGate('Enter the access code shown on the computer running Rex.'); return; }
  state.remoteAccessCode = code;
  sessionStorage.setItem('rexRemoteAccessCode', code);
  ctx.remoteGateConnect.disabled = true;
  try {
    const result = await ctx.bridgeRequest({ action: 'ping' });
    if (!result?.ok) throw new Error(result?.error || 'Connection failed.');
    hideRemoteGate();
    state.remoteGateReady?.();
    state.remoteGateReady = null;
    await loadKeys();
  } catch (err) {
    state.remoteAccessCode = '';
    sessionStorage.removeItem('rexRemoteAccessCode');
    showRemoteGate(err.message);
  } finally { ctx.remoteGateConnect.disabled = false; }
});
ctx.remoteGateInput?.addEventListener('keydown', e => { if (e.key === 'Enter') ctx.remoteGateConnect.click(); });

let workspacePickerEl = null;
let workspacePickerPath = '';




ctx.btnAttach.addEventListener('click', async () => {
  try {
    if (state.remoteMode) {
      await openWorkspacePicker();
      return;
    }
    if (!state.wsConnected && hasNativeDirectoryPicker()) {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      state.workspaceHandle = handle;
      state.bridgeWorkspace = false;
      state.workspaceRootName = handle.name;
      await updateWorkspaceUI(handle.name, 'Browser folder access');
      ctx.appendSystemMsg(`Workspace attached: ${handle.name}. Files are accessed through browser folder permission.`);
      return;
    }
    await openWorkspacePicker();
  } catch (err) {
    if (err.name !== 'AbortError') {
      ctx.setStatus('error', 'Workspace unavailable');
      ctx.appendSystemMsg(`Workspace error: ${err.message}`);
    }
  }
});


/* Root deletion guard */


}
