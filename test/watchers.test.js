const { test } = require('node:test');
const assert = require('node:assert');
const { extractUserText: claudeExtract } = require('../lib/claude-code-watcher');
const { extractUserText: cursorExtract } = require('../lib/cursor-watcher');
const { extractUserText: grokExtract } = require('../lib/grok-watcher');
const { extractUserText: codexExtract } = require('../lib/codex-watcher');
const { extractUserText: hermesExtract } = require('../lib/hermes-watcher');

test('claude: extracts plain user text', () => {
  assert.equal(claudeExtract({ type: 'user', message: { role: 'user', content: 'Refactor auth' } }), 'Refactor auth');
});
test('claude: skips meta/sidechain/tool-result turns', () => {
  assert.equal(claudeExtract({ type: 'user', isMeta: true, message: { role: 'user', content: 'x' } }), null);
  assert.equal(claudeExtract({ type: 'user', isSidechain: true, message: { role: 'user', content: 'x' } }), null);
  assert.equal(claudeExtract({ type: 'user', toolUseResult: true, message: { role: 'user', content: 'x' } }), null);
  assert.equal(claudeExtract({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } }), null);
});
test('claude: skips command artifacts', () => {
  assert.equal(claudeExtract({ type: 'user', message: { role: 'user', content: '<command-name>View</command-name>' } }), null);
});
test('cursor: strips timestamp and user_query wrappers', () => {
  const raw = '<timestamp>123</timestamp><user_query>Add tests for the parser</user_query>';
  assert.equal(cursorExtract({ role: 'user', message: { content: [{ type: 'text', text: raw }] } }), 'Add tests for the parser');
});
test('cursor: skips synthetic subagent follow-ups', () => {
  const entry = { role: 'user', message: { content: [{ type: 'text', text: 'Briefly inform the user about the task result' }] } };
  assert.equal(cursorExtract(entry), null);
});
test('cursor: skips bridge-injected [system] turns', () => {
  const entry = { role: 'user', message: { content: [{ type: 'text', text: '[system] You are a persona. Follow these rules.' }] } };
  assert.equal(cursorExtract(entry), null);
});
test('grok: strips user_info preamble and query wrapper', () => {
  const raw = '<user_info>system stuff</user_info><user_query>Explain quicksort</user_query>';
  assert.equal(grokExtract({ type: 'user', content: [{ type: 'text', text: raw }] }), 'Explain quicksort');
});
test('grok: strips system-reminder blocks before the query', () => {
  const raw = '<system-reminder>MCP servers connected: brain (65 tools)</system-reminder><user_info>OS: macos</user_info><user_query>Fix the sqlite migration</user_query>';
  assert.equal(grokExtract({ type: 'user', content: [{ type: 'text', text: raw }] }), 'Fix the sqlite migration');
});
test('grok: skips reminder-only turns with no typed prompt', () => {
  const raw = "<system-reminder>As you answer the user's questions, use the following context:</system-reminder>";
  assert.equal(grokExtract({ type: 'user', content: [{ type: 'text', text: raw }] }), null);
});
test('codex: extracts input_text parts, ignores assistant', () => {
  const entry = { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'Refactor db.js' }] } };
  assert.equal(codexExtract(entry), 'Refactor db.js');
  assert.equal(codexExtract({ type: 'response_item', payload: { role: 'assistant' } }), null);
});
test('hermes: extracts string content, ignores assistant', () => {
  assert.equal(hermesExtract({ role: 'user', content: 'hello vault' }), 'hello vault');
  assert.equal(hermesExtract({ role: 'assistant', content: 'hi' }), null);
});
