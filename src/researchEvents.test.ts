import assert from 'node:assert/strict';
import test from 'node:test';
import { listResearchEvents, saveResearchEvent, validateResearchEvent } from './researchEvents.js';

const state = { nodes: [], members: [], supports: [], loads: [], dimensions: [], units: { length: 'm', force: 'kN' } };
const toolEvent = {
  kind: 'tool', eventId: 'event-1', sessionId: 'session-1', timestamp: '2026-09-17T12:00:00.000Z',
  studentMessage: 'Move the load', toolName: 'move_load', toolArguments: { loadId: 'load-C', position: 3 },
  stateBefore: state, stateAfter: state, solverResult: { reactions: [] },
  aiResponse: 'Moved the load.', succeeded: true,
};

test('research tool events require snapshots, outcome, and session metadata', () => {
  assert.equal(validateResearchEvent(toolEvent).kind, 'tool');
  assert.throws(() => validateResearchEvent({ ...toolEvent, stateAfter: null }), /Invalid engineering tool/);
  assert.throws(() => validateResearchEvent({ ...toolEvent, succeeded: 'yes' }), /Invalid engineering tool/);
  assert.throws(() => validateResearchEvent({ ...toolEvent, sessionId: '' }), /metadata/);
});

test('visualization events are distinct and validate their action', () => {
  const event = { kind: 'visualization', eventId: 'view-1', sessionId: 'session-1',
    timestamp: '2026-09-17T12:00:01.000Z', action: 'front' };
  assert.equal(validateResearchEvent(event).kind, 'visualization');
  assert.throws(() => validateResearchEvent({ ...event, action: 'change_load' }), /visualization action/);
  assert.equal(validateResearchEvent({ ...event, action: 'fbd_enter' }).kind, 'visualization');
  assert.equal(validateResearchEvent({ ...event, action: 'fbd_exit' }).kind, 'visualization');
  assert.equal(validateResearchEvent({ ...event, action: 'fbd_select',
    target: { kind: 'member', id: 'AB' } }).kind, 'visualization');
  assert.throws(() => validateResearchEvent({ ...event, action: 'fbd_select' }), /FBD selection/);
});

test('research events persist independently of chat messages', async () => {
  await saveResearchEvent('research-test-user', validateResearchEvent(toolEvent));
  const events = await listResearchEvents('research-test-user');
  assert.equal(events.find((event) => event.eventId === 'event-1')?.kind, 'tool');
});
