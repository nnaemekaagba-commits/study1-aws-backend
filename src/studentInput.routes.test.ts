import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
const { app } = await import('./server.js');

test('chat route rejects uploaded images and document references before model calls', async () => {
  for (const payload of [
    { message: 'Describe this', files: [{ type: 'image/png', content: 'data:image/png;base64,AAAA' }] },
    { message: 'Read this', documentId: 'document-1' },
    { message: 'Analyze this', imageUrl: 'https://example.test/image.jpg' },
    { message: 'old', conversationHistory: [{ content: 'old', attachments: [{ name: 'paper.pdf' }] }] },
  ]) {
    const response = await app.request('/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /attachments/);
  }
});

test('message route rejects attachment storage even with assistant role', async () => {
  for (const role of ['user', 'assistant']) {
    const response = await app.request('/messages/student-1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'm1', role, content: 'hello', timestamp: new Date().toISOString(),
        attachments: [{ name: 'paper.docx' }] }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /attachments/);
  }
});
