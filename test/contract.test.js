import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { startSource } from '../source/server.js';
import { parsePage, entryPath } from '../src/adapter.js';
import { SourceClient } from '../src/source-client.js';

async function observe(stage = 'opening', path = entryPath) {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    source.publish(stage);
    return parsePage(await new SourceClient(source.url).read(path));
  } finally { await source.close(); }
}

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

test('attachment source enforces range and entity preconditions across replacement', async () => {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    const partial = await fetch(`${source.url}/files/A1`, { headers: { range: 'bytes=2-', 'if-match': '"a1-v1"' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), 'bytes 2-4/5');
    assert.equal(await partial.text(), 'mmy');
    source.publish('updated');
    assert.equal((await fetch(`${source.url}/files/A1`, { headers: { range: 'bytes=2-', 'if-match': '"a1-v1"' } })).status, 412);
    assert.equal((await fetch(`${source.url}/files/A2`)).status, 404);
  } finally { await source.close(); }
});
