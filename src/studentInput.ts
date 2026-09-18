export function rejectChatAttachments(files: unknown): boolean {
  return files !== undefined && (!Array.isArray(files) || files.length > 0);
}

const ATTACHMENT_KEYS = new Set([
  'file', 'files', 'attachments', 'attachment', 'attachmentId', 'attachmentIds',
  'image', 'images', 'imageUrl', 'imageUrls', 'document', 'documents', 'documentId',
  'documentIds', 'documentUrl', 'documentUrls', 'fileId', 'fileIds', 'fileUrl',
  'fileUrls', 'upload', 'uploads', 'inputFiles',
]);

function hasInputReference(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).some(([key, entry]) =>
    ATTACHMENT_KEYS.has(key) && entry !== undefined && entry !== null &&
    !(Array.isArray(entry) && entry.length === 0));
}

function containsInlineAttachment(text: unknown): boolean {
  if (text === undefined || text === null) return false;
  return typeof text !== 'string' || /data:(?:image\/|application\/(?:pdf|octet-stream))/i.test(text) ||
    /<\s*(?:img|object|embed)\b/i.test(text);
}

export function studentAttachmentError(payload: unknown, includeHistory = false,
  checkContent = true): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'Invalid message body';
  const body = payload as Record<string, unknown>;
  if (hasInputReference(body) || (checkContent && containsInlineAttachment(body.message ?? body.content))) {
    return 'Student attachments and document/image inputs are disabled. Use text or voice transcription.';
  }
  if (includeHistory && Array.isArray(body.conversationHistory) && body.conversationHistory.some((item) =>
    hasInputReference(item) || containsInlineAttachment((item as Record<string, unknown>)?.content))) {
    return 'Student attachments and document/image inputs are disabled. Use text or voice transcription.';
  }
  return null;
}

export function decodeRecordedWav(audio: unknown): Buffer | null {
  if (typeof audio !== 'string' || !/^data:audio\/(?:wav|x-wav|wave);base64,/.test(audio)) return null;
  const encoded = audio.slice(audio.indexOf(',') + 1);
  if (!encoded || encoded.length > 8_100_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 44 || bytes.length > 6_000_000 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  return bytes;
}
