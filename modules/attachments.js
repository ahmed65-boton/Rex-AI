/* File attachment helpers (images + workspace uploads). */
import { state } from './state.js';
import { bridgeRequest } from './ws.js';

let runtime = {};
export function configureAttachments(options) { runtime = options; }

const BLOCKED_BINARY_EXTENSIONS = /\.(exe|com|scr|msi|msp|cpl|bat|cmd|ps1|vbs|vbe|jse|wsf|wsh)$/i;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|log|json|jsonl|xml|yml|yaml|toml|ini|cfg|conf|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|sh|bash|zsh|sql|r|swift|kt|dart|vue|svelte|gitignore|env|dockerfile)$/i;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 20000;
const MAX_BINARY_BYTES = 32 * 1024 * 1024;

export function fileToBase64(file) {
  return file.arrayBuffer().then(buf => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
    return btoa(bin);
  });
}

export function clearAttachmentPreview() {
  state.pendingImage = null;
  if (runtime.imagePreview) runtime.imagePreview.hidden = true;
  if (runtime.imagePreviewThumb) {
    runtime.imagePreviewThumb.src = '';
    runtime.imagePreviewThumb.hidden = false;
  }
  if (runtime.attachFileLabel) {
    runtime.attachFileLabel.hidden = true;
    runtime.attachFileLabel.textContent = '';
  }
}

export function showImagePreview(dataUrl) {
  if (runtime.imagePreviewThumb) {
    runtime.imagePreviewThumb.hidden = false;
    runtime.imagePreviewThumb.src = dataUrl;
  }
  if (runtime.attachFileLabel) runtime.attachFileLabel.hidden = true;
  if (runtime.imagePreview) runtime.imagePreview.hidden = false;
}

export function showFileChip(name) {
  if (runtime.imagePreviewThumb) {
    runtime.imagePreviewThumb.hidden = true;
    runtime.imagePreviewThumb.src = '';
  }
  if (runtime.attachFileLabel) {
    runtime.attachFileLabel.hidden = false;
    runtime.attachFileLabel.textContent = `📎 ${name}`;
  }
  if (runtime.imagePreview) runtime.imagePreview.hidden = false;
}

export async function handleAttachedFile(file) {
  if (!file) return;
  const name = file.name || 'file';
  const lower = name.toLowerCase();

  // Block Windows executables / installers (user request: no .exe; a few related types too)
  if (BLOCKED_BINARY_EXTENSIONS.test(lower) || lower.endsWith('.exe')) {
    runtime.appendSystemMsg(`Blocked: “${name}” cannot be attached (executable / script).`);
    return;
  }

  // Images → vision payload when provider supports it; otherwise upload to workspace
  if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) {
    if (file.size > MAX_IMAGE_BYTES) {
      runtime.appendSystemMsg(`Image “${name}” is too large (max 8 MB).`);
      return;
    }
    if (runtime.visionCapableProvider()) {
      const base64 = await fileToBase64(file);
      const mime = file.type || 'image/png';
      state.pendingImage = { base64, mimeType: mime };
      showImagePreview(`data:${mime};base64,${base64}`);
      return;
    }
    // Non-vision provider: fall through and save into the workspace
  }

  // All other allowed files (html, zip, code, pdf, …) → save into the workspace.
  // Do NOT dump file contents into the chat input as ``` code fences.
  if (file.size > MAX_BINARY_BYTES) {
    runtime.appendSystemMsg(`“${name}” is too large (max 32 MB).`);
    return;
  }

  const bridgeReady = state.bridgeWorkspace || state.wsConnected;
  if (!bridgeReady) {
    // Offline fallback: only small text can be inlined so the user is not stuck.
    const isText = file.type.startsWith('text/') || TEXT_EXTENSIONS.test(name) || file.type === 'application/json';
    if (isText && file.size <= MAX_TEXT_CHARS) {
      try {
        const text = await file.text();
        const ext = (name.split('.').pop() || '').replace(/[^a-z0-9]/gi, '') || 'txt';
        const quoted = '```' + ext + '\n' + text.slice(0, MAX_TEXT_CHARS) + (text.length > MAX_TEXT_CHARS ? '\n…[truncated]' : '') + '\n```';
        runtime.userInput.value = (runtime.userInput.value + (runtime.userInput.value ? '\n\n' : '') + quoted);
        showFileChip(name);
        runtime.appendSystemMsg(`Bridge offline — inlined “${name}” into the message. Start the server to save files into the workspace.`);
        return;
      } catch (err) {
        runtime.appendSystemMsg(`Could not read “${name}”: ${err.message}`);
        return;
      }
    }
    runtime.appendSystemMsg(`Cannot attach “${name}” without the terminal/workspace bridge. Start the server, attach a workspace, and try again.`);
    return;
  }

  try {
    const base64 = await fileToBase64(file);
    const safeName = name.replace(/[\\/]/g, '_');
    const result = await bridgeRequest({ action: 'write_file_b64', path: safeName, content: base64 });
    if (result?.ok) {
      const tag = `[attached: ${safeName}]`;
      if (!runtime.userInput.value.includes(tag)) {
        runtime.userInput.value += (runtime.userInput.value ? '\n' : '') + tag;
      }
      showFileChip(safeName);
      runtime.appendSystemMsg(`Saved “${safeName}” into the workspace.`);
    } else {
      runtime.appendSystemMsg(`Could not upload “${name}”: ${result?.error || 'unknown error'}`);
    }
  } catch (err) {
    runtime.appendSystemMsg(`Upload failed for “${name}”: ${err.message}`);
  }
}

export function bindAttachmentUI() {
  const btnAttachImg = runtime.btnAttachImg;
  const imageInput = runtime.imageInput;
  const imagePreviewRemove = runtime.imagePreviewRemove;
  const inputDock = runtime.inputDock;

  if (btnAttachImg) btnAttachImg.addEventListener('click', () => imageInput?.click());

  imageInput?.addEventListener('change', async () => {
    const files = [...(imageInput.files || [])];
    imageInput.value = '';
    for (const file of files) await handleAttachedFile(file);
    runtime.userInput?.focus();
  });

  imagePreviewRemove?.addEventListener('click', () => {
    clearAttachmentPreview();
  });

  let dragDepth = 0;
  inputDock?.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    inputDock.classList.add('drag-over');
  });
  inputDock?.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  inputDock?.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; inputDock.classList.remove('drag-over'); }
  });
  inputDock?.addEventListener('drop', async e => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    dragDepth = 0; inputDock.classList.remove('drag-over');
    for (const file of files) await handleAttachedFile(file);
    runtime.userInput?.focus();
  });
}


