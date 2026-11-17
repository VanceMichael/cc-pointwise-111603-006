import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

function safeSegment(value) {
  const text = String(value ?? '').trim();
  const readable = text.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'item';
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 12);
  return `${readable}-${digest}`;
}

/**
 * Local file layout for attachment collection.
 *
 * `partial/` holds bytes that have not passed completeness verification yet;
 * `ready/` holds only files that a consumer may use.  The two trees are kept
 * apart so no code path can accidentally treat a half download as data.
 */
export class AttachmentStore {
  constructor(root) {
    this.root = resolve(root);
    this.partialRoot = join(this.root, 'partial');
    this.readyRoot = join(this.root, 'ready');
  }

  key({ noticeId, revision, attachmentId }) {
    return join(
      safeSegment(noticeId),
      safeSegment(revision),
      safeSegment(attachmentId),
    );
  }

  partialPath(key) { return join(this.partialRoot, `${key}.part`); }
  readyPath(key) { return join(this.readyRoot, key); }

  async size(path) {
    try { return (await stat(path)).size; } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
  }

  async remove(path) { await rm(path, { force: true }); }

  async reset(path) {
    await mkdir(dirname(path), { recursive: true });
    await rm(path, { force: true });
  }

  async publish(partialPath, readyPath) {
    await mkdir(dirname(readyPath), { recursive: true });
    // Both paths live inside the same state directory, so this rename is
    // atomic: a ready file is either fully the verified file or absent.
    await rename(partialPath, readyPath);
  }

  async sha256(path) {
    const hash = createHash('sha256');
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally { await handle.close(); }
    return hash.digest('hex');
  }

  /**
   * Append a web response body to the partial file.
   *
   * `limitBytes` bounds one fetch attempt so a caller can deliberately stop
   * after part of a large attachment; the bytes remain on disk for a later
   * range resume.  A connection error is reported, not thrown, because the
   * bytes already received are still useful.
   */
  async append(partialPath, response, { limitBytes = null, idleTimeout = 30_000 } = {}) {
    await mkdir(dirname(partialPath), { recursive: true });
    const handle = await open(partialPath, 'a');
    const reader = response.body.getReader();
    let written = 0;
    let limited = false;
    let error = null;
    try {
      while (true) {
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no data for ${idleTimeout}ms`)), idleTimeout);
        });
        let chunkResult;
        try {
          chunkResult = await Promise.race([reader.read(), timeout]);
        } finally { clearTimeout(timer); }
        const { done, value } = chunkResult;
        if (done) break;
        let chunk = Buffer.from(value);
        if (limitBytes !== null && written + chunk.length >= limitBytes) {
          chunk = chunk.subarray(0, Math.max(0, limitBytes - written));
          limited = true;
        }
        if (chunk.length) {
          await handle.write(chunk);
          written += chunk.length;
        }
        if (limited) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    } catch (caught) {
      error = caught;
      await reader.cancel().catch(() => {});
    } finally {
      await handle.close().catch(() => {});
    }
    return { written, limited, error };
  }
}
