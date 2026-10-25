/* Cloud / WASM inference adapters. */
import { state } from './state.js';
import { getModel, providerLabel, providerConfig } from './providers.js';
import { TOOLS_SCHEMA, GEMINI_TOOLS } from './tools.js';
import { bridgeRequest } from './ws.js';

let runtime = {};
export function configureInfer(options) { runtime = options; }

export async function openAICompatibleInfer(messages, onChunk) {
  const provider = state.provider;
  const cfg = providerConfig(provider);
  if (!cfg.key || cfg.key === 'REPLACE_WITH_OPENROUTER_KEY') {
    throw new Error(`${providerLabel(provider)} API key is not configured. Open ⚙ Settings or import API Keys.txt.`);
  }
  if (!cfg.model) throw new Error(`${providerLabel(provider)} has no model selected.`);

  const request = async includeTools => {
    let wireMessages = messages;
    if (state.pendingImage && provider === 'openrouter') {
      wireMessages = messages.map((m, idx) => {
        if (idx !== messages.length - 1 || m.role !== 'user') return m;
        return {
          role: 'user',
          content: [
            { type: 'text', text: String(m.content || '') },
            { type: 'image_url', image_url: { url: `data:${state.pendingImage.mimeType};base64,${state.pendingImage.base64}` } },
          ],
        };
      });
    }

    const body = {
      model: cfg.model,
      messages: wireMessages,
      stream: true,
      max_tokens: 4096,
    };
    if (includeTools) {
      body.tools = TOOLS_SCHEMA;
      body.tool_choice = 'auto';
    }

    state.abortController = new AbortController();
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        ...(cfg.extraHeaders || {}),
      },
      body: JSON.stringify(body),
      signal: state.abortController.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      const lower = err.toLowerCase();
      if (state.pendingImage && (lower.includes('image input') || lower.includes('image support') || lower.includes('vision'))) {
        throw new Error(
          `Model “${cfg.model}” does not support image input on OpenRouter. ` +
          `Remove the attached image, or switch to a vision model in Settings → Model ` +
          `(examples: openai/gpt-4o, google/gemini-2.5-flash-preview, anthropic/claude-sonnet-4).`
        );
      }
      const message = `${providerLabel(provider)} API error ${res.status}: ${err.slice(0, 800)}`;
      const retryWithoutTools = includeTools && (res.status === 400 || res.status === 422);
      if (retryWithoutTools) return request(false);
      throw new Error(message);
    }

    if (!res.body) throw new Error(`${providerLabel(provider)} returned an empty response body.`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    const toolCalls = {};
    let buffer = '';

    const consumeLine = rawLine => {
      const line = rawLine.trim();
      if (!line || !line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') return;
      let delta;
      try { delta = JSON.parse(raw); } catch (_) { return; }
      const choice = delta.choices?.[0];
      const d = choice?.delta;
      if (typeof d?.content === 'string' && d.content) {
        fullText += d.content;
        onChunk(d.content);
      }
      for (const tc of (d?.tool_calls || [])) {
        const idx = tc.index ?? 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', args: '' };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].name = tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer) consumeLine(buffer);

    const calls = Object.values(toolCalls).filter(call => call.name).map(call => ({
      ...call,
      id: call.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    }));
    return { text: fullText, toolCalls: [], assistantToolCalls: calls };
  };

  return request(true);
}


export function openRouterToolResultsForGemini(messages) {
  return messages.map(m => {
    if (m.role === 'tool') {
      return { role: 'user', parts: [{ functionResponse: { name: m.name, response: (() => { try { return JSON.parse(m.content); } catch (_) { return { content: m.content }; } })() } }] };
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) {}
        // Gemini 3+ requires thought_signature on functionCall parts when echoing history.
        const part = { functionCall: { name: tc.function.name, args } };
        const sig = tc.thoughtSignature || tc.thought_signature || tc.function?.thoughtSignature;
        if (sig) {
          part.thoughtSignature = sig;
        } else {
          // Last-resort bypass when signature was lost (still better than a hard 400).
          part.thoughtSignature = 'skip_thought_signature_validator';
        }
        parts.push(part);
      }
      return { role: 'model', parts };
    }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    };
  });
}

