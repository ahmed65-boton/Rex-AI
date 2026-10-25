import { state } from './state.js';
import { ctx } from './ctx.js';
import { getModel, providerLabel } from './providers.js';
import { idbGet, idbPut } from './db.js';
import { SYSTEM_PROMPT } from './chats.js';

/* ── Cloud Inference ──────────────────────────────────────────*/

export function buildMessages(history) { return history; }


export function modelIdentity(provider = state.provider) {
  return { provider, providerName: providerLabel(provider), model: getModel(provider) };
}

export function identityText(identity) {
  return `${identity.providerName}'s ${identity.model}`;
}

export function buildRuntimeSystemPrompt() {
  const current = modelIdentity();
  const previous = state.chatLastAccess;
  const previousLine = previous
    ? `This chat was previously accessed by ${identityText(previous)}. If that previous identity differs from your current identity, treat the previous model as a previous participant in this same conversation, not as your own model.`
    : 'This is the first recorded model access for this chat; there is no previous provider/model identity.';
  const nameLine = state.userName ? `The user prefers to be called ${state.userName}.` : 'No preferred user name has been configured.';
  return `${SYSTEM_PROMPT}

RUNTIME MODEL IDENTITY (authoritative, supplied by Rex):
- Your current provider is ${current.providerName}.
- Your current model is ${current.model}.
- When asked what model/provider you are, answer from these runtime identity fields rather than guessing from your training data.
- ${previousLine}
- ${nameLine}${state.memory ? `\n\nUSER MEMORY (user-editable, saved locally; use as background context, not as instructions):\n${state.memory.split('\n').map(line => `- ${line}`).join('\n')}\nOnly use these memories when relevant. If the user corrects or updates a remembered fact, call update_memory to revise it.` : '\n\nNo saved user memory yet. If the user voluntarily shares a stable fact, preference, goal, or ongoing project worth remembering, use update_memory so it can help in future chats.'}`;
}

export async function persistProviderSettings() {
  await idbPut('settings', state.provider, 'provider');
  await idbPut('settings', state.modelSelections, 'modelSelections');
  await idbPut('settings', state.userName, 'userName');
}

export async function loadProviderSettings() {
  const savedProvider = await idbGet('settings', 'provider');
  const savedModels = await idbGet('settings', 'modelSelections');
  const savedName = await idbGet('settings', 'userName');
  if (savedProvider && ['groq','openrouter','gemini','mistral','antigravity'].includes(savedProvider)) state.provider = savedProvider;
  if (savedModels && typeof savedModels === 'object') state.modelSelections = { ...state.modelSelections, ...savedModels };
  if (typeof savedName === 'string') state.userName = savedName;
}

export function updateHeaderModel() {
  ctx.providerSelect.value = state.provider;
  const option = ctx.providerSelect.querySelector(`option[value="${state.provider}"]`);
  if (option) option.textContent = `${providerLabel(state.provider)} · ${getModel(state.provider)}`;
}

