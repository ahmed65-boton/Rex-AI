import { state } from './state.js';
import { ctx } from './ctx.js';

/* ── Exa Web Search ─────────────────────────────────────────── */
export async function exaSearch(query) {
  const key = state.apiKeys.exa;
  if (!key) throw new Error('Exa API key not configured. Add Exa: ... to API_Keys.txt.');
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults: 10,
      contents: { highlights: true },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Exa API error ${res.status}: ${data?.error || data?.message || 'request failed'}`);
  return (data.results || []).map(item => ({
    title: item.title,
    url: item.url,
    publishedDate: item.publishedDate,
    author: item.author,
    highlights: item.highlights || [],
    text: item.text || '',
  }));
}

/* ── Command Risk Assessment ───────────────────────────────── */
/* ── Render Risk Card (inline in chat) ─────────────────────── */
