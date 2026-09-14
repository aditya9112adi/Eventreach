import fs from 'fs';

/**
 * Identify a file from its own bytes.
 *
 * The MIME type multer reports comes from the browser's Content-Type on the
 * upload part, which is entirely caller-controlled: renaming evil.exe to
 * photo.png and declaring image/png passes a MIME-only check. This reads the
 * actual magic numbers instead, and the upload endpoint refuses anything
 * whose contents disagree with what it claims to be.
 *
 * Only the five types WhatsApp accepts here are recognised; anything else
 * returns null and is rejected rather than guessed at.
 */

/** Bytes needed to recognise the longest signature we check. */
const HEADER_BYTES = 16;

const startsWith = (buf: Buffer, bytes: number[], offset = 0): boolean =>
  bytes.every((b, i) => buf[offset + i] === b);

export const sniffMimeFromBuffer = (buf: Buffer): string | null => {
  if (buf.length < 4) return null;

  // JPEG: FF D8 FF
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';

  // PDF: "%PDF-"
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';

  // MP4 / ISO base media: bytes 4-7 are "ftyp".
  if (buf.length >= 12 && startsWith(buf, [0x66, 0x74, 0x79, 0x70], 4)) return 'video/mp4';

  // MP3: either an ID3 tag ("ID3") or a raw MPEG frame sync (FF Ex/Fx).
  if (startsWith(buf, [0x49, 0x44, 0x33])) return 'audio/mpeg';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';

  return null;
};

/** Reads only the header, never the whole file, and never logs its contents. */
export const sniffMimeFromFile = async (filePath: string): Promise<string | null> => {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEADER_BYTES, 0);
    return sniffMimeFromBuffer(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
};
