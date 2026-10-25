import { state } from './state.js';
import { ctx, $ } from './ctx.js';
import { savePrompt, listPrompts, deletePrompt } from './prompts.js';
import { showTextEntryModal, openRexDialog, addDialogButton } from './ui.js';
import { escHtml } from './markdown.js';

/* ── Prompt library: / autocomplete + save helpers ──────────── */
const promptSuggestEl = $('prompt-suggest');
let promptSuggestItems = [];
let promptSuggestIndex = -1;
let promptSuggestQuery = null;

export function hidePromptSuggest() {
  if (!promptSuggestEl) return;
  promptSuggestEl.hidden = true;
  promptSuggestEl.innerHTML = '';
  promptSuggestItems = [];
  promptSuggestIndex = -1;
  promptSuggestQuery = null;
}

export function applyPromptSuggestion(prompt) {
  if (!prompt || !ctx.userInput) return;
  const value = ctx.userInput.value;
  if (promptSuggestQuery) {
    const before = value.slice(0, promptSuggestQuery.start);
    const after = value.slice(promptSuggestQuery.end);
    ctx.userInput.value = before + prompt.text + (after.startsWith(' ') || !after ? after : ' ' + after);
  } else {
    ctx.userInput.value = prompt.text;
  }
  hidePromptSuggest();
  ctx.userInput.focus();
  const pos = ctx.userInput.value.length;
  ctx.userInput.setSelectionRange(pos, pos);
}

export async function updatePromptSuggest() {
  if (!promptSuggestEl || !ctx.userInput) return;
  const value = ctx.userInput.value;
  const cursor = ctx.userInput.selectionStart ?? value.length;
  const match = value.match(/^\/([^\n]*)$/);
  if (!match || cursor < 1) {
    hidePromptSuggest();
    return;
  }
  const filter = (match[1] || '').toLowerCase();
  promptSuggestQuery = { start: 0, end: value.length, filter };
  let prompts = [];
  try { prompts = await ctx.listPrompts(); } catch (_) { prompts = []; }
  const filtered = filter
    ? prompts.filter(p =>
        (p.title || '').toLowerCase().includes(filter) ||
        (p.text || '').toLowerCase().includes(filter))
    : prompts;
  promptSuggestItems = filtered.slice(0, 12);
  promptSuggestIndex = promptSuggestItems.length ? 0 : -1;
  if (!promptSuggestItems.length) {
    promptSuggestEl.innerHTML = filter
      ? `<div class="prompt-suggest-empty">No prompts match “${ctx.escHtml(filter)}”.</div>`
      : `<div class="prompt-suggest-empty">No saved prompts. Save one from a message or Settings → Prompts.</div>`;
    promptSuggestEl.hidden = false;
    return;
  }
  promptSuggestEl.innerHTML = '';
  promptSuggestItems.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'prompt-suggest-item' + (i === promptSuggestIndex ? ' active' : '');
    btn.setAttribute('role', 'option');
    btn.innerHTML = `<span class="prompt-suggest-title">${ctx.escHtml(p.title || 'Untitled')}</span>`
      + `<span class="prompt-suggest-preview">${ctx.escHtml((p.text || '').replace(/\s+/g, ' ').slice(0, 100))}</span>`;
    btn.addEventListener('mousedown', e => { e.preventDefault(); applyPromptSuggestion(p); });
    promptSuggestEl.appendChild(btn);
  });
  promptSuggestEl.hidden = false;
}

export function movePromptSuggest(delta) {
  if (!promptSuggestItems.length) return;
  promptSuggestIndex = (promptSuggestIndex + delta + promptSuggestItems.length) % promptSuggestItems.length;
  [...promptSuggestEl.querySelectorAll('.prompt-suggest-item')].forEach((el, i) => {
    el.classList.toggle('active', i === promptSuggestIndex);
  });
}

export async function promptSaveFromText(text) {
  const body = String(text || '').trim();
  if (!body) return;
  const defaultTitle = body.split(/\n/)[0].slice(0, 60);
  const title = await ctx.showTextEntryModal('Save as prompt', 'Give this prompt a short name.', 'Title', 'Save', defaultTitle);
  if (title === null) return;
  try {
    await ctx.savePrompt(title.trim() || defaultTitle, body);
    ctx.appendSystemMsg(`Prompt saved: ${title.trim() || defaultTitle}`);
  } catch (err) {
    ctx.appendSystemMsg(`Could not save prompt: ${err.message}`);
  }
}

