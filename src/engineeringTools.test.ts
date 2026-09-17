import assert from 'node:assert/strict';
import test from 'node:test';
import { engineeringTools, engineeringToolNames, openAiToolDefinitions,
  googleToolDefinitions, claudeToolDefinitions, requiresEngineeringTool, validateRequestedToolCalls } from './engineeringTools.js';

test('all engineering tools are declared for each provider', () => {
  assert.equal(engineeringTools.length, 11);
  assert.equal(engineeringToolNames.size, 11);
  assert.deepEqual(openAiToolDefinitions.map((item) => item.function.name), engineeringTools.map((item) => item.name));
  assert.deepEqual(googleToolDefinitions.map((item) => item.name), engineeringTools.map((item) => item.name));
  assert.deepEqual(claudeToolDefinitions.map((item) => item.name), engineeringTools.map((item) => item.name));
  assert.ok(openAiToolDefinitions.every((item) => item.function.parameters.additionalProperties === false));
  assert.ok(claudeToolDefinitions.every((item) => item.input_schema.additionalProperties === false));
});

test('clear structural edit requests require a function call', () => {
  assert.equal(requiresEngineeringTool('Move the 10 kN load 1 m toward B.'), true);
  assert.equal(requiresEngineeringTool('Please change support A to a fixed support.'), true);
  assert.equal(requiresEngineeringTool('Add a downward point load at 3 m.'), true);
  assert.equal(requiresEngineeringTool('How do I move a load?'), false);
  assert.equal(requiresEngineeringTool('Explain beam reactions.'), false);
});

test('provider tool requests reject unknown names, invalid IDs, and oversized arguments', () => {
  assert.equal(validateRequestedToolCalls([{ id: 'one', name: 'show_fbd', arguments: { visible: true } }]).length, 1);
  assert.throws(() => validateRequestedToolCalls([]), /count/);
  assert.throws(() => validateRequestedToolCalls([{ id: '', name: 'show_fbd', arguments: {} }]), /Invalid/);
  assert.throws(() => validateRequestedToolCalls([{ id: 'one', name: 'erase_workspace', arguments: {} }]), /Invalid/);
  assert.throws(() => validateRequestedToolCalls([{ id: 'one', name: 'show_fbd', arguments: { data: 'x'.repeat(4_001) } }]), /too large/);
});
