/**
 * Read transcript files: only ever opened read-only, read from a byte offset in bounded batches that end at a
 * newline. Bytes after the last newline (a line still being written) are left for the next read, so a line, and
 * a multi-byte character in it, is never cut.
 */
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";

export interface FileStat {
  /** Device and inode: a new id at the same path is a new file. */
  fileId: string;
  size: number;
  mtimeMs: number;
}

export async function statOf(handle: FileHandle): Promise<FileStat> {
  const s = await handle.stat({ bigint: true });
  return { fileId: `${s.dev}:${s.ino}`, size: Number(s.size), mtimeMs: Number(s.mtimeMs) };
}

const HEAD_BYTES = 4096;
const TAIL_BYTES = 1024;

/** A hash of the first bytes of the file and of the bytes just before `offset`: it changes when the file is rewritten. */
export async function fingerprint(handle: FileHandle, offset: number): Promise<string> {
  const head = await readAt(handle, 0, Math.min(HEAD_BYTES, offset));
  const tailStart = Math.max(0, offset - TAIL_BYTES);
  const tail = await readAt(handle, tailStart, offset - tailStart);
  return createHash("sha256").update(head).update(tail).digest("hex").slice(0, 32);
}

export async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return buffer.subarray(0, done);
}

/** A piece of a file: complete lines as text, or a line longer than the limit that was skipped. */
export type Piece = { text: string; end: number } | { skipped: number; start: number; end: number };

/**
 * The complete lines from `offset` to `size`, in pieces of about `batchBytes` that each end with a newline, with
 * the offset after each piece. A line longer than a batch is read whole, up to `maxLineBytes`; a longer one is
 * skipped (only its end is looked for) and given as `skipped`. A last line without a newline is not given.
 */
export async function* completeLines(
  handle: FileHandle,
  offset: number,
  size: number,
  batchBytes: number | (() => number),
  maxLineBytes = Number.POSITIVE_INFINITY,
): AsyncGenerator<Piece> {
  let position = offset;
  while (position < size) {
    // A function: the caller sizes each piece as it goes (by the time the last one took).
    const batch = typeof batchBytes === "function" ? batchBytes() : batchBytes;
    let length = Math.min(batch, size - position);
    let buffer = await readAt(handle, position, length);
    let newline = buffer.lastIndexOf(0x0a);
    while (newline < 0 && position + length < size && length < maxLineBytes) {
      length = Math.min(length * 2, size - position, maxLineBytes);
      buffer = await readAt(handle, position, length);
      newline = buffer.lastIndexOf(0x0a);
    }
    if (newline < 0 && length >= maxLineBytes && position + length < size) {
      const end = await nextNewline(handle, position + length, size, batch);
      if (end === undefined) return; // the long line is still being written
      yield { skipped: end - position, start: position, end };
      position = end;
      continue;
    }
    if (newline < 0) return;
    const end = position + newline + 1;
    yield { text: buffer.subarray(0, newline + 1).toString("utf8"), end };
    position = end;
  }
}

/** The offset after the next newline at or after `from`, read in chunks; undefined when there is none yet. */
async function nextNewline(handle: FileHandle, from: number, size: number, chunk: number): Promise<number | undefined> {
  for (let at = from; at < size; at += chunk) {
    const newline = (await readAt(handle, at, Math.min(chunk, size - at))).indexOf(0x0a);
    if (newline >= 0) return at + newline + 1;
  }
  return undefined;
}
