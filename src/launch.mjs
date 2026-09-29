import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentialsIndex = process.argv.indexOf('--credentials');
try {
  if (credentialsIndex < 0 || !process.env.CODEX_APP_TOOLS_PIPE_PATH || !process.env.CODEX_THREAD_ID) throw new Error('Require --credentials and inherited authorized desktop task context.');
  const credentials = path.resolve(process.argv[credentialsIndex + 1]);
  await mkdir(path.join(root, 'runtime'), { recursive: true });
  const stamp = Date.now();
  const stdoutPath = path.join(root, 'runtime', `service-${stamp}.log`);
  const stderrPath = path.join(root, 'runtime', `service-${stamp}.error.log`);
  const stdout = openSync(stdoutPath, 'ax'), stderr = openSync(stderrPath, 'ax');
  const child = spawn(process.execPath, [path.join(root, 'src/service.mjs'), '--live', '--config', path.join(root, 'config.local.json'), '--credentials', credentials], {
    cwd: root, env: process.env, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr],
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  closeSync(stdout); closeSync(stderr);
  child.unref();
  const result = { status: 'PROCESS_LAUNCHED_NOT_YET_VERIFIED', pid: child.pid, launchedAt: new Date().toISOString(), stdoutPath, stderrPath };
  await writeFile(path.join(root, 'runtime', `launch-${stamp}.json`), JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ status: 'LAUNCH_FAILED', error: error.message }));
  process.exitCode = 1;
}
