/* Circular in-memory event log. Toggled with Ctrl+Shift+D. */
const MAX_EVENTS = 200;
const events = [];
let panel = null;
let visible = false;

export function logEvent(type, payload) {
  events.push({ type, payload, ts: Date.now() });
  if (events.length > MAX_EVENTS) events.shift();
  if (visible && panel) render();
}

export function toggleDebugPanel() {
  if (!panel) createPanel();
  visible = !visible;
  panel.hidden = !visible;
  if (visible) render();
}

function createPanel() {
  panel = document.createElement('div');
  panel.id = 'debug-panel';
  panel.hidden = true;
  panel.style.cssText = 'position:fixed;right:12px;bottom:12px;width:420px;max-height:50vh;background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;font-family:var(--font-mono);font-size:11px;overflow:auto;z-index:200;padding:8px;color:var(--text-main);box-shadow:0 8px 24px rgba(0,0,0,0.4);';
  document.body.appendChild(panel);
}

function render() {
  if (!panel) return;
  const rows = events.slice().reverse().map(e => {
    const t = new Date(e.ts).toLocaleTimeString();
    const json = (() => { try { return JSON.stringify(e.payload).slice(0, 180); } catch { return String(e.payload); } })();
    return `<div style="padding:2px 0;border-bottom:1px solid var(--border);"><b style="color:var(--accent)">${e.type}</b> <span style="color:var(--text-muted)">${t}</span><br>${escapeHtml(json)}</div>`;
  }).join('');
  panel.innerHTML = `<div style="display:flex;justify-content:space-between;margin-bottom:6px;color:var(--text-muted);"><span>DEBUG · ${events.length} events</span></div>` + rows;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    toggleDebugPanel();
  }
});
