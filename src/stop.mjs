import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve(process.argv[2] || 'runtime/service');
try {
  const lock = JSON.parse(await readFile(path.join(directory, 'bridge.lock'), 'utf8'));
  await writeFile(path.join(directory, 'stop-request.json'), JSON.stringify({ pid: lock.pid, token: lock.token, requestedAt: new Date().toISOString() }), { flag: 'wx' });
  console.log(JSON.stringify({ status: 'STOP_REQUESTED', pid: lock.pid }));
} catch (error) {
  console.error(JSON.stringify({ status: 'STOP_NOT_REQUESTED', error: error.code || error.message }));
  process.exitCode = 1;
}
