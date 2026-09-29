import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.mjs';

test('state is persisted in order and a second worker cannot acquire the same directory', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-feishu-store-test-'));
  const first = new Store(dir), second = new Store(dir);
  try {
    await first.open();
    await assert.rejects(second.open(), { code: 'EEXIST' });
    first.data.inbox.a = { status: 'SENDING' };
    const saving1 = first.save();
    first.data.inbox.a.status = 'UNKNOWN';
    const saving2 = first.save();
    await Promise.all([saving1, saving2]);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')).inbox.a.status, 'UNKNOWN');
    await first.close();
    await second.open();
    assert.equal(second.data.inbox.a.status, 'UNKNOWN');
  } finally {
    await first.close();
    await second.close();
    // mkdtemp returns an absolute, uniquely created directory under the temp root.
    assert.ok(dir.startsWith(path.join(os.tmpdir(), 'chatgpt-feishu-store-test-')));
    await rm(dir, { recursive: true, force: true });
  }
});
