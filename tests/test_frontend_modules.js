/**
 * Frontend unit tests for Rex AI.
 * Failures print a short reason — not a dump of the whole source file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseApiKeyText, loadApiKeySchema, getApiKeyAliases } from '../modules/api-keys.js';
import { assessRisk, loadTerminalBlocklist, isBlockedCommand } from '../modules/command-risk.js';
import { escHtml, formatMessage } from '../modules/markdown.js';
import { findChatMatches, formatChatExport, chatExportFilename } from '../modules/chat-utils.js';
import { normalizeMemory } from '../modules/memory.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function src(rel) {
  return readFile(resolve(root, rel), 'utf8');
}

/** Assert source contains a pattern; on fail show a one-line hint, not the whole file. */
function assertSrcHas(source, pattern, hint) {
  const ok = pattern.test(source);
  if (!ok) {
    assert.fail(hint || `Expected pattern not found: ${pattern}`);
  }
}

await loadApiKeySchema();
await loadTerminalBlocklist();


/* ── Pure module behavior ───────────────────────────────────── */

test('API key parser handles aliases and values with colons', () => {
  assert.deepEqual(parseApiKeyText('GroqCloud: gsk:abc\nOpenRouter model: openai/example'), {
    groq: 'gsk:abc',
    openrouterModel: 'openai/example',
  });
});

test('API key parser supports next-line values and ignores comments', () => {
  assert.deepEqual(parseApiKeyText('# comment\nGemini:\nAIzaExample'), { gemini: 'AIzaExample' });
});

test('API key parser matches shared fixture samples', async () => {
  const fixtures = JSON.parse(await src('tests/fixtures/api_keys_samples.json'));
  for (const sample of fixtures.samples) {
    assert.deepEqual(
      parseApiKeyText(sample.input),
      sample.expected,
      `Fixture "${sample.name}" did not parse as expected`,
    );
  }
});

test('shared api_keys_schema.json loads expected aliases', () => {
  const aliases = getApiKeyAliases();
  assert.ok(aliases, 'Schema aliases were not loaded');
  assert.equal(aliases.groq, 'groq');
  assert.equal(aliases['open router'], 'openrouter');
  assert.equal(aliases['pollinations model'], 'pollinationsModel');
});

test('command risk: blocks destructive, allows listing', () => {
  assert.equal(assessRisk('diskpart').level, 'blocked');
  assert.equal(assessRisk('Get-ChildItem').level, 'low');
});

test('command risk: high / medium / low levels', () => {
  assert.equal(assessRisk('rm -rf ./build').level, 'high');
  assert.equal(assessRisk('Remove-Item -Recurse ./out').level, 'high');
  assert.equal(assessRisk('del notes.txt').level, 'medium');
  assert.equal(assessRisk('git status').level, 'low');
});

test('markdown escapes HTML and renders bold', () => {
  assert.equal(escHtml('<script>'), '&lt;script&gt;');
  assert.match(formatMessage('**hello**'), /<strong>hello<\/strong>/);
  assert.doesNotMatch(formatMessage('<script>alert(1)</script>'), /<script>/);
});

test('markdown renders bullet lists from mixed markers', () => {
  const rendered = formatMessage(
    'Intro: * **Adam (AS)** is first. * **Judaism** follows Isaac.\\n* **Islam** follows Ishmael.',
  );
  assert.match(rendered, /<ul>[\s\S]*<li><strong>Adam \(AS\)<\/strong> is first\.<\/li>/);
  assert.match(rendered, /<li><strong>Judaism<\/strong> follows Isaac\.<\/li>/);
  assert.match(rendered, /<li><strong>Islam<\/strong> follows Ishmael\.<\/li>/);
});

test('chat search finds matches and snippets', () => {
  const chats = [
    { id: 'a', title: 'Test', messages: [{ role: 'user', content: 'Needle in a haystack' }] },
    { id: 'b', messages: [{ content: 'other' }] },
  ];
  const matches = findChatMatches(chats, 'NEEDLE');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].chat.id, 'a');
  assert.match(matches[0].snippet, /Needle/);
});

