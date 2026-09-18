import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeRecordedWav, rejectChatAttachments } from './studentInput.js';

test('chat accepts typed and transcribed text without attachments', () => {
  assert.equal(rejectChatAttachments(undefined), false);
  assert.equal(rejectChatAttachments([]), false);
});

test('chat rejects image, PDF, document, text, and spreadsheet uploads', () => {
  for (const type of ['image/png', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/csv']) {
    assert.equal(rejectChatAttachments([{ name: 'file', type, content: 'x' }]), true);
  }
  assert.equal(rejectChatAttachments({ name: 'bypass' }), true);
});

test('recording endpoint accepts only a WAV recording', () => {
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0); wav.write('WAVE', 8);
  assert.deepEqual(decodeRecordedWav(`data:audio/wav;base64,${wav.toString('base64')}`), wav);
  assert.equal(decodeRecordedWav('data:image/png;base64,AAAA'), null);
  assert.equal(decodeRecordedWav('data:application/pdf;base64,AAAA'), null);
});
