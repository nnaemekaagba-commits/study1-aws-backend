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
  for (const action of ['structure_view', 'fbd_view', 'split_view']) {
    assert.equal(validateResearchEvent({ ...event, action }).kind, 'visualization');
  }
  const emptyFbd = { version: 1, sourceStructureKey: 'structure-1', selectedTarget: null,
    forces: [], moments: [], dimensions: [], angles: [], labels: [] };
  const withForce = { ...emptyFbd, forces: [{ id: 'force-1', at: { x: 1, y: 0 },
    angle: -90, label: 'P' }] };
  assert.equal(validateResearchEvent({ ...event, action: 'fbd_undo',
    fbdBefore: withForce, fbdAfter: emptyFbd }).kind, 'visualization');
  assert.equal(validateResearchEvent({ ...event, action: 'fbd_redo',
    fbdBefore: emptyFbd, fbdAfter: withForce }).kind, 'visualization');
  const selectedEmpty = { ...emptyFbd, selectedTarget: { kind: 'member', id: 'AB' } };
  const selectedWithForce = { ...withForce, selectedTarget: selectedEmpty.selectedTarget };
  assert.equal(validateResearchEvent({ ...event, action: 'fbd_reset',
    fbdBefore: selectedWithForce, fbdAfter: selectedEmpty }).kind, 'visualization');
  assert.throws(() => validateResearchEvent({ ...event, action: 'fbd_reset' }), /FBD history/);
  assert.throws(() => validateResearchEvent({ ...event, action: 'fbd_reset',
    fbdBefore: selectedWithForce, fbdAfter: selectedWithForce }), /FBD history/);
  assert.throws(() => validateResearchEvent({ ...event, action: 'fbd_reset',
    fbdBefore: selectedWithForce, fbdAfter: emptyFbd }), /FBD reset/);
  assert.throws(() => validateResearchEvent({ ...event, action: 'fbd_reset',
    fbdBefore: selectedEmpty, fbdAfter: emptyFbd }), /FBD reset/);
  assert.throws(() => validateResearchEvent({ ...event, action: 'fbd_undo' }), /FBD history/);
  assert.throws(() => validateResearchEvent({ ...event, action: 'fbd_undo',
    fbdBefore: emptyFbd, fbdAfter: emptyFbd }), /FBD history/);
  assert.equal(validateResearchEvent({ ...event, action: 'fbd_select',
    target: { kind: 'member', id: 'AB' } }).kind, 'visualization');
  assert.throws(() => validateResearchEvent({ ...event, action: 'fbd_select' }), /FBD selection/);
  const forceEvent = { ...event, action: 'fbd_force_add', force: { id: 'force-1',
    at: { x: 2, y: 0 }, angle: -90, label: 'P', magnitude: 10 } };
  assert.equal(validateResearchEvent(forceEvent).kind, 'visualization');
  assert.throws(() => validateResearchEvent({ ...forceEvent, force: undefined }), /FBD force/);
  assert.throws(() => validateResearchEvent({ ...forceEvent, force: { ...forceEvent.force, angle: Infinity } }), /FBD force/);
  const momentEvent = { ...event, action: 'fbd_moment_add', moment: { id: 'moment-1',
    at: { x: 2, y: 0 }, clockwise: false, label: 'M', magnitude: 5 } };
  assert.equal(validateResearchEvent(momentEvent).kind, 'visualization');
  assert.throws(() => validateResearchEvent({ ...momentEvent, moment: undefined }), /FBD moment/);
  assert.throws(() => validateResearchEvent({ ...momentEvent,
    moment: { ...momentEvent.moment, clockwise: 'yes' } }), /FBD moment/);
  const dimensionEvent = { ...event, action: 'fbd_dimension_add', dimension: { id: 'dimension-1',
    start: { x: 0, y: 0 }, end: { x: 2, y: 0 }, label: '2 m' } };
  assert.equal(validateResearchEvent(dimensionEvent).kind, 'visualization');
  assert.throws(() => validateResearchEvent({ ...dimensionEvent, dimension: undefined }), /FBD dimension/);
  assert.throws(() => validateResearchEvent({ ...dimensionEvent,
    dimension: { ...dimensionEvent.dimension, end: { x: 0, y: 0 } } }), /FBD dimension/);
  const angleEvent = { ...event, action: 'fbd_angle_add', angle: { id: 'angle-1',
    vertex: { x: 0, y: 0 }, from: { x: 1, y: 0 }, to: { x: 0, y: 1 }, label: '30°' } };
  assert.equal(validateResearchEvent(angleEvent).kind, 'visualization');
  assert.throws(() => validateResearchEvent({ ...angleEvent, angle: undefined }), /FBD angle/);
  assert.throws(() => validateResearchEvent({ ...angleEvent,
    angle: { ...angleEvent.angle, to: { x: 2, y: 0 } } }), /FBD angle/);
  const labelEvent = { ...event, action: 'fbd_label_add', label: { id: 'label-1',
    at: { x: 1, y: 2 }, text: 'R_A', associatedWith: { kind: 'node', id: 'A' } } };
  assert.equal(validateResearchEvent(labelEvent).kind, 'visualization');
  assert.equal(validateResearchEvent({ ...labelEvent, action: 'fbd_label_move' }).kind, 'visualization');
  assert.throws(() => validateResearchEvent({ ...labelEvent, label: undefined }), /FBD label/);
  assert.throws(() => validateResearchEvent({ ...labelEvent,
    label: { ...labelEvent.label, associatedWith: { kind: 'force', id: '' } } }), /FBD label/);
  const change = { ...event, action: 'fbd_element_edit', elementKind: 'force', elementId: 'force-1',
    before: forceEvent.force, after: { ...forceEvent.force, magnitude: 8, angle: -45 } };
  assert.equal(validateResearchEvent(change).kind, 'visualization');
  assert.equal(validateResearchEvent({ ...change, action: 'fbd_element_delete', after: null }).kind, 'visualization');
  assert.throws(() => validateResearchEvent({ ...change, before: undefined }), /FBD element change/);
  assert.throws(() => validateResearchEvent({ ...change, after: null }), /FBD element change/);
  assert.throws(() => validateResearchEvent({ ...change, action: 'fbd_element_delete' }), /FBD element change/);
  const drag = { ...change, action: 'fbd_element_drag', dragTarget: 'label',
    after: { ...forceEvent.force, labelPosition: { x: 3, y: 2 } } };
  assert.equal(validateResearchEvent(drag).kind, 'visualization');
  assert.equal(validateResearchEvent({ ...drag, action: 'fbd_element_reposition' }).kind, 'visualization');
  assert.equal(validateResearchEvent({ ...drag, dragTarget: 'application',
    after: { ...forceEvent.force, at: { x: 3, y: 0 } } }).kind, 'visualization');
  assert.throws(() => validateResearchEvent({ ...drag, dragTarget: undefined }), /FBD element change/);
  assert.throws(() => validateResearchEvent({ ...drag, elementKind: 'moment', dragTarget: 'application' }), /FBD element change/);
  assert.throws(() => validateResearchEvent({ ...drag,
    after: { ...forceEvent.force, labelPosition: { x: Infinity, y: 2 } } }), /FBD element change/);
});

test('research events persist independently of chat messages', async () => {
  await saveResearchEvent('research-test-user', validateResearchEvent(toolEvent));
  const events = await listResearchEvents('research-test-user');
  assert.equal(events.find((event) => event.eventId === 'event-1')?.kind, 'tool');
});
