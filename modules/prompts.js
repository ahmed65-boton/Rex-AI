/* Saved prompt templates stored in IndexedDB (store: 'prompts'). */
import { idbPut, idbDelete, idbAll } from './db.js';

function newId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {string} title
 * @param {string} text
 * @param {string} [id] existing id to update
 */
export async function savePrompt(title, text, id) {
  const trimmedTitle = String(title || '').trim() || 'Untitled prompt';
  const trimmedText = String(text || '').trim();
  if (!trimmedText) throw new Error('Prompt text cannot be empty.');
  const record = {
    id: id || newId(),
    title: trimmedTitle.slice(0, 120),
    text: trimmedText,
    updatedAt: Date.now(),
  };
  if (!id) record.createdAt = Date.now();
  await idbPut('prompts', record);
  return record;
}

export async function listPrompts() {
  const all = await idbAll('prompts');
  return (all || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function deletePrompt(id) {
  if (!id) return;
  await idbDelete('prompts', id);
}

export async function getPrompt(id) {
  const all = await listPrompts();
  return all.find(p => p.id === id) || null;
}
