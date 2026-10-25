import { state } from './state.js';
import { ctx, $ } from './ctx.js';
import { formatMessage, escHtml } from './markdown.js';
import { bridgeRequest } from './ws.js';
import { savePrompt } from './prompts.js';
import { conversationHistory } from './chats.js';
import { cloudInfer } from './infer.js';

export function updateBubble(bubble, text, streaming) {
  bubble.dataset.rawText = text;
  if (streaming) {
    bubble.textContent = text;
    const cursor = document.createElement('span');
    cursor.className = 'stream-cursor';
    bubble.appendChild(cursor);
    return;
  }

  // A queued animation-frame update can otherwise run after this final render
  // and replace formatted Markdown with the raw streaming text.
  if (ctx.streamFrame) {
    cancelAnimationFrame(ctx.streamFrame);
    ctx.streamFrame = 0;
  }
  if (ctx.pendingStreamBubble === bubble) {
    ctx.pendingStreamBubble = null;
    ctx.pendingStreamText = '';
  }
  bubble.innerHTML = ctx.formatMessage(text);
}

export function renderGeneratedImage(url, prompt) {
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.innerHTML = `<div class="msg-meta">rex · image</div><div class="msg-bubble image-bubble"><div class="image-caption">${ctx.escHtml(prompt)}</div><img src="${ctx.escHtml(url)}" alt="Generated image" loading="lazy"></div>`;
  ctx.chatThread.appendChild(div);
  scrollBottom(true);
}

