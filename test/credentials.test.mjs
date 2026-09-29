import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadCredentials, saveCredentials } from '../src/credentials.mjs';

test('Windows DPAPI protects stored credentials and preserves the authorizing identity', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-feishu-dpapi-test-'));
  const file = path.join(dir, 'credentials.dpapi.json');
  const registration = { client_id: 'cli_offline_test', client_secret: 'offline-$()-`-not-a-real-secret', user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' } };
  try {
    await saveCredentials(file, registration);
    assert.ok(!(await readFile(file, 'utf8')).includes(registration.client_secret));
    const loaded = await loadCredentials(file);
    assert.equal(loaded.appSecret, registration.client_secret);
    assert.equal(loaded.ownerOpenId, 'ou_owner');
    assert.equal(loaded.brand, 'feishu');
    await assert.rejects(saveCredentials(file, registration), { code: 'EEXIST' });
  } finally {
    assert.ok(dir.startsWith(path.join(os.tmpdir(), 'chatgpt-feishu-dpapi-test-')));
    await rm(dir, { recursive: true, force: true });
  }
});