export async function promptEditorDialog(existing = null) {
  const dialog = ctx.openRexDialog(existing ? 'Edit prompt' : 'New prompt', existing ? 'Update title and text.' : 'Create a reusable prompt snippet.');
  const titleInput = document.createElement('input');
  titleInput.className = 'field-input rex-dialog-input';
  titleInput.placeholder = 'Title';
  titleInput.value = existing?.title || '';
  const textInput = document.createElement('textarea');
  textInput.className = 'field-input rex-dialog-input memory-editor';
  textInput.rows = 8;
  textInput.placeholder = 'Prompt text…';
  textInput.value = existing?.text || '';
  textInput.style.marginTop = '0.5rem';
  dialog.body.append(titleInput, textInput);
  ctx.addDialogButton(dialog, 'Cancel', null);
  ctx.addDialogButton(dialog, existing ? 'Save' : 'Create', 'ok', true);
  setTimeout(() => titleInput.focus(), 0);
  const choice = await dialog.promise;
  if (choice !== 'ok') return null;
  return { title: titleInput.value, text: textInput.value };
}

export async function renderPromptLibrary() {
  const list = $('prompt-library-list');
  if (!list) return;
  let prompts = [];
  try { prompts = await ctx.listPrompts(); } catch (_) { prompts = []; }
  list.innerHTML = '';
  if (!prompts.length) {
    list.innerHTML = '<div class="prompt-library-empty">No saved prompts yet. Create one or save a user message with “Save prompt”.</div>';
    return;
  }
  for (const p of prompts) {
    const card = document.createElement('div');
    card.className = 'prompt-library-card';
    card.innerHTML = `
      <div class="prompt-library-card-header">
        <div class="prompt-library-card-title">${ctx.escHtml(p.title || 'Untitled')}</div>
        <div class="prompt-library-card-actions">
          <button type="button" data-act="use">Use</button>
          <button type="button" data-act="edit">Edit</button>
          <button type="button" data-act="delete" class="prompt-delete">Delete</button>
        </div>
      </div>
      <div class="prompt-library-card-text">${ctx.escHtml(p.text || '')}</div>`;
    card.querySelector('[data-act="use"]').addEventListener('click', () => {
      ctx.userInput.value = p.text || '';
      ctx.settingsModal.classList.remove('open');
      ctx.userInput.focus();
    });
    card.querySelector('[data-act="edit"]').addEventListener('click', async () => {
      const edited = await promptEditorDialog(p);
      if (!edited) return;
      try {
        await ctx.savePrompt(edited.title, edited.text, p.id);
        await renderPromptLibrary();
      } catch (err) {
        ctx.appendSystemMsg(`Could not update prompt: ${err.message}`);
      }
    });
    card.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      await ctx.deletePrompt(p.id);
      await renderPromptLibrary();
    });
    list.appendChild(card);
  }
}

$('prompt-add-btn')?.addEventListener('click', async () => {
  const created = await promptEditorDialog(null);
  if (!created) return;
  try {
    await ctx.savePrompt(created.title, created.text);
    await renderPromptLibrary();
  } catch (err) {
    ctx.appendSystemMsg(`Could not create prompt: ${err.message}`);
  }
});


export function bindPromptsUI() {
ctx.userInput.addEventListener('input', () => { updatePromptSuggest().catch(() => {}); });
ctx.userInput.addEventListener('blur', () => { setTimeout(hidePromptSuggest, 150); });

ctx.userInput.addEventListener('keydown', e => {
  if (promptSuggestEl && !promptSuggestEl.hidden && promptSuggestItems.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePromptSuggest(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); movePromptSuggest(-1); return; }
    if (e.key === 'Enter' && !e.shiftKey && promptSuggestIndex >= 0) {
      e.preventDefault();
      applyPromptSuggestion(promptSuggestItems[promptSuggestIndex]);
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); hidePromptSuggest(); return; }
    if (e.key === 'Tab' && promptSuggestIndex >= 0) {
      e.preventDefault();
      applyPromptSuggestion(promptSuggestItems[promptSuggestIndex]);
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ctx.sendMessage?.(); }
});

ctx.btnStop.addEventListener('click', () => {
  if (state.abortController) state.abortController.abort();
  if (state.wasmEngine?.exitCompletion) state.wasmEngine.exitCompletion();
});

if (ctx.btnMic) ctx.btnMic.addEventListener('click', () => {
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') ctx.stopRecording();
  else ctx.startRecording();
});

}