test('chat export builds JSON/Markdown and safe filenames', () => {
  const chat = {
    id: 'chat1',
    title: 'My chat!',
    updatedAt: 0,
    messages: [{ role: 'user', content: 'Hi' }],
  };
  assert.match(formatChatExport(chat, 'md', 'model-x'), /\*\*You:\*\*/);
  assert.equal(JSON.parse(formatChatExport(chat, 'json', 'model-x')).id, 'chat1');
  assert.equal(chatExportFilename('My chat!', 'md'), 'My-chat-.md');
});

test('memory normalization deduplicates and limits entries', () => {
  const normalized = normalizeMemory('alpha\nalpha\nbeta\n\n  \ngamma');
  assert.equal(normalized, 'alpha\nbeta\ngamma');
});

/* ── Architecture / wiring (look in the right module files) ─── */

test('ESBuild configuration bundles the modular source entry', async () => {
  const pkg = JSON.parse(await src('package.json'));
  assert.ok(pkg.devDependencies?.esbuild, 'ESBuild should be a development dependency');
  assert.match(pkg.scripts?.build || '', /esbuild modules\/main\.js --bundle/,
    'build script should bundle modules/main.js');
  assert.match(pkg.scripts?.build || '', /--outfile=dist\/app\.js/,
    'build script should output dist/app.js');
});

test('entry is modular: main.js + app.js + domain modules exist', async () => {
  const html = await src('index.html');
  assertSrcHas(
    html,
    /<script\s+type="module"(?:\s+defer)?\s+src="dist\/app\.js"><\/script>/,
    'index.html should load the ESBuild bundle dist/app.js as a module',
  );
  for (const file of [
    'modules/main.js',
    'modules/app.js',
    'modules/chats.js',
    'modules/messages.js',
    'modules/send.js',
    'modules/state.js',
    'modules/db.js',
    'modules/ws.js',
    'modules/providers.js',
    'modules/tools.js',
    'modules/ui.js',
    'modules/memory.js',
    'modules/attachments.js',
    'modules/risk.js',
    'modules/infer.js',
  ]) {
    await access(resolve(root, file));
  }
  await assert.rejects(access(resolve(root, 'app.js')), 'legacy root app.js should not exist');
});

