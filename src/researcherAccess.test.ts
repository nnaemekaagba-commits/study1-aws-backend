import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { isResearcherUserId, validReplayStudentId } from './researcherAccess.js';

process.env.NODE_ENV = 'test';
process.env.MESSAGES_TABLE = '';
const { listResearchEvents, saveResearchEvent } = await import('./researchEvents.js');
const { app } = await import('./server.js');

test('researcher access uses server provisioned account IDs', () => {
  assert.equal(isResearcherUserId('researcher-id', 'student-id,researcher-id'), true);
  assert.equal(isResearcherUserId('student-id', 'researcher-id'), false);
  assert.equal(isResearcherUserId('researcher-id', ''), false);
  assert.equal(validReplayStudentId('a'.repeat(32)), true);
  assert.equal(validReplayStudentId('student@example.com'), false);
});

test('replay endpoint is researcher-only, read-only, and returns one student history', async () => {
  const signup = async (role: string) => {
    const response = await app.request('/signup', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${role}-${randomUUID()}@example.test`,
        password: 'test-password', name: role }) });
    assert.equal(response.status, 200);
    return await response.json() as { access_token: string; user: { id: string } };
  };
  const researcher = await signup('researcher');
  const student = await signup('student');
  const oldAllowlist = process.env.RESEARCHER_USER_IDS;
  process.env.RESEARCHER_USER_IDS = researcher.user.id;
  try {
    const state = { version: 1 as const, sourceStructureKey: 'structure-1',
      selectedTarget: { kind: 'body' as const, id: 'structure' },
      forces: [], moments: [], dimensions: [], angles: [], labels: [] };
    const saved = { kind: 'fbd_tool' as const, eventId: randomUUID(),
      sessionId: 'replay-session', timestamp: '2026-09-20T12:00:00.000Z',
      studentMessage: 'Select the whole body', toolName: 'fbd_select_object',
      toolArguments: { kind: 'body', id: 'structure' }, stateBefore: state, stateAfter: state,
      aiResponse: 'Selected.', succeeded: true };
    await saveResearchEvent(student.user.id, saved);
    const path = `/researcher/fbd-events/${student.user.id}`;
    assert.equal((await app.request(path)).status, 401);
    assert.equal((await app.request('/researcher/me', {
      headers: { Authorization: `Bearer ${student.access_token}` } })).status, 403);
    assert.equal((await app.request(path, {
      headers: { Authorization: `Bearer ${student.access_token}` } })).status, 403);
    const response = await app.request(path, {
      headers: { Authorization: `Bearer ${researcher.access_token}` } });
    assert.equal(response.status, 200);
    const data = await response.json() as { events: typeof saved[]; structureEvents: unknown[] };
    assert.deepEqual(data.events.map((event) => event.eventId), [saved.eventId]);
    assert.deepEqual(data.structureEvents, []);
    assert.equal((await app.request('/researcher/fbd-events/not-an-id', {
      headers: { Authorization: `Bearer ${researcher.access_token}` } })).status, 400);
    assert.equal((await listResearchEvents(student.user.id)).length, 1);
  } finally {
    if (oldAllowlist === undefined) delete process.env.RESEARCHER_USER_IDS;
    else process.env.RESEARCHER_USER_IDS = oldAllowlist;
  }
});
