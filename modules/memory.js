/* Local, user-editable long-term memory helpers. */
export function normalizeMemory(value) {
  const seen = new Set();
  return String(value || '')
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(line => {
      if (!line) return false;
      const key = line.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 50)
    .join('\n');
}

export function applyMemoryChanges(current, { add = [], remove = [] } = {}) {
  const entries = normalizeMemory(current).split('\n').filter(Boolean);
  const removeSet = new Set((Array.isArray(remove) ? remove : [remove])
    .map(value => String(value || '').trim().toLocaleLowerCase()).filter(Boolean));
  const kept = entries.filter(entry => !removeSet.has(entry.toLocaleLowerCase()));
  const seen = new Set(kept.map(entry => entry.toLocaleLowerCase()));
  for (const value of (Array.isArray(add) ? add : [add])) {
    const entry = String(value || '').replace(/\s+/g, ' ').trim();
    if (!entry) continue;
    const key = entry.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
    if (kept.length >= 50) break;
  }
  return kept.join('\n');
}