export function appendUserMsg(text, scroll = true) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="msg-meta">You</div><div class="msg-bubble">${ctx.escHtml(text)}</div>`;
  const controls = document.createElement('div');
  controls.className = 'msg-controls';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'msg-ctrl-btn prompt-save-btn';
  saveBtn.title = 'Save as prompt';
  saveBtn.setAttribute('aria-label', 'Save as prompt');
  saveBtn.textContent = 'Save prompt';
  saveBtn.addEventListener('click', () => promptSaveFromText(text));
  controls.appendChild(saveBtn);
  div.appendChild(controls);
  ctx.chatThread.appendChild(div);
  if (scroll) scrollBottom();
  return div;
}

const SVG_RETRY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.8-4L3 10m0 0V4m0 6h6M4 13a8 8 0 0 0 14.8 4L21 14m0 0v6m0-6h-6"/></svg>';
const SVG_SPEAKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6l-5 4H4Z"/><path d="M16 9.5a4 4 0 0 1 0 5M18.5 7a7.5 7.5 0 0 1 0 10"/></svg>';
const SVG_STOP_AUDIO = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';
let ttsState = { audio: null, activeBtn: null, objectUrl: null };

export function stopTTS() {
  if (ttsState.audio) {
    ttsState.audio.pause();
    ttsState.audio.currentTime = 0;
  }
  if (ttsState.objectUrl) URL.revokeObjectURL(ttsState.objectUrl);
  if (ttsState.activeBtn) {
    ttsState.activeBtn.innerHTML = SVG_SPEAKER;
    ttsState.activeBtn.classList.remove('active', 'loading');
  }
  ttsState = { audio: null, activeBtn: null, objectUrl: null };
}

export function pcmToWav(base64Audio, sampleRate = 24000, channels = 1) {
  const binary = atob(base64Audio);
  const pcm = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) pcm[i] = binary.charCodeAt(i);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + pcm.length, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, pcm.length, true);
  return new Blob([header, pcm], { type: 'audio/wav' });
}

export async function handleTTS(btn, getText) {
  if (ttsState.activeBtn === btn && ttsState.audio) { stopTTS(); return; }
  if (ttsState.audio) stopTTS();
  const text = String(getText() || '').trim();
  if (!text) return;
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    const result = await ctx.bridgeRequest({ action: 'tts', text, apiKey: state.apiKeys.gemini || '' });
    if (!result.ok) throw new Error(result.error || 'Gemini TTS failed.');
    const mime = String(result.mimeType || 'audio/pcm').toLowerCase();
    let blob;
    if (mime.includes('pcm') || mime.includes('l16')) {
      const rateMatch = mime.match(/rate=(\d+)/i);
      blob = pcmToWav(result.audio, rateMatch ? Number(rateMatch[1]) : 24000);
    } else {
      const bin = atob(result.audio); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blob = new Blob([bytes], { type: result.mimeType || 'audio/wav' });
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    ttsState = { audio, activeBtn: btn, objectUrl: url };
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.classList.add('active');
    btn.innerHTML = SVG_STOP_AUDIO;
    audio.onended = stopTTS;
    audio.onerror = () => { stopTTS(); appendSystemMsg('Audio playback failed.'); };
    await audio.play();
  } catch (err) {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.innerHTML = SVG_SPEAKER;
    appendSystemMsg(`TTS error: ${err.message}`);
  }
}

export function appendMsgControls(msgDiv, responseText, userPromptFn) {
  msgDiv.querySelector('.msg-controls')?.remove();
  const controls = document.createElement('div');
  controls.className = 'msg-controls';
  if (userPromptFn) {
    const retry = document.createElement('button');
    retry.className = 'msg-ctrl-btn'; retry.type = 'button';
    retry.setAttribute('aria-label', 'Retry response'); retry.title = 'Retry response'; retry.innerHTML = SVG_RETRY;
    retry.addEventListener('click', () => handleRetry(msgDiv, retry, userPromptFn));
    controls.appendChild(retry);
  }
  const speaker = document.createElement('button');
  speaker.className = 'msg-ctrl-btn'; speaker.type = 'button';
  speaker.setAttribute('aria-label', 'Read response aloud'); speaker.title = 'Read response aloud'; speaker.innerHTML = SVG_SPEAKER;
  speaker.addEventListener('click', () => handleTTS(speaker, () => msgDiv.querySelector('.msg-bubble')?.dataset.rawText || responseText));
  controls.appendChild(speaker);
  msgDiv.appendChild(controls);
}

export function renderVariantNavigator(msgDiv, message, onSwitch) {
  msgDiv.querySelector('.variant-nav')?.remove();
  const variants = message.variants || [];
  if (variants.length < 2) return;
  const nav = document.createElement('div');
  nav.className = 'variant-nav';
  nav.innerHTML = `
    <button class="variant-prev" aria-label="Previous variant">‹</button>
    <span class="variant-label">${(message.activeVariant ?? 0) + 1}/${variants.length}</span>
    <button class="variant-next" aria-label="Next variant">›</button>`;
  nav.querySelector('.variant-prev').addEventListener('click', () => {
    message.activeVariant = ((message.activeVariant ?? 0) - 1 + variants.length) % variants.length;
    onSwitch(message.activeVariant);
  });
  nav.querySelector('.variant-next').addEventListener('click', () => {
    message.activeVariant = ((message.activeVariant ?? 0) + 1) % variants.length;
    onSwitch(message.activeVariant);
  });
  msgDiv.appendChild(nav);
}

export async function handleRetry(msgDiv, retryBtn, getUserPrompt) {
  if (state.streaming) return;
  const prompt = String(getUserPrompt() || '').trim();
  const userIndex = conversationHistory.findIndex((m, i) => i > 0 && m.role === 'user' && m.content === prompt);
  if (userIndex < 0) { appendSystemMsg('Could not find the original user prompt for this response.'); return; }

  let responseIndex = -1;
  for (let i = userIndex + 1; i < conversationHistory.length; i++) {
    if (conversationHistory[i].role === 'user') break;
    if (conversationHistory[i].role === 'assistant') responseIndex = i;
  }
  if (responseIndex < 0) { appendSystemMsg('No assistant response to branch from.'); return; }

  const target = conversationHistory[responseIndex];
  target.variants ||= [{ text: target.content || '', model: ctx.getModel(state.provider), ts: Date.now() }];
  target.activeVariant ??= target.variants.length - 1;

  state.streaming = true;
  retryBtn.disabled = true; retryBtn.classList.add('loading');
  const bubble = msgDiv.querySelector('.msg-bubble');
  let streamed = '';
  try {
    const history = [{ role: 'system', content: ctx.buildRuntimeSystemPrompt() }, ...conversationHistory.slice(1, userIndex + 1)];
    const result = await ctx.cloudInfer(history, chunk => { streamed += chunk; scheduleStreamRender(bubble, streamed); });
    const finalText = streamed || result.text || '';
    target.variants.push({ text: finalText, model: ctx.getModel(state.provider), ts: Date.now() });
    target.activeVariant = target.variants.length - 1;
    target.content = finalText;
    updateBubble(bubble, finalText, false);
    bubble.dataset.rawText = finalText;
    renderVariantNavigator(msgDiv, target, (idx) => {
      const variant = target.variants[idx];
      target.content = variant.text;
      bubble.dataset.rawText = variant.text;
      bubble.innerHTML = ctx.formatMessage(variant.text);
      appendMsgControls(msgDiv, variant.text, getUserPrompt);
    });
    await ctx.saveCurrentChat();
    appendMsgControls(msgDiv, finalText, getUserPrompt);
  } catch (err) {
    appendSystemMsg(`Retry error: ${err.message}`);
  } finally {
    state.streaming = false;
    retryBtn.disabled = false; retryBtn.classList.remove('loading');
  }
}


export function startRecording() {
  if (!ctx.btnMic || state.streaming) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    appendSystemMsg('Microphone recording is not supported by this browser.'); return;
  }
  navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 16000,
    }
  }).then(stream => {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    const mimeType = candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    state.mediaRecorder = recorder;
    recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    recorder.onerror = () => { stream.getTracks().forEach(t => t.stop()); resetRecordingUI(); appendSystemMsg('Microphone recording failed.'); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); resetRecordingUI();
      if (!chunks.length) { appendSystemMsg('No audio was recorded.'); return; }
      ctx.btnMic.disabled = true;
      try {
        ctx.setStatus('active', 'Transcribing…');
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = ''; const step = 0x8000;
        for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
        const result = await ctx.bridgeRequest({ action: 'stt', audio: btoa(binary), mimeType: blob.type || 'audio/webm' });
        if (!result.ok) throw new Error(result.error || 'Groq Whisper transcription failed.');
        ctx.userInput.value = result.text || ''; ctx.userInput.focus();
        ctx.setStatus('idle', `Idle — ${ctx.providerLabel(state.provider)} · ${ctx.getModel(state.provider)}`);
      } catch (err) {
        appendSystemMsg(`STT error: ${err.message}`); ctx.setStatus('error', 'Transcription failed');
      } finally { ctx.btnMic.disabled = false; }
    };
    recorder.start(500);
    ctx.btnMic.classList.add('recording'); ctx.btnMic.setAttribute('aria-label', 'Stop recording'); ctx.btnMic.title = 'Stop recording'; ctx.btnMic.innerHTML = SVG_STOP_AUDIO;
    ctx.userInput.classList.add('listening'); ctx.userInput.placeholder = 'Listening…';
  }).catch(err => appendSystemMsg(err.name === 'NotAllowedError' ? 'Microphone permission denied.' : `Microphone error: ${err.message}`));
}

export function resetRecordingUI() {
  state.mediaRecorder = null;
  ctx.btnMic.classList.remove('recording'); ctx.btnMic.setAttribute('aria-label', 'Record voice input'); ctx.btnMic.title = 'Record voice input';
  ctx.btnMic.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3M8 21h8"/></svg>';
  ctx.userInput.classList.remove('listening'); ctx.userInput.placeholder = 'Message Rex…';
}

export function stopRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') state.mediaRecorder.stop();
}

export function appendStoredAgentMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg agent';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.dataset.rawText = text;
  bubble.innerHTML = ctx.formatMessage(text);
  div.innerHTML = '<div class="msg-meta">Rex</div>';
  div.appendChild(bubble);
  ctx.chatThread.appendChild(div);
  appendMsgControls(div, text, null);
}

export function appendAgentBubble() {
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.innerHTML = `<div class="msg-meta">Rex</div><div class="msg-bubble"><span class="stream-cursor"></span></div>`;
  ctx.chatThread.appendChild(div);
  scrollBottom();
  return div.querySelector('.msg-bubble');
}

export function appendSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.innerHTML = `<div class="msg-bubble">${ctx.escHtml(text)}</div>`;
  ctx.chatThread.appendChild(div);
  scrollBottom();
}

export function appendWasmOomAlert(fileSize) {
  const sizeMB = (fileSize / 1024 / 1024).toFixed(0);
  const div = document.createElement('div');
  div.className = 'msg agent';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = `
    <div class="alert-bubble">
      <div class="alert-icon">⚠</div>
      <div class="alert-body">
        <div class="alert-title">WASM Memory Boundary Exceeded</div>
        <div>Model file is <strong>${sizeMB} MB</strong>, which exceeds the safe ~2.2 GB WebAssembly linear memory ceiling (4 GB max − KV cache allocation).</div>
        <div>The engine has automatically switched to <strong>Cloud Inference</strong> mode. Select a provider and configure your API key in ⚙ Settings.</div>
      </div>
    </div>
  `;
  div.appendChild(bubble);
  ctx.chatThread.appendChild(div);
  scrollBottom();
}

export function scrollBottom(force = false) {
  if (ctx.scrollFrame) return;
  const nearBottom = force || (ctx.chatThread.scrollHeight - ctx.chatThread.scrollTop - ctx.chatThread.clientHeight < 160);
  if (!nearBottom) return;
  ctx.scrollFrame = requestAnimationFrame(() => {
    ctx.scrollFrame = 0;
    ctx.chatThread.scrollTop = ctx.chatThread.scrollHeight;
  });
}

export function scheduleStreamRender(bubble, text) {
  ctx.pendingStreamBubble = bubble;
  ctx.pendingStreamText = text;
  if (ctx.streamFrame) return;
  ctx.streamFrame = requestAnimationFrame(() => {
    ctx.streamFrame = 0;
    if (!ctx.pendingStreamBubble) return;
    updateBubble(ctx.pendingStreamBubble, ctx.pendingStreamText, true);
    ctx.pendingStreamBubble = null;
    scrollBottom();
  });
}

