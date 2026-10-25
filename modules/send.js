import { state } from './state.js';
import { ctx } from './ctx.js';
import { cloudInfer, wasmInfer } from './infer.js';
import { clearAttachmentPreview } from './attachments.js';
import { computeDiff, renderDiffHtml } from './diff.js';
import { escHtml } from './markdown.js';
import { conversationHistory, saveCurrentChat, generateChatTitle } from './chats.js';
import { dispatchTool } from './tools-dispatch.js';
import { buildRuntimeSystemPrompt, modelIdentity } from './identity.js';
import {
  appendUserMsg, appendAgentBubble, updateBubble, scheduleStreamRender, scrollBottom, appendMsgControls,
} from './messages.js';

/* ── Main Send Handler ─────────────────────────────────────── */
export async function sendMessage() {
  const text = ctx.userInput.value.trim();
  const hasImage = Boolean(state.pendingImage);
  if ((!text && !hasImage) || state.streaming) return;
  const isFirstUserMessage = !conversationHistory.some(message => message.role === 'user');
  const titleChatId = state.chatId;

  ctx.userInput.value = '';
  ctx.appendUserMsg(text || (hasImage ? 'Describe the attached image.' : ''));

  conversationHistory.push({ role: 'user', content: text || (hasImage ? 'Describe the attached image.' : '') });
  state.isNewChat = false;
  ctx.saveCurrentChat().catch(err => console.warn('Chat save failed:', err));
  if (isFirstUserMessage) void ctx.generateChatTitle(titleChatId, text);

  state.streaming = true;
  ctx.btnSend.disabled = true;
  ctx.btnStop.classList.add('visible');

  const engine = state.engine;
  let agentBubble = ctx.appendAgentBubble();
  let streamedText = '';

  if (engine === 'cloud') {
    ctx.setStatus('active', `Streaming — ${ctx.providerSelect.value}`);
  } else {
    ctx.setStatus('active', 'Local WASM Inference…');
  }

  try {
    const inferFn = engine === 'wasm' ? ctx.wasmInfer : ctx.cloudInfer;
    const requestHistory = [{ role: 'system', content: ctx.buildRuntimeSystemPrompt() }, ...conversationHistory.filter(m => m.role !== 'system')];

    const onChunk = chunk => {
      streamedText += chunk;
      ctx.scheduleStreamRender(agentBubble, streamedText);
    };

    const result = await inferFn(requestHistory, onChunk);

    if (!streamedText && !result.text && !result.assistantToolCalls?.length) {
      if (result?.suppressedError) {
        // Gemini 400 (e.g. thought_signature) suppressed — keep any prior tool UI, no red error.
        ctx.setStatus('idle', 'Idle — Gemini');
        return;
      }
      throw new Error('The selected model returned no text or tool call. Check the model selection and API response.');
    }

    ctx.updateBubble(agentBubble, streamedText || result.text || '', false);

    // Unified agent loop: every cloud provider uses the same Rex tools.
    let currentResult = result;
    let currentText = streamedText || result.text || '';
    let rounds = 0;
    while (currentResult?.assistantToolCalls?.length && rounds < 8) {
      rounds += 1;
      conversationHistory.push({
        role: 'assistant',
        content: currentResult.text || null,
        tool_calls: currentResult.assistantToolCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.args || '{}' },
          thoughtSignature: call.thoughtSignature || call.thought_signature || null,
        })),
      });

      for (const call of currentResult.assistantToolCalls) {
        let args = {};
        try { args = JSON.parse(call.args || '{}'); } catch (_) { args = {}; }
        const toolResult = await ctx.dispatchTool(call.name, args);
        const pretty = JSON.stringify(toolResult, null, 2);
        const outputDiv = document.createElement('div');
        outputDiv.className = 'tool-output';
        if (call.name === 'write_file' && toolResult.diff) {
          outputDiv.innerHTML = `<div class="tool-label">↳ write_file · ${ctx.escHtml(args.path || '')}</div>${ctx.renderDiffHtml(toolResult.diff)}`;
        } else if (call.name === 'generate_image' && toolResult.image_url) {
          const m = toolResult.model || 'flux';
          const w = toolResult.width || 1024;
          const h = toolResult.height || 1024;
          const shortUrl = toolResult.image_url.split('/').pop();
          outputDiv.innerHTML = `<div class="tool-label">↳ generate_image · ${ctx.escHtml(m)} · ${w}×${h} · <span style="color:var(--text-muted);font-size:0.7rem">${ctx.escHtml(shortUrl)}</span></div>`;
        } else {
          outputDiv.innerHTML = `<div class="tool-label">↳ ${ctx.escHtml(call.name)}</div><pre>${ctx.escHtml(pretty.slice(0, 12000))}${pretty.length > 12000 ? '\n… output truncated in UI …' : ''}</pre>`;
        }
        agentBubble.appendChild(outputDiv);
        ctx.scrollBottom();
        conversationHistory.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: pretty });
      }

      // Detect if this round was a successful image generation
      const wasImageGen = currentResult.assistantToolCalls.some(c => c.name === 'generate_image');
      const imageGenSucceeded = wasImageGen && conversationHistory.some(m => m.role === 'tool' && m.name === 'generate_image' && (() => { try { return !JSON.parse(m.content).error; } catch(_){return false;} })());

      const followBubble = ctx.appendAgentBubble();
      let followText = '';
      const onFollowChunk = c => { followText += c; ctx.scheduleStreamRender(followBubble, followText); };
      const followHistory = [{ role: 'system', content: ctx.buildRuntimeSystemPrompt() }, ...conversationHistory.filter(m => m.role !== 'system')];
      currentResult = await inferFn(followHistory, onFollowChunk);

      if (currentResult?.suppressedError && !followText && !currentResult.text && !currentResult.assistantToolCalls?.length) {
        followBubble.remove();
        break;
      }

      if (imageGenSucceeded) {
        // Suppress any follow-up text — the image bubble already shows everything needed
        followBubble.remove();
        currentText = '';
      } else {
        ctx.updateBubble(followBubble, followText || currentResult.text || '', false);
        currentText = followText || currentResult.text || currentText;
        agentBubble = followBubble;
        streamedText = followText;
      }
    }
    if (currentResult?.assistantToolCalls?.length) {
      throw new Error('Tool loop stopped after 8 rounds to prevent an infinite tool cycle.');
    }
    const finalText = currentText;
    ctx.updateBubble(agentBubble, finalText || result.text || '', false);
    agentBubble.dataset.rawText = finalText || result.text || '';
    conversationHistory.push({ role: 'assistant', content: finalText });
    ctx.appendMsgControls(agentBubble.parentElement, finalText || result.text || '', () => text);
    state.chatLastAccess = ctx.modelIdentity();
    await ctx.saveCurrentChat();

    ctx.setStatus('idle', engine === 'cloud' ? `Idle — ${ctx.providerSelect.value}` : 'Idle — Local WASM');

  } catch (err) {
    if (err.name === 'AbortError') {
      ctx.updateBubble(agentBubble, streamedText || '', false);
      const note = document.createElement('em');
      note.style.cssText = 'color:var(--text-muted);font-size:0.8rem;display:block;margin-top:6px';
      note.textContent = '[stopped]';
      agentBubble.appendChild(note);
      ctx.setStatus('idle', 'Stopped');
    } else {
      agentBubble.innerHTML = `<span style="color:var(--danger);font-size:0.8125rem">Error: ${ctx.escHtml(err.message)}</span>`;
      ctx.setStatus('error', err.message.slice(0, 60));
    }
  } finally {
    ctx.clearAttachmentPreview();
    state.streaming = false;
    ctx.btnSend.disabled = false;
    ctx.btnStop.classList.remove('visible');
    state.abortController = null;
  }
}

export function bindSendUI() {
  ctx.btnSend?.addEventListener('click', sendMessage);
}

