import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DesktopMcpClient } from './mcp-client.mjs';
import { readChat } from './chatgpt.mjs';
import { Store } from './store.mjs';
import { Bridge, validateConfig } from './bridge.mjs';
import { Feishu } from './feishu.mjs';
import { loadCredentials } from './credentials.mjs';
import { SelectionUI } from './ui.mjs';

const option = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const configPath = path.resolve(option('--config') || 'config.local.json');
const checkOnly = process.argv.includes('--check');
const live = process.argv.includes('--live');
const log = event => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
let client, store, feishu, stopping = false;
let lastSuccessfulPoll;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });
try {
  const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
  if (!checkOnly && (!live || config.enabled !== true)) throw new Error('Live forwarding requires enabled=true and --live after the bot and bindings are authorized.');
  client = new DesktopMcpClient();
  await client.start();
  if (checkOnly) {
    const results = [];
    for (const binding of config.bindings) {
      const history = await readChat(client, binding.chatgptThreadId);
      results.push({ bindingId: binding.id, threadId: history.thread.id, kind: history.thread.kind, title: history.thread.title });
    }
    log({ status: 'DESKTOP_BINDINGS_READABLE', bindings: results, feishuConnected: false });
  } else {
    store = new Store(path.resolve(path.dirname(configPath), config.stateDirectory || 'runtime/service'));
    await store.open();
    const credentialsPath = option('--credentials');
    const credentials = credentialsPath ? await loadCredentials(credentialsPath)
      : { appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET };
    if (credentials.brand && credentials.brand !== 'feishu') throw new Error('This configuration requires a Feishu account.');
    if (config.expectedBotAppId && credentials.appId !== config.expectedBotAppId) throw new Error('BOT_APP_ID_MISMATCH');
    feishu = new Feishu({ ...credentials, log });
    const desktop = {
        read: (threadId, cursor) => readChat(client, threadId, { cursor }),
        send: (threadId, prompt) => client.callTool('send_message_to_thread', { threadId, prompt }),
        listThreads: () => client.callTool('list_threads', { limit: 50 }),
        listProjects: () => client.callTool('list_projects', {}),
    };
    const bridge = new Bridge({ config, store, feishu, log, desktop });
    await bridge.initialize();
    const ui = new SelectionUI({ bridge, store, desktop, feishu, log });
    await ui.initialize();
    await feishu.start(async event => {
      // Persist and return promptly; model generation runs in the polling loop.
      if (await ui.acceptMessage(event)) return;
      const result = await bridge.accept(event);
      if (result.accepted) log({ type: 'feishu-message-queued', key: result.key });
    }, event => ui.acceptAction(event));
    log({ status: 'SERVICE_STARTED', feishu: feishu.status() });
    const interval = Math.max(3000, Number(config.pollIntervalMs) || 5000);
    while (!stopping) {
      const stopPath = path.join(store.directory, 'stop-request.json');
      try {
        const request = JSON.parse(await readFile(stopPath, 'utf8'));
        if (request.pid === process.pid && request.token === store.token) {
          await unlink(stopPath);
          stopping = true;
          break;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await ui.tick(); await bridge.tick(); lastSuccessfulPoll = new Date().toISOString(); }
      catch (error) {
        log({ status: 'POLL_FAILED', error: String(error.message).slice(0, 250) });
        // An exited desktop MCP needs a fresh authorized task context.
        if (/MCP_EXIT|MCP_NOT_CONNECTED|MCP_INVALID_JSON/.test(error.message)) { process.exitCode = 1; break; }
      }
      await writeFile(path.join(store.directory, 'health.json'), JSON.stringify({
        checkedAt: new Date().toISOString(), pid: process.pid, status: 'RUNNING', lastSuccessfulPoll, feishu: feishu.status(),
      }, null, 2));
      await sleep(interval);
    }
  }
} catch (error) {
  log({ status: 'FAILED', error: String(error.message).slice(0, 250) });
  process.exitCode = 1;
} finally {
  feishu?.close();
  try {
    if (store?.ownsLock) await writeFile(path.join(store.directory, 'health.json'), JSON.stringify({
      checkedAt: new Date().toISOString(), pid: process.pid, status: 'STOPPED', lastSuccessfulPoll,
    }, null, 2));
    await store?.close();
  } finally { await client?.close(); }
}
