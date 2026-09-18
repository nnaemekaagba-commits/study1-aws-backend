export function rejectChatAttachments(files: unknown): boolean {
  return files !== undefined && (!Array.isArray(files) || files.length > 0);
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
