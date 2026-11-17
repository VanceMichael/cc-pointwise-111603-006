import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

const checksumPattern = /^(?:sha256:)?([0-9a-f]{64})$/i;

function parseChecksum(value) {
  const match = String(value ?? '').trim().match(checksumPattern);
  return match ? match[1].toLowerCase() : null;
}

export const collectionStateSuffix = '.collection.json';

export function collectionStatePath(recordPath) {
  return `${recordPath}${collectionStateSuffix}`;
}

export function revisionOf(record) {
  const value = record?.attributes?.revision;
  if (value === undefined || value === null || value === '') return 'unknown';
  return String(value);
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compareRevisions(left, right) {
  const leftNumber = asNumber(left.revision);
  const rightNumber = asNumber(right.revision);
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
  return String(left.revision).localeCompare(String(right.revision));
}

export function latestRevision(notice) {
  if (!notice?.revisions?.length) return null;
  return [...notice.revisions].sort(compareRevisions).at(-1);
}

export function findRevision(notice, revision) {
  const wanted = String(revision);
  return notice?.revisions?.find((entry) => String(entry.revision) === wanted) ?? null;
}

function emptyState() {
  return { version: 1, notices: {} };
}

const queues = new Map();

function serialize(path, work) {
  const previous = queues.get(path) ?? Promise.resolve();
  const next = previous.then(work, work);
  queues.set(path, next.catch(() => {}));
  return next;
}

/**
 * Durable collection metadata.  It deliberately lives next to (not inside)
 * the business record collection: a source observation being stored is not
 * proof that its attachments are complete or usable.
 */
export class CollectionState {
  constructor(path) {
    this.path = path;
  }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (!value || typeof value !== 'object' || !value.notices || typeof value.notices !== 'object') {
        throw new Error('collection state has no notices map');
      }
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  async update(mutator) {
    return serialize(this.path, async () => {
      const state = await this.read();
      const result = await mutator(state);
      await this.write(state);
      return result;
    });
  }

  async write(state) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
  }

  /**
   * Record every announcement revision that was actually observed.  A newer
   * notice revision never erases an older one, which is what makes an
   * addendum traceable to the announcement revision it amended.
   */
  async recordRecords(records) {
    return this.update((state) => {
      for (const record of records) {
        const noticeId = record.sourceId;
        const revision = revisionOf(record);
        if (!state.notices[noticeId]) {
          state.notices[noticeId] = { noticeId, revisions: [] };
        }
        const notice = state.notices[noticeId];
        let entry = findRevision(notice, revision);
        if (!entry) {
          entry = {
            revision,
            title: record.label,
            publishedAt: record.attributes?.publishedAt ?? null,
            observedAt: record.observedAt,
            lastObservedAt: record.observedAt,
            supersedes: null,
            attachments: [],
          };
          notice.revisions.push(entry);
        } else {
          entry.title = record.label;
          entry.publishedAt = record.attributes?.publishedAt ?? entry.publishedAt ?? null;
          entry.lastObservedAt = record.observedAt;
        }
        // Revision order is intrinsic to the announcement, not to arrival
        // order: an addendum that arrives before an older revision still
        // points at the revision it amends.
        this.#linkRevisions(notice);

        const attachments = Array.isArray(record.attributes?.attachments)
          ? record.attributes.attachments : [];
        for (const attachment of attachments) {
          if (!attachment || typeof attachment !== 'object') continue;
          const attachmentId = String(attachment.id ?? '').trim();
          if (!attachmentId) continue;
          const href = String(attachment.href ?? '').trim();
          const expectedChecksum = String(attachment.checksum ?? '').trim();
          let job = entry.attachments.find((item) => item.attachmentId === attachmentId);
          if (!job) {
            entry.attachments.push({
              attachmentId,
              href,
              expectedChecksum,
              status: 'pending',
              reason: 'not_collected',
              message: '附件尚未采集',
              bytes: 0,
              totalBytes: null,
              sha256: null,
              etag: null,
              file: null,
              updatedAt: null,
            });
            continue;
          }
          // An attachment id is stable, but the entity behind the same href
          // can be replaced.  A changed href or declared checksum is a new
          // content identity, so a previous (even verified) file must not be
          // claimed for it.
          if (job.href !== href || job.expectedChecksum !== expectedChecksum) {
            const hrefChanged = job.href !== href;
            const wasReady = job.status === 'ready' && Boolean(job.file);
            job.href = href;
            job.expectedChecksum = expectedChecksum;
            job.updatedAt = null;
            if (wasReady && parseChecksum(expectedChecksum) === job.sha256) {
              // Same verified content, merely re-declared: keep it published.
              continue;
            }
            if (wasReady) {
              job.staleFile = job.file;
              job.file = null;
            }
            job.status = 'pending';
            job.reason = 'not_collected';
            job.message = '附件内容标识已改变，需要重新采集';
            job.sha256 = null;
            if (hrefChanged || wasReady) {
              // A new href is a different resource, and a stale ready file
              // no longer corresponds to the declared content.  In both
              // cases resumable bytes for this attachment are worthless.
              job.bytes = 0;
              job.totalBytes = null;
              job.etag = null;
              job.partialReset = true;
            }
            // A checksum-only change on the same href keeps the partial
            // bytes: the checksum gate decides whether they are usable.
          }
        }
      }
    });
  }

  #linkRevisions(notice) {
    const ordered = [...notice.revisions].sort(compareRevisions);
    let previous = null;
    for (const entry of ordered) {
      entry.supersedes = previous?.revision ?? null;
      previous = entry;
    }
    notice.revisions = ordered;
  }

  async patchAttachment({ noticeId, revision, attachmentId, patch }) {
    return this.update((state) => {
      const entry = findRevision(state.notices[noticeId], revision);
      const job = entry?.attachments.find((item) => item.attachmentId === attachmentId);
      if (!job) return null;
      Object.assign(job, patch, { updatedAt: new Date().toISOString() });
      return structuredClone(job);
    });
  }
}
