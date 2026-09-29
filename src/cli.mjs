import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DesktopMcpClient } from './mcp-client.mjs';

const command = process.argv[2] || 'probe';
const option = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const outputPath = option('--output');
let client;
let output;
try {
  client = new DesktopMcpClient();
  await client.start();
  const tools = await client.listTools();
  const expected = ['list_threads', 'read_thread', 'send_message_to_thread'];
  if (command === 'probe') {
    const inventory = await client.callTool('list_threads', { limit: 50 });
    const chats = [...(inventory.pinnedThreads ?? []), ...(inventory.threads ?? [])]
      .filter(thread => thread.kind === 'chatgpt');
    output = {
      checkedAt: new Date().toISOString(),
      route: 'standalone-node -> bundled-stdio-mcp -> desktop-pipe',
      callerContext: 'inherited-current-desktop-task',
      server: client.serverInfo,
      serverSha256: createHash('sha256').update(await readFile(client.serverPath)).digest('hex'),
      requiredTools: Object.fromEntries(expected.map(name => [name, tools.some(tool => tool.name === name)])),
      chatgptCount: chats.length,
      unavailableSources: inventory.unavailableSources ?? [],
    };
    const targetTitle = option('--title');
    if (targetTitle) {
      const matches = chats.filter(thread => thread.title === targetTitle);
      if (matches.length !== 1) throw new Error(`Expected exactly one ChatGPT conversation named ${targetTitle}; found ${matches.length}.`);
      const target = matches[0];
      const history = await client.callTool('read_thread', {
        threadId: target.id, turnLimit: 2, maxOutputCharsPerItem: 20000, includeOutputs: false,
      });
      if (history.thread?.kind !== 'chatgpt') throw new Error('Target is not a normal ChatGPT conversation.');
      output.target = { id: target.id, title: target.title, kind: history.thread.kind };
      output.history = {
        turnCount: history.turns?.length ?? 0,
        status: history.thread.status,
        itemTypes: [...new Set((history.turns ?? []).flatMap(turn => (turn.items ?? []).map(item => item.type)))],
        truncated: (history.turns ?? []).some(turn => (turn.items ?? []).some(item => item.truncated)),
        hasMore: history.page?.hasMore ?? false,
      };
    }
  } else {
    throw new Error('Supported command: probe [--title conversation-title] [--output evidence.json].');
  }
  if (outputPath) {
    await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code, error: error.message }));
  process.exitCode = 1;
} finally {
  await client?.close();
}
