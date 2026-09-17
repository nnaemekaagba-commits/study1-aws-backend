import assert from 'node:assert/strict';
import test from 'node:test';
import { engineeringTools, engineeringToolNames, openAiToolDefinitions,
  googleToolDefinitions, claudeToolDefinitions, validateRequestedToolCalls } from './engineeringTools.js';

test('all eight engineering tools are declared for each provider', () => {
  assert.equal(engineeringTools.length, 8);
  assert.equal(engineeringToolNames.size, 8);
  assert.deepEqual(openAiToolDefinitions.map((item) => item.function.name), engineeringTools.map((item) => item.name));
  assert.deepEqual(googleToolDefinitions.map((item) => item.name), engineeringTools.map((item) => item.name));
  assert.deepEqual(claudeToolDefinitions.map((item) => item.name), engineeringTools.map((item) => item.name));
  assert.ok(openAiToolDefinitions.every((item) => item.function.parameters.additionalProperties === false));
  assert.ok(claudeToolDefinitions.every((item) => item.input_schema.additionalProperties === false));
});

test('provider tool requests reject unknown names, invalid IDs, and oversized arguments', () => {
  assert.equal(validateRequestedToolCalls([{ id: 'one', name: 'show_fbd', arguments: { visible: true } }]).length, 1);
  assert.throws(() => validateRequestedToolCalls([]), /count/);
  assert.throws(() => validateRequestedToolCalls([{ id: '', name: 'show_fbd', arguments: {} }]), /Invalid/);
  assert.throws(() => validateRequestedToolCalls([{ id: 'one', name: 'erase_workspace', arguments: {} }]), /Invalid/);
  assert.throws(() => validateRequestedToolCalls([{ id: 'one', name: 'show_fbd', arguments: { data: 'x'.repeat(4_001) } }]), /too large/);
});
