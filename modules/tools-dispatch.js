import { state } from './state.js';
import { ctx, $ } from './ctx.js';
import { assessRisk } from './command-risk.js';
import { logEvent } from './debug.js';
import { computeDiff, renderDiffHtml } from './diff.js';
import { escHtml } from './markdown.js';
import { applyMemoryChanges } from './memory.js';
import { renderRiskCard } from './risk.js';
import { sendCommand, bridgeRequest } from './ws.js';
import { idbPut } from './db.js';
import { readFile, writeFile } from './workspace-ui.js';
import { exaSearch } from './exa.js';
import { renderGeneratedImage } from './messages.js';

export async function dispatchTool(toolName, args) {
  try { ctx.logEvent('tool_call', { name: toolName, args }); } catch (_) {}
  switch (toolName) {
    case 'terminal': {
      const cmd = args.command || '';
      if (!cmd) return { error: 'No command specified.' };
      const risk = assessRisk(cmd);
      const result = await ctx.renderRiskCard(cmd, risk);
      return result;
    }
    case 'read_file': {
      try {
        const content = await ctx.readFile(args.path);
        return { content };
      } catch (e) { return { error: e.message }; }
    }
    case 'write_file': {
      try {
        let before = '';
        try { before = await ctx.readFile(args.path); } catch (_) { before = ''; }
        await ctx.writeFile(args.path, args.content || '');
        const diff = ctx.computeDiff(before, args.content || '');
        return { success: true, diff };
      } catch (e) { return { error: e.message }; }
    }
    case 'web_search': {
      if (!state.exaEnabled) return { error: 'Exa web search is disabled. Turn on Exa search in the toolbar.' };
      try {
        const results = await ctx.exaSearch(args.query);
        return { results };
      } catch (e) { return { error: e.message }; }
    }
    case 'update_memory': {
      const nextMemory = applyMemoryChanges(state.memory, args || {});
      if (nextMemory === state.memory) return { success: true, changed: false, memory: nextMemory };
      state.memory = nextMemory;
      await ctx.idbPut('settings', 'memory', state.memory);
      const editor = $('setting-memory');
      if (editor && !editor.matches(':focus')) editor.value = state.memory;
      const status = $('memory-status');
      if (status) status.textContent = 'Memory updated by Rex and saved locally.';
      return { success: true, changed: true, memory: state.memory, entries: state.memory ? state.memory.split('\n').length : 0 };
    }
    case 'generate_image': {
      if (!state.remoteMode && !state.wsConnected) return { error: 'BackEnd not connected' };
      try {
        const result = await ctx.bridgeRequest({ action: 'generate_image', prompt: args.prompt, model: args.model || state.apiKeys.pollinationsModel || 'flux', width: args.width || 1024, height: args.height || 1024 });
        if (!result?.ok) return { error: result?.error || 'Image generation failed.' };
        const imageUrl = new URL(result.url, location.origin).href;
        ctx.renderGeneratedImage(imageUrl, args.prompt || 'Generated image');
        return { image_url: imageUrl, model: result.model, width: result.width, height: result.height };
      } catch (e) { return { error: e.message }; }
    }
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

