import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { findRecords, mergeRecords, normalizeRecord } from './records.js';
import { CollectionState, collectionStatePath, findRevision, revisionOf } from './collection-state.js';
import { AttachmentStore } from './attachment-store.js';
import { SourceClient } from './source-client.js';

const checksumPattern = /^(?:sha256:)?([0-9a-f]{64})$/i;

function parseChecksum(value) {
  const match = String(value ?? '').trim().match(checksumPattern);
  return match ? match[1].toLowerCase() : null;
}

function totalFromContentRange(value) {
  const match = String(value ?? '').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? null : Number(match[3]) };
}

/**
 * Collection lifetime for announcement pages and attachments.
 *
 * Announcement revisions are recorded first, then each attachment is tracked
 * against the revision that referenced it.  Bytes only become a business
 * file after the complete SHA-256 matches the source declaration; everything
 * else stays in the partial area with an explicit unfinished reason.
 */
export class CollectionService {
  constructor(repository, options = {}) {
    this.repository = repository;
    const statePath = options.statePath
      ?? (repository.path ? collectionStatePath(repository.path) : null);
    this.state = options.state ?? (statePath ? new CollectionState(statePath) : null);
    this.store = options.store
      ?? (statePath ? new AttachmentStore(join(dirname(statePath), 'attachments')) : null);
    this.client = options.client ?? null;
    this.locks = new Map();
  }

