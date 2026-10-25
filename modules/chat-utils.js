// Pure chat utilities: search saved messages and serialize a chat for export.
function findChatMatches(chats, query) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) return [];
  return (chats || []).map(chat => {
    const hits = (chat.messages || []).filter(message => String(message.content || '').toLowerCase().includes(normalized));
    const first = hits[0];
    return hits.length ? { chat, hits, snippet: String(first.content || '').replace(/\s+/g, ' ').slice(0, 180) } : null;
  }).filter(Boolean);
}

function formatChatExport(chat, format, model) {
  if (String(format).toLowerCase() === 'json') return JSON.stringify(chat, null, 2);
  return [
    '---', `chatId: ${JSON.stringify(chat.id)}`, `model: ${JSON.stringify(model)}`, `date: ${new Date(chat.updatedAt || Date.now()).toISOString()}`, '---', '',
    ...(chat.messages || []).map(message => `**${message.role === 'user' ? 'You' : 'Rex'}:**\n\n${String(message.content || '')}`),
  ].join('\n\n');
}

function chatExportFilename(title, format) {
  const safe = String(title || 'rex-chat').replace(/[^a-z0-9-_]+/gi, '-').slice(0, 60) || 'rex-chat';
  return `${safe}.${String(format).toLowerCase() === 'json' ? 'json' : 'md'}`;
}

export { findChatMatches, formatChatExport, chatExportFilename };
