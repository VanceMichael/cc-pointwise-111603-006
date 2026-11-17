import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startSource } from '../source/server.js';
import { SourceClient } from '../src/source-client.js';
import { parsePage, entryPath } from '../src/adapter.js';
import { RecordRepository } from '../src/repository.js';
import { CollectionService } from '../src/service.js';
import { readOperations } from '../src/operations.js';
import { collectionStatePath } from '../src/collection-state.js';
import { AttachmentStore } from '../src/attachment-store.js';

const scenarioPath = new URL('../fixtures/source.json', import.meta.url);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function setup() {
  const source = await startSource(scenarioPath);
  const directory = await mkdtemp(join(tmpdir(), 'resume-'));
  const repository = new RecordRepository(join(directory, 'records.json'));
  const service = new CollectionService(repository);
  const client = new SourceClient(source.url);
  const page = parsePage(await client.read(entryPath));
  await service.ingest(page.records);
  return {
    source, directory, repository, service, client, page,
    statePath: collectionStatePath(repository.path),
    store: new AttachmentStore(join(directory, 'attachments')),
    async close() { await source.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('an interrupted large attachment resumes from the stored byte offset', async () => {
  const context = await setup();
  try {
    const { source, service, page, repository, client } = context;
    const first = await service.collect(page.records, { sourceUrl: source.url, limitBytes: 2 });
    assert.equal(first.pending, 1);
    assert.equal(first.attachments[0].status, 'pending');
    assert.equal(first.attachments[0].reason, 'incomplete_download');
    assert.equal(first.attachments[0].bytes, 2);
    assert.equal(first.attachments[0].file, null);

    const operations = await readOperations(repository);
    assert.equal(operations.rows[0].attachments.length, 0, 'partial bytes are not published');
    assert.equal(operations.rows[0].unfinished[0].reason, 'incomplete_download');

    const before = source.requests.filter((request) => request.path === '/files/A1').length;
    const resumed = await new CollectionService(repository)
      .collect(parsePage(await client.read(entryPath)).records, { sourceUrl: source.url });
    const attachment = resumed.attachments[0];
    assert.equal(attachment.status, 'ready');
    assert.equal(attachment.bytes, 5);
    assert.equal(attachment.totalBytes, 5);
    assert.equal(attachment.sha256, sha256('dummy'));

    const requests = source.requests.filter((request) => request.path === '/files/A1').slice(before);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].range, 'bytes=2-');
    assert.equal(requests[0].ifMatch, '"a1-v1"');
    assert.equal(await readFile(attachment.file, 'utf8'), 'dummy');
  } finally { await context.close(); }
});

test('a replaced source entity is never appended to nor published', async () => {
  const context = await setup();
  try {
    const { source, service, page, repository } = context;
    await service.collect(page.records, { sourceUrl: source.url, limitBytes: 2 });
    source.publish('updated');
    const resumed = await service.collect(page.records, { sourceUrl: source.url });
    const attachment = resumed.attachments[0];
    assert.equal(attachment.status, 'pending');
    assert.equal(attachment.reason, 'checksum_mismatch');
    assert.equal(attachment.file, null);
    assert.equal(attachment.sha256, null);

    const operations = await readOperations(repository);
    assert.equal(operations.rows[0].attachments.length, 0);
    assert.equal(operations.rows[0].unfinished[0].reason, 'checksum_mismatch');
  } finally { await context.close(); }
});

test('the amended entity at the same path is not mistaken for the original revision', async () => {
  const context = await setup();
  try {
    const { source, service, page } = context;
    const first = await service.collect(page.records, { sourceUrl: source.url });
    assert.equal(first.attachments[0].sha256, sha256('dummy'));
    source.publish('updated');
    // Re-observing revision 1 declares the same checksum, so the published
    // file must not be silently swapped for the amended body.
    const again = await service.collect(page.records, { sourceUrl: source.url });
    assert.equal(again.attachments[0].status, 'ready');
    assert.equal(again.attachments[0].sha256, sha256('dummy'));
  } finally { await context.close(); }
});

test('an addendum stays traceable to the notice revision it supersedes', async () => {
  const context = await setup();
  try {
    const { source, service, page, repository, client } = context;
    await service.collect(page.records, { sourceUrl: source.url });
    source.publish('updated');
    const update = parsePage(await client.read(entryPath));
    await service.ingest(update.records);
    const collected = await service.collect(update.records, { sourceUrl: source.url });
    assert.equal(collected.unavailable, 1);
    assert.equal(collected.attachments[0].reason, 'not_uploaded');
    assert.equal(collected.attachments[0].file, null);

    const row = (await readOperations(repository)).rows[0];
    assert.equal(row.revision, '2');
    assert.equal(row.supersedes, '1');
    assert.deepEqual(row.revisionHistory.map((entry) => entry.revision), ['1', '2']);
    for (const revision of row.revisionHistory) {
      assert.equal(await service.query({}).then((rows) => rows[0].sourceId), 'T1', revision.revision);
    }
    const original = row.revisionHistory.find((entry) => entry.revision === '1');
    assert.equal(original.attachments[0].status, 'ready');
    assert.equal(original.attachments[0].sha256, sha256('dummy'));
    const addendum = row.revisionHistory.find((entry) => entry.revision === '2');
    assert.equal(addendum.supersedes, '1');
    assert.equal(addendum.attachments[0].reason, 'not_uploaded');
    assert.equal(row.attachments.length, 0, 'the addendum exposes no usable attachment');
    assert.equal(row.unfinished.length, 1);
  } finally { await context.close(); }
});

test('a partial run records the reason and the next run completes the rest', async () => {
  const context = await setup();
  try {
    const { source, service, page } = context;
    source.failNext('/files/A1', 503);
    const failed = await service.collect(page.records, { sourceUrl: source.url });
    assert.equal(failed.attachments[0].status, 'pending');
    assert.equal(failed.attachments[0].reason, 'source_error');
    assert.equal(failed.attachments[0].bytes, 0);
    const retry = await service.collect(page.records, { sourceUrl: source.url });
    assert.equal(retry.attachments[0].status, 'ready');
  } finally { await context.close(); }
});

test('a dropped connection keeps received bytes for a later resume', async () => {
  const context = await setup();
  try {
    const { source, service, page } = context;
    source.failNext('/files/A1', 'disconnect');
    const dropped = await service.collect(page.records, { sourceUrl: source.url });
    assert.equal(dropped.attachments[0].status, 'pending');
    assert.equal(dropped.attachments[0].reason, 'source_unreachable');
    assert.equal(dropped.attachments[0].file, null);
    const resumed = await service.collect(page.records, { sourceUrl: source.url });
    assert.equal(resumed.attachments[0].status, 'ready');
    assert.equal(resumed.attachments[0].sha256, sha256('dummy'));
  } finally { await context.close(); }
});

test('a verified file survives a restart and is not fetched again', async () => {
  const context = await setup();
  try {
    const { source, service, page, repository } = context;
    const first = await service.collect(page.records, { sourceUrl: source.url });
    assert.equal(first.attachments[0].status, 'ready');
    const count = source.requests.filter((request) => request.path === '/files/A1').length;

    const restarted = new CollectionService(new RecordRepository(repository.path));
    const again = await restarted.collect(page.records);
    assert.equal(again.attachments[0].status, 'ready');
    assert.equal(again.attachments[0].file, first.attachments[0].file);
    assert.equal(source.requests.filter((request) => request.path === '/files/A1').length, count);
    assert.equal((await stat(again.attachments[0].file)).size, 5);
  } finally { await context.close(); }
});

test('a whole download whose checksum does not match is discarded, not published', async () => {
  const context = await setup();
  try {
    const { source, service, store } = context;
    const record = structuredClone(context.page.records[0]);
    record.attributes.attachments[0].checksum = sha256('something else');
    const result = await service.collect([record], { sourceUrl: source.url });
    assert.equal(result.attachments[0].status, 'pending');
    assert.equal(result.attachments[0].reason, 'checksum_mismatch');
    assert.equal(result.attachments[0].file, null);
    const key = store.key({ noticeId: 'T1', revision: '1', attachmentId: 'A1' });
    assert.equal(await store.size(store.partialPath(key)), 0);
  } finally { await context.close(); }
});

test('an unparseable declared checksum withholds the bytes instead of trusting them', async () => {
  const context = await setup();
  try {
    const { source, service } = context;
    const records = [{
      sourceId: 'T9', source: '招标公告跟踪器', observedAt: '2026-11-16T10:00:00Z', label: '未知校验',
      attributes: { noticeId: 'T9', title: '未知校验', revision: 1,
        publishedAt: '2026-11-16T10:00:00Z',
        attachments: [{ id: 'A1', href: '/files/A1', checksum: 'unknown' }] },
    }];
    const result = await service.collect(records, { sourceUrl: source.url });
    assert.equal(result.attachments[0].status, 'pending');
    assert.equal(result.attachments[0].reason, 'checksum_unavailable');
    assert.equal(result.attachments[0].file, null);
    assert.equal(result.attachments[0].sha256, sha256('dummy'));
  } finally { await context.close(); }
});

test('an attachment that is uploaded later becomes usable on a subsequent run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resume-'));
  const record = {
    sourceId: 'T7', source: '招标公告跟踪器', observedAt: '2026-11-16T10:00:00Z', label: '迟交附件',
    attributes: { noticeId: 'T7', title: '迟交附件', revision: 1,
      publishedAt: '2026-11-16T10:00:00Z',
      attachments: [{ id: 'A7', href: '/files/A7', checksum: sha256('late attachment') }] },
  };
  const stage = (body, status = 200) => ({ routes: {
    '/files/A7': { contentType: 'application/octet-stream', body, status, etag: `"${sha256(body)}"` },
  } });
  const scenarioPath = join(directory, 'scenario.json');
  await writeFile(scenarioPath, JSON.stringify({
    stages: { missing: stage('not uploaded', 404), present: stage('late attachment') },
  }));
  const source = await startSource(scenarioPath);
  const repository = new RecordRepository(join(directory, 'records.json'));
  const service = new CollectionService(repository);
  try {
    await service.ingest([record]);
    const waiting = await service.collect([record], { sourceUrl: source.url });
    assert.equal(waiting.attachments[0].status, 'unavailable');
    assert.equal(waiting.attachments[0].reason, 'not_uploaded');
    assert.equal(waiting.attachments[0].file, null);
    assert.equal((await readOperations(repository)).rows[0].unfinished.length, 1);

    source.publish('present');
    const uploaded = await service.collect([record], { sourceUrl: source.url });
    assert.equal(uploaded.attachments[0].status, 'ready');
    assert.equal(uploaded.attachments[0].sha256, sha256('late attachment'));
    assert.equal(await readFile(uploaded.attachments[0].file, 'utf8'), 'late attachment');
    const row = (await readOperations(repository)).rows[0];
    assert.equal(row.unfinished.length, 0);
    assert.equal(row.attachments.length, 1);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a deleted verified file is reported missing and re-collected on demand', async () => {
  const context = await setup();
  try {
    const { source, service, page, store } = context;
    const ready = await service.collect(page.records, { sourceUrl: source.url });
    const file = ready.attachments[0].file;
    assert.equal(await store.size(file), 5);
    await store.remove(file);

    const lost = await service.collect(page.records, { sourceUrl: source.url });
    assert.equal(lost.attachments[0].status, 'pending');
    assert.equal(lost.attachments[0].reason, 'local_file_missing');
    assert.equal(lost.attachments[0].file, null);

    const recovered = await service.collect(page.records, { sourceUrl: source.url });
    assert.equal(recovered.attachments[0].status, 'ready');
    assert.equal(await store.size(recovered.attachments[0].file), 5);
    assert.equal(await store.size(file), 5);
  } finally { await context.close(); }
});
