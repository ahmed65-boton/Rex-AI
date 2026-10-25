/** Shared app context (DOM refs + mutable session fields). Filled by app.js after DOM query. */
export const ctx = {
  historyStorage: 'indexeddb',
  scrollFrame: 0,
  streamFrame: 0,
  pendingStreamBubble: null,
  pendingStreamText: '',
  apiKeyFileName: null,
  apiKeyFileExaOverride: null,
  apiKeyFileKeys: new Set(),
  apiKeyFileSource: null,
  workspacePickerPath: '',
  workspacePickerEl: null,
  API_KEY_FILENAMES: ['API Keys.txt', 'API_Keys.txt', 'api keys.txt', 'api_keys.txt'],
  BUILTIN_API_KEYS: {},
};

export const $ = (id) => document.getElementById(id);

export function assignCtx(partial) {
  Object.assign(ctx, partial);
  return ctx;
}
