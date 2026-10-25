import { state } from './state.js';
import { ctx, $ } from './ctx.js';
import { findChatMatches, formatChatExport, chatExportFilename } from './chat-utils.js';
import { getModel } from './providers.js';
import { openRexDialog, addDialogButton } from './ui.js';
import { escHtml } from './markdown.js';
import {
  getSavedChats, copyCurrentChatLink, openChatHistory, openChatFromUrl,
  syncChatUrl, conversationHistory, SYSTEM_PROMPT, renderStoredChat,
  showNewChatStartupMessages, setConversationHistory, promptRenameChat,
} from './chats.js';
import { clearSessionKey, initCryptoKey } from './crypto.js';
import { promptPassphrase, saveKeys } from './keys.js';

/* ── Chat controls ─────────────────────────────────────────── */

export async function exportCurrentChat() {
  await ctx.saveCurrentChat();
  const chat = (await ctx.getSavedChats()).find(item => item.id === state.chatId);
  if (!chat) return ctx.appendSystemMsg('There is no current chat to export yet.');
  const dialog = ctx.openRexDialog('Export conversation', 'Choose a format to save this chat.');
  const choices = document.createElement('div');
  choices.className = 'rex-export-choices';
  const addChoice = (label, detail, value, icon) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rex-search-result';
    const title = document.createElement('span');
    title.className = 'rex-search-result-title';
    title.textContent = `${icon}  ${label}`;
    const sub = document.createElement('span');
    sub.className = 'rex-search-result-snippet';
    sub.textContent = detail;
    button.append(title, sub);
    button.addEventListener('click', () => dialog.close(value));
    choices.appendChild(button);
  };
  addChoice('Markdown (.md)', 'Readable document with chat messages and metadata.', 'md', '📝');
  addChoice('JSON (.json)', 'Structured raw conversation data for tools and backups.', 'json', '{ }');
  dialog.body.appendChild(choices);
  ctx.addDialogButton(dialog, 'Cancel', null);
  const choice = await dialog.promise;
  if (!choice) return;
  const isJson = choice === 'json';
  const content = formatChatExport(chat, isJson ? 'json' : 'md', state.modelSelections[state.provider] || state.provider);
  const blob = new Blob([content], { type: isJson ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = chatExportFilename(chat.title, isJson ? 'json' : 'md');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function searchChatHistory() {
  const dialog = ctx.openRexDialog('Search conversations', 'Browse every saved chat or type to filter by title and message content.');
  const input = document.createElement('input');
  input.className = 'field-input rex-dialog-input';
  input.type = 'search';
  input.placeholder = 'Find a chat…';
  input.setAttribute('aria-label', 'Search saved chats');
  const resultsEl = document.createElement('div');
  resultsEl.className = 'rex-search-results';
  dialog.body.append(input, resultsEl);
  ctx.addDialogButton(dialog, 'Close', null);

  let chatsCache = [];
  let searchVersion = 0;
  const renderResults = query => {
    const normalized = query.trim().toLowerCase();
    const matches = chatsCache.filter(chat => {
      if (!normalized) return true;
      const title = String(chat.title || 'New chat').toLowerCase();
      const content = (chat.messages || []).map(message => String(message.content || '')).join('\n').toLowerCase();
      return title.includes(normalized) || content.includes(normalized);
    }).slice(0, 100);

    resultsEl.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'rex-search-empty';
      empty.textContent = normalized ? 'No conversations matched that search.' : 'No saved chats yet.';
      resultsEl.appendChild(empty);
      return;
    }

    for (const chat of matches) {
      const result = document.createElement('div');
      result.className = 'rex-search-result-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rex-search-result';
      const title = document.createElement('span');
      title.className = 'rex-search-result-title';
      title.textContent = chat.title || 'New chat';
      const meta = document.createElement('span');
      meta.className = 'rex-search-result-meta';
      const count = (chat.messages || []).length;
      meta.textContent = `${count} message${count === 1 ? '' : 's'} · ${new Date(chat.updatedAt || Date.now()).toLocaleString()}`;
      const snippet = document.createElement('span');
      snippet.className = 'rex-search-result-snippet';
      const firstUser = (chat.messages || []).find(message => message.role === 'user' && message.content);
      snippet.textContent = String(firstUser?.content || 'Empty conversation').replace(/\s+/g, ' ').slice(0, 180);
      button.append(title, meta, snippet);
      button.addEventListener('click', () => dialog.close(chat));
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'chat-rename';
      rename.title = 'Rename chat';
      rename.setAttribute('aria-label', `Rename ${chat.title || 'New chat'}`);
      rename.textContent = '✎';
      rename.addEventListener('click', async event => {
        event.stopPropagation();
        if (await promptRenameChat(chat)) {
          chatsCache = await ctx.getSavedChats();
          renderResults(input.value);
        }
      });
      result.append(button, rename);
      resultsEl.appendChild(result);
    }
  };

  try {
    chatsCache = await ctx.getSavedChats();
    renderResults('');
  } catch (err) {
    const empty = document.createElement('div');
    empty.className = 'rex-search-empty';
    empty.textContent = `Could not load conversations: ${err.message}`;
    resultsEl.replaceChildren(empty);
  }

  input.addEventListener('input', () => {
    const version = ++searchVersion;
    // Ignore stale scheduled renders if input events arrive rapidly.
    queueMicrotask(() => { if (version === searchVersion) renderResults(input.value); });
  });
  requestAnimationFrame(() => input.focus());
  const chat = await dialog.promise;
  if (chat) {
    state.chatId = chat.id;
    state.isNewChat = !(chat.messages || []).length;
    syncChatUrl();
    setConversationHistory([{ role: 'system', content: SYSTEM_PROMPT }, ...(chat.messages || [])]);
    renderStoredChat();
    showNewChatStartupMessages();
  }
}

export function bindChatControls() {
ctx.btnNewChat?.addEventListener('click', () => ctx.createNewChat?.());
ctx.btnChatHistory?.addEventListener('click', openChatHistory);
ctx.copyChatLink?.addEventListener('click', copyCurrentChatLink);
window.addEventListener('popstate', () => { openChatFromUrl().catch(err => console.error('Could not open chat from URL:', err)); });
document.getElementById('btn-export-chat')?.addEventListener('click', exportCurrentChat);
document.getElementById('btn-search-chats')?.addEventListener('click', searchChatHistory);
ctx.chatClose.addEventListener('click', () => ctx.chatModal.classList.remove('open'));
ctx.chatModal.addEventListener('click', e => { if (e.target === ctx.chatModal) ctx.chatModal.classList.remove('open'); });

/* ── Init ───────────────────────────────────────────────────── */


$('change-passphrase')?.addEventListener('click', async () => {
  clearSessionKey();
  const saltB64 = await ctx.idbGet('settings', 'cryptoSalt');
  if (!saltB64) { ctx.appendSystemMsg('No passphrase is set yet.'); return; }
  const pass = await promptPassphrase(false);
  if (!pass) return;
  await initCryptoKey(pass, saltB64);
  await saveKeys(state.apiKeys);
  ctx.appendSystemMsg('API keys re-encrypted.');
});

// Passphrase controls are bound here because ctx is initialized only after module evaluation.

}
