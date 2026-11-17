import {
  CollectionState,
  collectionStatePath,
  findRevision,
  latestRevision,
  revisionOf,
} from './collection-state.js';

const fields = ["noticeId", "title", "revision", "publishedAt", "attachments"];

function attachmentState(job) {
  return {
    attachmentId: job.attachmentId,
    href: job.href,
    declaredChecksum: job.expectedChecksum ?? null,
    status: job.status,
    reason: job.reason ?? null,
    message: job.message ?? null,
    bytes: job.bytes ?? 0,
    totalBytes: job.totalBytes ?? null,
    sha256: job.sha256 ?? null,
    file: job.status === 'ready' ? job.file : null,
    updatedAt: job.updatedAt ?? null,
  };
}

/**
 * Business-facing view.
 *
 * Only attachments whose complete bytes passed SHA-256 verification are
 * exposed as `attachments` (with a file path).  Everything else is reported
 * under `unfinished` together with the reason it is not usable.  Revision
 * history keeps a later addendum traceable to the announcement revision it
 * supersedes instead of silently replacing it.
 */
export async function readOperations(repository, options = {}) {
  const path = options.statePath
    ?? (repository.path ? collectionStatePath(repository.path) : null);
  let state = null;
  if (options.state) state = options.state;
  else if (path) state = await new CollectionState(path).read();

  const records = await repository.read();
  return { product: "招标公告跟踪器", rows: records.map((record) => {
    const revision = revisionOf(record);
    const notice = state?.notices?.[record.sourceId] ?? null;
    const entry = findRevision(notice, revision) ?? latestRevision(notice);
    const jobs = entry?.attachments ?? [];
    return {
      sourceId: record.sourceId,
      source: record.source,
      observedAt: record.observedAt,
      attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
      noticeId: record.sourceId,
      revision,
      supersedes: entry?.supersedes ?? null,
      attachments: jobs.filter((job) => job.status === 'ready').map(attachmentState),
      unfinished: jobs.filter((job) => job.status !== 'ready').map(attachmentState),
      revisionHistory: (notice?.revisions ?? []).map((revisionEntry) => ({
        revision: revisionEntry.revision,
        title: revisionEntry.title,
        publishedAt: revisionEntry.publishedAt,
        observedAt: revisionEntry.observedAt,
        supersedes: revisionEntry.supersedes ?? null,
        attachments: revisionEntry.attachments.map((job) => ({
          attachmentId: job.attachmentId,
          status: job.status,
          reason: job.reason ?? null,
          sha256: job.sha256 ?? null,
        })),
      })),
    };
  }) };
}
