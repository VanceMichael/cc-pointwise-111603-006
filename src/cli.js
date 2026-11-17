import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';

const here = dirname(fileURLToPath(import.meta.url));
const repository = new RecordRepository(resolve(here, '../var/records.json'));
const service = new CollectionService(repository);
const action = process.argv[2] ?? '--help';
if (action === '--help' || action === '-h') {
  console.log(JSON.stringify({
    usage: 'npm start -- ingest [文件] | query [来源] | collect [来源场景文件]',
    commands: ['ingest', 'query', 'collect'],
    collect: '读取来源页面并采集附件；半途中断或校验未通过时报告原因，可再次运行续传',
  }));
  process.exit(0);
}
if (action === 'ingest') {
  const records = JSON.parse(await readFile(process.argv[3] ?? resolve(here, '../fixtures/records.json'), 'utf8'));
  console.log(JSON.stringify(await service.ingest(records), null, 2));
} else if (action === 'query') {
  console.log(JSON.stringify(await service.query({ source: process.argv[3] }), null, 2));
} else if (action === 'collect') {
  const scenarioPath = process.argv[3]
    ? resolve(process.argv[3])
    : resolve(here, '../fixtures/source.json');
  const scenario = await startSource(scenarioPath);
  try {
    const records = parsePage(await new SourceClient(scenario.url).read(entryPath)).records;
    await service.ingest(records);
    const result = await service.collect(records, { sourceUrl: scenario.url });
    console.log(JSON.stringify(result, null, 2));
  } finally { await scenario.close(); }
} else {
  throw new Error('action must be ingest, query or collect');
}
