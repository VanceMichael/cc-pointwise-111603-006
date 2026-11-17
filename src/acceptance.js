import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';

const scenarioPath = new URL('../fixtures/source.json', import.meta.url);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const source = await startSource(scenarioPath);
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
try {
  const client = new SourceClient(source.url);
  const page = parsePage(await client.read(entryPath));
  assert.ok(page.records.length > 0, '初始来源须有可接收的业务记录');
  const path = join(directory, 'records.json');
  const repository = new RecordRepository(path);
  const service = new CollectionService(repository);

  const first = await service.ingest(page.records);
  assert.equal(first.accepted, page.records.length);
  const stored = await repository.read();
  const reopened = new RecordRepository(path);
  assert.deepEqual(await new CollectionService(reopened).query({}), stored, '重新打开后读取同一份业务记录');
  const replay = await new CollectionService(reopened).ingest(page.records);
  assert.equal(replay.stored, stored.length, '重放首批记录不重复保存');

  // Interrupt in the middle of the attachment, then resume from the stored
  // offset in a fresh process-like service instance.
  const interrupted = await service.collect(page.records, { sourceUrl: source.url, limitBytes: 2 });
  assert.equal(interrupted.pending, 1);
  assert.equal(interrupted.attachments[0].bytes, 2);
  let operations = await readOperations(reopened);
  assert.equal(operations.rows[0].attachments.length, 0, '不把半个文件当成已就绪资料');
  assert.equal(operations.rows[0].unfinished[0].reason, 'incomplete_download');

  const before = source.requests.filter((request) => request.path === '/files/A1').length;
  const resumed = await service.collect(page.records, { sourceUrl: source.url });
  assert.equal(resumed.attachments[0].status, 'ready');
  assert.equal(resumed.attachments[0].sha256, sha256('dummy'));
  assert.equal(await readFile(resumed.attachments[0].file, 'utf8'), 'dummy');
  const requests = source.requests.filter((request) => request.path === '/files/A1').slice(before);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].range, 'bytes=2-');

  // The source replaces the entity behind the same address.  Old bytes must
  // not be appended to the new body, and the old verified file stays tied to
  // the revision that declared it.
  source.publish('updated');
  const update = parsePage(await client.read(entryPath));
  await service.ingest(update.records);
  const addendum = await service.collect(update.records, { sourceUrl: source.url });
  assert.equal(addendum.unavailable, 1);
  assert.equal(addendum.attachments[0].reason, 'not_uploaded');
  assert.equal(addendum.attachments[0].file, null);

  operations = await readOperations(reopened);
  const row = operations.rows[0];
  assert.equal(row.revision, '2');
  assert.equal(row.supersedes, '1');
  assert.deepEqual(row.revisionHistory.map((entry) => entry.revision), ['1', '2']);
  const original = row.revisionHistory.find((entry) => entry.revision === '1');
  assert.equal(original.attachments[0].status, 'ready');
  assert.equal(original.attachments[0].sha256, sha256('dummy'));
  assert.equal(row.attachments.length, 0, '未上传的补遗附件不被当成已就绪');

  console.log(JSON.stringify({
    accepted: first.accepted,
    persisted: stored.length,
    replayStored: replay.stored,
    interruptedBytes: interrupted.attachments[0].bytes,
    resumedFrom: requests[0].range,
    readySha256: resumed.attachments[0].sha256,
    revisions: row.revisionHistory.map((entry) => entry.revision),
    addendumReason: addendum.attachments[0].reason,
    operationRows: operations.rows.length,
    status: 'ok',
  }));
} finally {
  await source.close();
  await rm(directory, {recursive: true, force: true});
}
