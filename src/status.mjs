import { readFile } from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve(process.argv[2] || 'runtime/service');
try {
  const state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  const counts = entries => Object.values(entries).reduce((result, entry) => {
    result[entry.status] = (result[entry.status] || 0) + 1;
    return result;
  }, {});
  console.log(JSON.stringify({
    stateDirectory: directory,
    bindings: Object.entries(state.bindings).map(([id, binding]) => ({ id, chatgptThreadId: binding.chatgptThreadId, feishuChatId: binding.feishuChatId })),
    selections: state.selections,
    ui: state.ui ? { commands: counts(state.ui.commands), cards: counts(state.ui.cards) } : undefined,
    incoming: counts(state.inbox), outgoing: counts(state.outbox),
    unknown: [
      ...Object.values(state.inbox).filter(entry => entry.status === 'UNKNOWN').map(entry => ({ direction: 'to-chatgpt', key: entry.key })),
      ...Object.values(state.outbox).filter(entry => entry.status === 'UNKNOWN').map(entry => ({ direction: 'to-feishu', key: entry.key })),
    ],
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'UNAVAILABLE', error: error.code || error.message }));
  process.exitCode = 1;
}