  #client(sourceUrl) {
    if (this.client) return this.client;
    if (!sourceUrl) throw new Error('collect requires a local source url');
    return new SourceClient(sourceUrl);
  }

  #lock(key, work) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.locks.set(key, next.catch(() => {}));
    next.finally(() => { if (this.locks.get(key) === next) this.locks.delete(key); }).catch(() => {});
    return next;
  }

  async ingest(inputs) {
    if (!Array.isArray(inputs)) throw new TypeError('ingest input must be an array');
    const accepted = inputs.map(normalizeRecord);
    const current = await this.repository.read();
    const merged = mergeRecords(current, accepted);
    if (this.state) await this.state.recordRecords(accepted);
    await this.repository.replace(merged);
    return { accepted: accepted.length, stored: merged.length };
  }

  async query(filters) { return findRecords(await this.repository.read(), filters); }

  async collect(inputs, options = {}) {
    if (!Array.isArray(inputs)) throw new TypeError('collect input must be an array');
    if (!this.state || !this.store) throw new Error('collect requires a state path');
    const accepted = inputs.map(normalizeRecord);
    await this.state.recordRecords(accepted);
    // A source is only required when bytes actually have to be fetched; a
    // second run over already verified files works offline.
    let client = this.client;
    const sourceClient = () => {
      if (!client) client = this.#client(options.sourceUrl);
      return client;
    };
    const attachments = [];
    for (const record of accepted) {
      const revision = revisionOf(record);
      const declared = Array.isArray(record.attributes?.attachments)
        ? record.attributes.attachments : [];
      for (const attachment of declared) {
        const attachmentId = String(attachment?.id ?? '').trim();
        if (!attachmentId) {
          attachments.push({
            noticeId: record.sourceId,
            revision,
            attachmentId: null,
            status: 'unavailable',
            reason: 'attachment_identity_missing',
            message: '附件缺少稳定 id，无法与本地文件对应',
          });
          continue;
        }
        const result = await this.#lock(
          `${record.sourceId}\u0000${revision}\u0000${attachmentId}`,
          () => this.#collectAttachment({
            noticeId: record.sourceId,
            revision,
            attachmentId,
          }, sourceClient, options),
        );
        attachments.push(result);
      }
    }
    const summary = {
      collected: attachments.length,
      ready: attachments.filter((item) => item.status === 'ready').length,
      pending: attachments.filter((item) => item.status === 'pending').length,
      unavailable: attachments.filter((item) => item.status === 'unavailable').length,
      attachments,
    };
    return summary;
  }

  async #collectAttachment(identity, sourceClient, options) {
    const state = await this.state.read();
    const entry = findRevision(state.notices[identity.noticeId], identity.revision);
    const job = entry?.attachments.find((item) => item.attachmentId === identity.attachmentId);
    if (!job) {
      return { ...identity, status: 'pending', reason: 'not_tracked', message: '附件未出现在已记录的公告修订中' };
    }

    const expected = parseChecksum(job.expectedChecksum);
    const key = this.store.key(identity);
    const partialPath = this.store.partialPath(key);

    if (job.partialReset) {
      // The source declared a different content identity for this
      // attachment; bytes from the previous entity are worthless.
      await this.store.reset(partialPath);
      if (job.staleFile) await this.store.remove(job.staleFile);
      await this.state.patchAttachment({ ...identity, patch: { partialReset: false, staleFile: null } });
    }

    if (job.status === 'ready' && job.file) {
      const size = await this.store.size(job.file);
      if (size && size === job.bytes) return this.#view(identity, job);
      await this.store.remove(job.file);
      return this.#patch(identity, {
        status: 'pending', reason: 'local_file_missing', message: '已验证的本地文件不完整或不存在，需要重新采集',
        bytes: 0, totalBytes: null, sha256: null, etag: null, file: null,
      });
    }
    if (job.staleFile) {
      // A previously published file no longer matches the declared identity;
      // never keep it where a consumer could still pick it up.
      await this.store.remove(job.staleFile);
      await this.state.patchAttachment({ ...identity, patch: { staleFile: null } });
    }

    let restarts = 0;
    let entityChanged = false;
    while (restarts <= 2) {
      let offset = await this.store.size(partialPath);
      if (job.totalBytes !== null && job.totalBytes !== undefined && offset > job.totalBytes) {
        await this.store.reset(partialPath);
        offset = 0;
        job.totalBytes = null;
        job.etag = null;
      }

      if (job.totalBytes !== null && job.totalBytes !== undefined && offset === job.totalBytes && offset > 0) {
        return this.#finalize(identity, job, partialPath, expected);
      }

      const headers = {};
      if (offset > 0) headers.range = `bytes=${offset}-`;
      if (job.etag) headers['if-match'] = job.etag;

      let response;
      try {
        response = await sourceClient().open(job.href, {
          headers,
          // The body of a large attachment is not bounded by this; it is
          // guarded by the store's idle timeout while bytes arrive.
          headerTimeout: options.headerTimeout ?? 30_000,
          signal: options.signal ?? null,
        });
      } catch (error) {
        return this.#patch(identity, {
          status: 'pending', reason: 'source_unreachable', bytes: offset, totalBytes: job.totalBytes ?? null,
          message: `无法连接附件来源：${error.message}`,
        });
      }

      if (response.status === 404 || response.status === 410) {
        return this.#patch(identity, {
          status: 'unavailable', reason: 'not_uploaded', bytes: offset, totalBytes: job.totalBytes ?? null,
          message: '附件来源暂未提供该文件（尚未上传或已被撤下），已保留现有字节等待下次继续',
        });
      }
      if (response.status === 403) {
        return this.#patch(identity, {
          status: 'unavailable', reason: 'access_denied', bytes: offset, totalBytes: job.totalBytes ?? null,
          message: '附件来源拒绝访问',
        });
      }
      if (response.status === 412) {
        // The entity behind the address was replaced.  Never append new bytes
        // to bytes from the old entity.
        await this.store.reset(partialPath);
        job.etag = null;
        job.totalBytes = null;
        entityChanged = true;
        restarts += 1;
        continue;
      }
      if (response.status === 416) {
        await response.body?.cancel().catch(() => {});
        // Some sources serve a chunked body without a total length.  If the
        // stored bytes already hash to the declared checksum, they are the
        // whole attachment and there is nothing left to fetch.
        if (expected && offset > 0
          && await this.store.sha256(partialPath) === expected) {
          return this.#finalize(identity, job, partialPath, expected);
        }
        await this.store.reset(partialPath);
        job.etag = null;
        job.totalBytes = null;
        restarts += 1;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return this.#patch(identity, {
          status: 'pending', reason: 'source_error', bytes: offset, totalBytes: job.totalBytes ?? null,
          message: `附件来源返回 ${response.status}，可在后续采集继续`,
        });
      }
      if (!response.body) {
        return this.#patch(identity, {
          status: 'pending', reason: 'incomplete_download', bytes: offset, totalBytes: job.totalBytes ?? null,
          message: '附件来源返回了空响应体，可在后续采集继续',
        });
      }

      const contentRange = totalFromContentRange(response.headers.get('content-range'));
      if (offset > 0 && response.status === 206) {
        if (contentRange && contentRange.start !== offset) {
          await response.body?.cancel().catch(() => {});
          await this.store.reset(partialPath);
          job.etag = null;
          job.totalBytes = null;
          restarts += 1;
          continue;
        }
      } else if (offset > 0) {
        // Range was ignored (200).  The body starts at zero, so the previous
        // partial bytes cannot be kept.
        await response.body?.cancel().catch(() => {});
        await this.store.reset(partialPath);
        job.etag = null;
        job.totalBytes = null;
        restarts += 1;
        continue;
      }

      let totalBytes = contentRange?.total ?? job.totalBytes ?? null;
      if (offset === 0 && response.status === 200) {
        const length = response.headers.get('content-length');
        if (length !== null && /^\d+$/.test(length)) totalBytes = Number(length);
      }
      if (contentRange && totalBytes !== null && totalBytes < offset) {
        await response.body?.cancel().catch(() => {});
        await this.store.reset(partialPath);
        job.etag = null;
        job.totalBytes = null;
        restarts += 1;
        continue;
      }

      const etag = response.headers.get('etag');
      if (etag) job.etag = etag;
      job.totalBytes = totalBytes;

      const result = await this.store.append(partialPath, response, {
        limitBytes: options.limitBytes ?? null,
      });
      const bytes = offset + result.written;
      const complete = !result.error && !result.limited
        && (totalBytes === null || bytes >= totalBytes);

      if (result.error) {
        return this.#patch(identity, {
          status: 'pending', reason: 'incomplete_download', bytes,
          totalBytes, etag: job.etag,
          message: `下载在 ${bytes}${totalBytes === null ? '' : `/${totalBytes}`} 字节处中断：${result.error.message}；可从断点继续`,
        });
      }
      if (!complete) {
        return this.#patch(identity, {
          status: 'pending', reason: 'incomplete_download', bytes,
          totalBytes, etag: job.etag,
          message: `本次只获取了 ${bytes}${totalBytes === null ? '' : `/${totalBytes}`} 字节，尚未完成；可从断点继续`,
        });
      }
      return this.#finalize(identity, job, partialPath, expected, { totalBytes });
    }

    if (entityChanged) {
      return this.#patch(identity, {
        status: 'pending', reason: 'source_changed',
        bytes: await this.store.size(partialPath), totalBytes: null,
        etag: null,
        message: '附件实体在续传期间发生变化，已丢弃旧字节；请再次采集',
      });
    }
    return this.#patch(identity, {
      status: 'pending', reason: 'source_inconsistent',
      bytes: await this.store.size(partialPath), totalBytes: null,
      etag: null,
      message: '附件来源对同一地址返回了不一致的内容范围，旧字节已丢弃；请再次采集',
    });
  }

  async #finalize(identity, job, partialPath, expected, { totalBytes = null } = {}) {
    const size = await this.store.size(partialPath);
    const sha256 = await this.store.sha256(partialPath);
    const count = totalBytes ?? job.totalBytes ?? size;
    if (!expected) {
      return this.#patch(identity, {
        status: 'pending', reason: 'checksum_unavailable', bytes: size, totalBytes: count,
        sha256, etag: job.etag ?? null,
        message: '来源未声明可校验的 SHA-256，已保留完整字节但未发布',
      });
    }
    if (sha256 !== expected) {
      await this.store.reset(partialPath);
      return this.#patch(identity, {
        status: 'pending', reason: 'checksum_mismatch', bytes: 0, totalBytes: count,
        sha256: null, etag: null,
        message: `下载内容校验不一致（声明 ${expected}，实际 ${sha256}），已丢弃且不发布`,
      });
    }
    const readyPath = join(
      this.store.readyRoot,
      this.store.key(identity),
      `${sha256}.bin`,
    );
    await this.store.publish(partialPath, readyPath);
    return this.#patch(identity, {
      status: 'ready', reason: null,
      message: '下载完整且 SHA-256 校验通过',
      bytes: size, totalBytes: count, sha256, etag: job.etag ?? null, file: readyPath,
    });
  }

  async #patch(identity, patch) {
    const job = await this.state.patchAttachment({ ...identity, patch });
    return this.#view(identity, job);
  }

  #view(identity, job) {
    return {
      noticeId: identity.noticeId,
      revision: identity.revision,
      attachmentId: identity.attachmentId,
      href: job?.href ?? null,
      checksum: job?.expectedChecksum ?? null,
      status: job?.status ?? 'pending',
      reason: job ? (job.reason ?? null) : 'not_collected',
      message: job?.message ?? '附件尚未采集',
      bytes: job?.bytes ?? 0,
      totalBytes: job?.totalBytes ?? (job?.status === 'ready' ? job.bytes : null),
      sha256: job?.sha256 ?? null,
      file: job?.status === 'ready' ? job.file : null,
      updatedAt: job?.updatedAt ?? null,
    };
  }
}
