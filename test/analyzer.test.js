const { test } = require('node:test');
const assert = require('node:assert');
const { analyzePrompt, findRepetitivePhrases, train, modelInfo, generateOptimalPrompt } = require('../analyzer');

test('empty prompt -> skip', () => {
  assert.equal(analyzePrompt('   ').verdict, 'skip');
});

test('vague filler -> skip', () => {
  assert.equal(analyzePrompt('fix it').verdict, 'skip');
  assert.equal(analyzePrompt('yes').verdict, 'skip');
});

test('specific structured prompt scores save-tier', () => {
  const text = ['## Goal', 'Refactor the auth middleware in src/middleware/auth.js to add rate limiting.', '', '## Context', 'We use Express 4 and a Redis store. There is currently no limit on login attempts.', '', '## Requirements', '- Must not break existing tests', '- Should return 429 with a Retry-After header', '- Avoid blocking health checks', '', '## Example', '```js', 'const limiter = rateLimit({ windowMs: 60000, max: 100 });', '```'].join('\n');
  const a = analyzePrompt(text);
  assert.ok(a.score >= 65, 'expected save-tier score, got ' + a.score);
  assert.equal(a.verdict, 'save');
});

test('findRepetitivePhrases accepts strings (db.allTexts shape)', () => {
  const texts = [
    'The quick brown fox jumps over the lazy dog in the park',
    'The quick brown fox swims across the river in the park',
    'A red fox jumps quickly near the park bench'
  ];
  const fromStrings = findRepetitivePhrases(texts);
  const fromObjects = findRepetitivePhrases(texts.map(t => ({ text: t })));
  assert.deepEqual(fromStrings, fromObjects);
  assert.ok(fromStrings.length >= 1, 'expected repeated phrases from string input');
  assert.ok(fromStrings.some(p => p.phrase === 'quick brown fox'));
});

test('train builds a usable model', () => {
  const m = train([
    { text: 'Refactor the auth middleware to add rate limiting with a Redis store', label: 'good' },
    { text: 'fix it', label: 'bad' },
    { text: 'Add pagination to the users endpoint and a regression test', label: 'good' }
  ]);
  assert.ok(m.totalGood >= 2);
  assert.ok(m.totalBad >= 1);
  assert.ok(modelInfo().tokens > 0);
});

test('generateOptimalPrompt handles empty vault', () => {
  const r = generateOptimalPrompt([]);
  assert.ok(r.insights.length >= 1);
  assert.equal(r.template, '');
});
