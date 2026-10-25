/* Minimal line-level diff (LCS) for the write_file tool view. */
export function computeDiff(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  const m = a.length, n = b.length;
  const lcs = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', line: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ type: 'del', line: a[i] }); i++; }
    else { out.push({ type: 'add', line: b[j] }); j++; }
  }
  while (i < m) out.push({ type: 'del', line: a[i++] });
  while (j < n) out.push({ type: 'add', line: b[j++] });
  return out;
}

export function summarizeDiff(diff) {
  let adds = 0, dels = 0;
  for (const d of diff) { if (d.type === 'add') adds++; else if (d.type === 'del') dels++; }
  return { adds, dels };
}

export function renderDiffHtml(diff) {
  const { adds, dels } = summarizeDiff(diff);
  const lines = [];
  for (const d of diff) {
    const cls = d.type === 'add' ? 'diff-add' : d.type === 'del' ? 'diff-del' : 'diff-ctx';
    const prefix = d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' ';
    lines.push(`<div class="diff-line ${cls}"><span class="diff-prefix">${prefix}</span>${escapeHtml(d.line)}</div>`);
  }
  return `<details class="diff-panel"><summary>File changes <span class="diff-counts">+${adds} −${dels}</span></summary><div class="diff-body">${lines.join('')}</div></details>`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
