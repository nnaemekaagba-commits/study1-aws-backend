import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeRecordedWav, rejectChatAttachments, studentAttachmentError } from './studentInput.js';

test('chat accepts typed and transcribed text without attachments', () => {
  assert.equal(rejectChatAttachments(undefined), false);
  assert.equal(rejectChatAttachments([]), false);
  assert.equal(studentAttachmentError({ message: 'Move the load', files: [] }, true), null);
  assert.equal(studentAttachmentError({ message: 'Transcribed speech', inputModality: 'audio' }, true), null);
});

test('chat rejects image, PDF, document, text, and spreadsheet uploads', () => {
  for (const type of ['image/png', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/csv']) {
    assert.equal(rejectChatAttachments([{ name: 'file', type, content: 'x' }]), true);
  }
  assert.equal(rejectChatAttachments({ name: 'bypass' }), true);
  for (const field of ['attachments', 'imageUrl', 'documentId', 'fileUrl', 'upload']) {
    assert.match(studentAttachmentError({ message: 'hello', [field]: 'reference' }, true) || '', /attachments/);
  }
  assert.match(studentAttachmentError({ message: 'hello', conversationHistory: [{ role: 'user', content: 'old', attachments: [{ type: 'image/png' }] }] }, true) || '', /attachments/);
  assert.match(studentAttachmentError({ message: { type: 'image_url', url: 'https://example.test/a.png' } }, true) || '', /attachments/);
  assert.match(studentAttachmentError({ content: 'data:image/png;base64,AAAA' }) || '', /attachments/);
  assert.match(studentAttachmentError({ role: 'assistant', content: 'generated', attachments: [{ generated: true }] }, false, false) || '', /attachments/);
  assert.equal(studentAttachmentError({ role: 'assistant', content: '![generated](data:image/png;base64,AAAA)' }, false, false), null);
});

test('recording endpoint accepts only a WAV recording', () => {
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0); wav.write('WAVE', 8);
  assert.deepEqual(decodeRecordedWav(`data:audio/wav;base64,${wav.toString('base64')}`), wav);
  assert.equal(decodeRecordedWav('data:image/png;base64,AAAA'), null);
  assert.equal(decodeRecordedWav('data:application/pdf;base64,AAAA'), null);
});