export async function geminiInfer(messages, onChunk) {
  const key = state.apiKeys.gemini;
  if (!key) throw new Error('Google Gemini API key is not configured. Open ⚙ Settings or import API Keys.txt.');
  const model = getModel('gemini');
  if (!model) throw new Error('Google Gemini has no model selected.');

  const systemMsg = messages.find(m => m.role === 'system');
  const contents = openRouterToolResultsForGemini(messages.filter(m => m.role !== 'system'));

  if (state.pendingImage) {
    const last = contents[contents.length - 1];
    if (last && last.role === 'user') {
      last.parts = [
        ...last.parts,
        { inlineData: { mimeType: state.pendingImage.mimeType, data: state.pendingImage.base64 } },
      ];
    }
  }

  const request = async includeTools => {
    const requestBody = {
      contents,
      ...(includeTools ? {
        tools: GEMINI_TOOLS,
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      } : {}),
      ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
      generationConfig: { maxOutputTokens: 4096 },
    };

    state.abortController = new AbortController();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: state.abortController.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const lower = errBody.toLowerCase();
      // Thought-signature failures: retry once without tools so the chat can continue.
      if (includeTools && res.status === 400) {
        return request(false);
      }
      // User preference: do not surface generic Gemini 400s in the chat UI.
      if (res.status === 400) {
        console.warn('Gemini API 400 (suppressed in UI):', errBody.slice(0, 500));
        return { text: '', toolCalls: [], assistantToolCalls: [], suppressedError: true };
      }
      throw new Error(`Google Gemini API error ${res.status}: ${errBody.slice(0, 800)}`);
    }

    const data = await res.json();
    const candidate = data?.candidates?.[0];
    if (!candidate) {
      const blockReason = data?.promptFeedback?.blockReason;
      throw new Error(blockReason ? `Google Gemini blocked this request: ${blockReason}.` : 'Google Gemini returned no candidate response.');
    }
    const parts = candidate?.content?.parts || [];
    let fullText = '';
    const calls = [];
    for (const part of parts) {
      if (typeof part.text === 'string' && part.text) {
        fullText += part.text;
        onChunk(part.text);
      }
      if (part.functionCall) {
        const sig = part.thoughtSignature || part.thought_signature || null;
        calls.push({
          id: `gemini_${Date.now()}_${calls.length}`,
          name: part.functionCall.name,
          args: JSON.stringify(part.functionCall.args || {}),
          thoughtSignature: sig,
        });
      }
    }
    if (!fullText && !calls.length && candidate.finishReason) {
      throw new Error(`Google Gemini finished without text (${candidate.finishReason}).`);
    }
    return { text: fullText, toolCalls: [], assistantToolCalls: calls };
  };

  return request(true);
}
export async function antigravityInfer(messages, onChunk) {
  const key = state.apiKeys.antigravity;
  if (!key || key.startsWith('REPLACE---ME')) throw new Error('Antigravity API key is not configured. Open ⚙ Settings.');
  if (!state.bridgeWorkspace && !state.wsConnected) throw new Error('Antigravity needs the Rex workspace bridge. Start Rex normally and attach a workspace.');
  const nonSystem = messages.filter(m => m.role !== 'system');
  const recent = nonSystem.slice(-24).map(m => {
    if (m.role === 'user') return `User: ${m.content}`;
    if (m.role === 'assistant') return `Antigravity/Rex: ${m.content || ''}`;
    return '';
  }).filter(Boolean).join('\n\n');
  const system = messages.find(m => m.role === 'system')?.content || '';
  const prompt = `${system}\n\nYou are operating as the Antigravity agent for Rex. The selected workspace is already mounted to you.\n\nConversation context:\n${recent}`;
  const result = await bridgeRequest({ action: 'antigravity', prompt, apiKey: key });
  if (!result?.ok) throw new Error(result?.error || 'Antigravity failed.');
  if (result.text) onChunk(result.text);
  return { text: result.text || '', toolCalls: [], assistantToolCalls: [] };
}

export async function cloudInfer(messages, onChunk) {
  try { logEvent('llm_req', { provider: state.provider, model: getModel(state.provider), msgs: messages.length }); } catch (_) {}
  if (state.provider === 'gemini') return geminiInfer(messages, onChunk);
  if (state.provider === 'antigravity') return antigravityInfer(messages, onChunk);
  return openAICompatibleInfer(messages, onChunk);
}

/* ── WASM Local Inference ──────────────────────────────────── */
export async function wasmInfer(messages, onChunk) {
  if (!state.wasmEngine || !state.wasmLoaded) {
    throw new Error('No WASM model loaded. Load a .gguf file first.');
  }

  const prompt = messages
    .map(m => (m.role === 'user' ? `User: ${m.content}` : `Assistant: ${m.content}`))
    .join('\n') + '\nAssistant: ';

  await state.wasmEngine.createCompletion(prompt, {
    nPredict: 2048,
    onNewToken: (token, _piece, currentText) => {
      onChunk(token);
    },
  });

  return { text: '', toolCalls: [] }; // streamed via onChunk
}

/* ── Conversation / chat persistence ───────────────────────── */
