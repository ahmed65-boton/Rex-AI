// Pure API_Keys.txt parser. Aliases come from api_keys_schema.json (single source of truth).

let ALIASES = null;

/**
 * Install the alias map (usually from api_keys_schema.json).
 * @param {Record<string, string>} map
 */
export function setApiKeyAliases(map) {
  if (!map || typeof map !== 'object') {
    throw new Error('API key aliases must be an object.');
  }
  ALIASES = { ...map };
  return ALIASES;
}

/** @returns {Record<string, string>|null} */
export function getApiKeyAliases() {
  return ALIASES ? { ...ALIASES } : null;
}

/**
 * Load aliases from the shared schema file.
 * Works in the browser (fetch) and in Node (fs).
 * @param {string} [urlOrPath]
 */
export async function loadApiKeySchema(urlOrPath = 'api_keys_schema.json') {
  let data;
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve, isAbsolute } = await import('node:path');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const path = isAbsolute(urlOrPath) ? urlOrPath : resolve(root, urlOrPath);
    data = JSON.parse(await readFile(path, 'utf8'));
  } else {
    const res = await fetch(urlOrPath, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to load API key schema (${res.status}).`);
    data = await res.json();
  }
  if (!data?.aliases || typeof data.aliases !== 'object') {
    throw new Error('api_keys_schema.json is missing an "aliases" object.');
  }
  return setApiKeyAliases(data.aliases);
}

/**
 * Parse API_Keys.txt-style text into a flat key map.
 * @param {string} text
 * @param {Record<string, string>} [aliasMap] optional override (defaults to loaded schema)
 */
export function parseApiKeyText(text, aliasMap) {
  const aliases = aliasMap || ALIASES;
  if (!aliases) {
    throw new Error('API key schema not loaded. Call loadApiKeySchema() or setApiKeyAliases() first.');
  }
  const result = {};
  let pendingKey = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    if (line.includes(':')) {
      const [rawLabel, ...rest] = line.split(':');
      const key = aliases[rawLabel.trim().toLowerCase()];
      const value = rest.join(':').trim();
      if (key) {
        if (value) {
          result[key] = value;
          pendingKey = null;
        } else {
          pendingKey = key;
        }
        continue;
      }
    }
    if (pendingKey) {
      result[pendingKey] = line;
      pendingKey = null;
    }
  }
  return result;
}