test('stream render cancels pending frame before final Markdown (messages.js)', async () => {
  const messages = await src('modules/messages.js');
  assertSrcHas(
    messages,
    /if \(ctx\.streamFrame\) \{\s*cancelAnimationFrame\(ctx\.streamFrame\);\s*ctx\.streamFrame = 0;/,
    'messages.js updateBubble should cancel ctx.streamFrame before final render',
  );
  assertSrcHas(
    messages,
    /if \(ctx\.pendingStreamBubble === bubble\)/,
    'messages.js should clear pendingStreamBubble after final render',
  );
  assertSrcHas(
    messages,
    /bubble\.innerHTML = (?:ctx\.)?formatMessage\(text\)/,
    'messages.js should format Markdown on final bubble render',
  );
});

test('startup warns if backend is offline after 3s (main.js)', async () => {
  const main = await src('modules/main.js');
  assertSrcHas(
    main,
    /setTimeout\(\(\) => \{[\s\S]*?if \(!state\.wsConnected && !state\.remoteMode\) appendSystemMsg\('BackEnd not connected'\);[\s\S]*?\}, 3000\)/,
    'main.js init should warn "BackEnd not connected" after 3 seconds when offline',
  );
});

test('memory tool and prompt text are wired (identity + tools)', async () => {
  const identity = await src('modules/identity.js');
  const tools = await src('modules/tools.js');
  const dispatch = await src('modules/tools-dispatch.js');
  assertSrcHas(
    identity,
    /USER MEMORY \(user-editable, saved locally/,
    'identity.js system prompt should mention USER MEMORY',
  );
  assertSrcHas(tools, /name:\s*'update_memory'/, 'tools.js should define update_memory');
  assertSrcHas(dispatch, /case 'update_memory'/, 'tools-dispatch.js should handle update_memory');
});

test('new-chat startup messages live in chats.js', async () => {
  const chats = await src('modules/chats.js');
  assertSrcHas(
    chats,
    /export function showNewChatStartupMessages\(\)\s*\{/,
    'chats.js should export showNewChatStartupMessages',
  );
  assertSrcHas(
    chats,
    /if \(!state\.isNewChat \|\| !state\.chatId \|\| state\.startupMessagesChatId === state\.chatId\) return;/,
    'showNewChatStartupMessages should no-op when already shown for this chat',
  );
});

test('chat URL routing helpers live in chats.js + HTML', async () => {
  const chats = await src('modules/chats.js');
  const html = await src('index.html');
  const main = await src('modules/main.js');
  assertSrcHas(
    chats,
    /export function chatPath\(id\) \{ return `\/c\/\$\{encodeURIComponent\(String\(id\)\)\}`; \}/,
    'chats.js should export chatPath(/c/:id)',
  );
  assertSrcHas(chats, /export function chatIdFromPath/, 'chats.js should export chatIdFromPath');
  assertSrcHas(chats, /const requestedChat = requestedId \? chats\.find/, 'openChatFromUrl should resolve requested chat');
  const controls = await src('modules/chat-controls.js');
  const app = await src('modules/app.js');
  const hasPopstate = /popstate/.test(main) || /popstate/.test(controls) || /popstate/.test(app) || /popstate/.test(chats);
  if (!hasPopstate) {
    assert.fail('Expected a popstate listener in main.js, app.js, chats.js, or chat-controls.js');
  }
  assertSrcHas(html, /id="chat-uid"/, 'index.html needs #chat-uid');
  assertSrcHas(html, /id="copy-chat-link"/, 'index.html needs #copy-chat-link');
  assertSrcHas(html, /<base href="\/">/, 'index.html needs <base href="/">');
});

test('chat titles use free OpenRouter Llama model (chats.js + send.js)', async () => {
  const chats = await src('modules/chats.js');
  const send = await src('modules/send.js');
  assertSrcHas(
    chats,
    /CHAT_TITLE_MODEL = 'meta-llama\/llama-3\.1-8b-instruct:free'/,
    'chats.js should define CHAT_TITLE_MODEL as meta-llama/llama-3.1-8b-instruct:free',
  );
  assertSrcHas(
    send,
    /generateChatTitle/,
    'send.js should call generateChatTitle on the first user message',
  );
  assertSrcHas(
    chats,
    /Create a concise title for a chat based ONLY on the user/,
    'generateChatTitle prompt should ask for a concise title from the first message',
  );
  assertSrcHas(chats, /titleGenerated/, 'chats.js should track titleGenerated');
  assertSrcHas(chats, /titleManuallySet/, 'chats.js should track titleManuallySet');
});

test('send UI binds after app context initialization and accepts image-only prompts', async () => {
  const send = await src('modules/send.js');
  const app = await src('modules/app.js');
  assert.match(send, /if \(\(!text && !hasImage\) \|\| state\.streaming\) return;/);
  assert.match(send, /export function bindSendUI\(\)/);
  assert.match(app, /bindSendUI\(\);[\s\S]*bindWorkspaceUI\(\);/);
  assert.doesNotMatch(send, /ctx\.btnSend\.addEventListener/);
});

test('chat controls do not bind ctx listeners during module evaluation', async () => {
  const controls = await src('modules/chat-controls.js');
  assert.doesNotMatch(controls.slice(0, controls.indexOf('export async function exportCurrentChat')), /ctx\.btnNewChat\.addEventListener|ctx\.btnChatHistory\.addEventListener/);
  assert.match(controls, /setConversationHistory\(/);
});


test('shared terminal blocklist blocks the same destructive commands as Python', () => {
  assert.equal(isBlockedCommand('diskpart'), true);
  assert.equal(isBlockedCommand('rm -rf /'), true);
  assert.equal(isBlockedCommand('bcdedit /enum'), true);
  assert.equal(isBlockedCommand('echo hello'), false);
  assert.equal(assessRisk('diskpart').level, 'blocked');
});
