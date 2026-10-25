// Safe-ish Markdown-to-HTML renderer used for chat bubbles.
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* Full markdown renderer — bold/italic/tables/lists/headings render correctly,
   raw * and _ never reach the DOM */
function formatMessage(raw) {
  if (!raw) return '';
  let text = String(raw);

  // Some models emit escaped newlines or place Markdown list markers inline
  // after a sentence. Normalize those into real list lines before parsing.
  // Only split star markers that look like bullets (e.g. * **Heading**), so
  // ordinary emphasis such as *this* is left alone.
  text = text.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
  text = text.replace(/[ \t]+\*[ \t]+(?=(?:\*\*|[A-Z0-9]))/g, '\n* ');

  const blocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const label = lang ? `<span class="code-lang">${escHtml(lang)}</span>` : '';
    blocks.push(`<pre>${label}<code>${escHtml(code.trimEnd())}</code></pre>`);
    return `\x00B${blocks.length - 1}\x00`;
  });
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^[-*_]{3,}\s*$/.test(line.trim())) { out.push('<hr>'); i++; continue; }
    const hm = line.match(/^(#{1,3})\s+(.+)/);
    if (hm) { out.push(`<h${hm[1].length}>${inlineFmt(hm[2])}</h${hm[1].length}>`); i++; continue; }
    if (line.startsWith('> ')) {
      const bq = [];
      while (i < lines.length && lines[i].startsWith('> ')) { bq.push(lines[i].slice(2)); i++; }
      out.push(`<blockquote>${inlineFmt(bq.join(' '))}</blockquote>`); continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\|?[\s:|-]+\|/.test(lines[i + 1])) {
      const tbl = [];
      while (i < lines.length && lines[i].includes('|')) { tbl.push(lines[i]); i++; }
      out.push(renderMdTable(tbl)); continue;
    }
    if (/^(\s*)[-*+]\s+/.test(line)) {
      const ls = [];
      while (i < lines.length && /^(\s*)[-*+]\s+/.test(lines[i])) { ls.push(lines[i]); i++; }
      out.push('<ul>' + ls.map(l => `<li>${inlineFmt(l.replace(/^\s*[-*+]\s+/, ''))}</li>`).join('') + '</ul>'); continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const ls = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { ls.push(lines[i]); i++; }
      out.push('<ol>' + ls.map(l => `<li>${inlineFmt(l.replace(/^\d+\.\s+/, ''))}</li>`).join('') + '</ol>'); continue;
    }
    if (line.trim() === '') { out.push('\x00BR\x00'); i++; continue; }
    out.push(inlineFmt(line)); i++;
  }
  const BLOCK = /^<(h[1-3]|pre|ul|ol|blockquote|hr|div|table)/;
  let html = '', para = [];
  const flush = () => { if (para.length) { html += `<p>${para.join('<br>')}</p>`; para = []; } };
  for (const p of out) {
    if (p === '\x00BR\x00') flush();
    else if (BLOCK.test(p)) { flush(); html += p; }
    else para.push(p);
  }
  flush();
  html = html.replace(/\x00B(\d+)\x00/g, (_, n) => blocks[n]);
  return `<div class="msg-content">${html}</div>`;
}

function inlineFmt(text) {
  const codes = [];
  const links = [];
  text = text.replace(/`([^`]+)`/g, (_, c) => { codes.push(`<code>${escHtml(c)}</code>`); return `\x01C${codes.length-1}\x01`; });
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, url) => {
    const cleanUrl = url.replace(/[\"<>]/g, '');
    links.push(`<a href="${escHtml(cleanUrl)}" target="_blank" rel="noopener noreferrer">${escHtml(label)}</a>`);
    return `\x01L${links.length-1}\x01`;
  });
  text = escHtml(text);
  text = text.replace(/\*{3}(.+?)\*{3}/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*{2}(.+?)\*{2}/g, '<strong>$1</strong>');
  text = text.replace(/_{2}(.+?)_{2}/g,    '<strong>$1</strong>');
  text = text.replace(/\*([^*\n]+?)\*/g,   '<em>$1</em>');
  text = text.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<em>$1</em>');
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
  text = text.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<]+)(?=$|[\s)\]}>])/gi, (_, prefix, url) => {
    let shown = url;
    let trailing = '';
    while (/[.,!?;:]$/.test(shown)) { trailing = shown.slice(-1) + trailing; shown = shown.slice(0, -1); }
    const href = shown.toLowerCase().startsWith('www.') ? `https://${shown}` : shown;
    return `${prefix}<a href="${href}" target="_blank" rel="noopener noreferrer">${shown}</a>${trailing}`;
  });
  text = text.replace(/\x01L(\d+)\x01/g, (_, n) => links[n]);
  return text.replace(/\x01C(\d+)\x01/g, (_, n) => codes[n]);
}

function renderMdTable(lines) {
  const parse = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const heads = parse(lines[0]);
  const rows  = lines.slice(2).map(parse);
  return `<div class="md-table-wrap"><table>`
    + `<thead><tr>${heads.map(h => `<th>${inlineFmt(h)}</th>`).join('')}</tr></thead>`
    + (rows.length ? `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inlineFmt(c??'')}</td>`).join('')}</tr>`).join('')}</tbody>` : '')
    + `</table></div>`;
}


export { escHtml, formatMessage, inlineFmt, renderMdTable };
