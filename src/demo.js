import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';

const scenarioPath = new URL('../fixtures/source.json', import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
const source = await startSource(scenarioPath);
try {
  const repository = new RecordRepository(join(directory, 'records.json'));
  const service = new CollectionService(repository);
  const client = new SourceClient(source.url);
  const read = async () => parsePage(await client.read(entryPath));

  const opening = await read();
  await service.ingest(opening.records);
  // Simulate an interrupted large attachment: only the first 2 bytes arrive.
  const interrupted = await service.collect(opening.records, { sourceUrl: source.url, limitBytes: 2 });
  console.log(JSON.stringify({ step: 'interrupted', attachments: interrupted.attachments }, null, 2));

  // The next run resumes from the stored byte offset rather than restarting.
  const resumed = await service.collect(opening.records, { sourceUrl: source.url });
  console.log(JSON.stringify({ step: 'resumed',
    request: source.requests.filter((request) => request.path === '/files/A1' && request.range).at(-1),
    attachments: resumed.attachments }, null, 2));

  // An addendum arrives whose attachment has not been uploaded yet.
  source.publish('updated');
  const update = await read();
  await service.ingest(update.records);
  const addendum = await service.collect(update.records, { sourceUrl: source.url });
  console.log(JSON.stringify({ step: 'addendum', attachments: addendum.attachments }, null, 2));

  console.log(JSON.stringify({ step: 'operations', operations: await readOperations(repository) }, null, 2));
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
