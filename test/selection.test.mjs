import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.mjs';
import { SelectionUI } from '../src/ui.mjs';

const root = { id: 'test', chatgptThreadId: 'chat-a', chatgptTitle: '示例对话', feishuChatId: 'oc_test', allowedOpenIds: ['ou_owner'] };
const turn = (id, question, answer) => ({ id, status: 'completed', items: [
  { type: 'userMessage', text: question }, { type: 'agentMessage', text: answer },
] });
const event = (id, text = '你好', extra = {}) => ({
  sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
  message: { chat_id: 'oc_test', message_id: id, message_type: 'text', create_time: '2500', content: JSON.stringify({ text }), ...extra },
});
async function fixture() {
  const histories = Object.fromEntries(['a', 'b', 'c'].map(letter => [`chat-${letter}`, {
    thread: { id: `chat-${letter}`, title: letter === 'a' ? '示例对话' : `对话 ${letter}`, kind: letter === 'c' ? 'codex' : 'chatgpt', status: { type: 'idle' } },
    turns: [turn(`old-${letter}`, '原有问题', '原有回答')], page: { hasMore: false },
  }]));
  const store = { data: { version: 1, bindings: {}, inbox: {}, outbox: {} }, async save() {} };
  const sent = [], cards = [], calls = [];
  const desktop = {
    async read(id) { calls.push(['read', id]); return structuredClone(histories[id]); },
    async send(id, prompt) { sent.push({ id, prompt }); },
    async listThreads() { calls.push(['list']); return { pinnedThreads: [histories['chat-a'].thread], threads: [histories['chat-a'].thread, { ...histories['chat-b'].thread, projectId: 'project-gpt' }, histories['chat-c'].thread] }; },
    async listProjects() { return { projects: [{ projectId: 'project-gpt', projectKind: 'chatgpt', label: '示例项目' }, { projectId: 'local', projectKind: 'local', label: '本地代码' }] }; },
  };
  const feishu = { async send(input) { cards.push(input); return { messageId: `om_bot_${cards.length}` }; } };
  const bridge = new Bridge({ config: { bindings: [root] }, store, desktop, feishu, now: () => 2000 });
  await bridge.initialize();
  const ui = new SelectionUI({ bridge, store, desktop, feishu, now: () => 3000 });
  await ui.initialize();
  await ui.tick();
  function callback(type, criteria = () => true) {
    const [cardId, record] = Object.entries(store.data.ui.cards).reverse().find(([, card]) =>
      Object.values(card.actions).some(action => action.type === type && criteria(action)));
    const [actionId] = Object.entries(record.actions).find(([, action]) => action.type === type && criteria(action));
    return { token: `token-${Math.random()}`, context: { open_message_id: record.messageId, open_chat_id: 'oc_test' },
      operator: { open_id: 'ou_owner' }, action: { value: { ui: 'chatgpt_bridge_v1', card: cardId, action: actionId } } };
  }
  return { histories, store, sent, cards, calls, desktop, feishu, bridge, ui, callback };
}

test('menu callbacks acknowledge durably before native reads; inventory includes only ordinary ChatGPT', async () => {
  const f = await fixture();
  const callback = f.callback('chats');
  const before = f.calls.length;
  assert.equal((await f.ui.acceptAction(callback)).toast.type, 'info');
  assert.equal(f.calls.length, before, 'callback path must not wait for native MCP');
  await f.ui.acceptAction(callback);
  await f.ui.tick();
  assert.equal(f.cards.length, 2, 'redelivered callback is processed once');
  const shown = JSON.stringify(f.cards[1].card);
  assert.match(shown, /示例对话/);
  assert.match(shown, /对话 b/);
  assert.doesNotMatch(shown, /对话 c/);
  assert.equal(f.sent.length, 0);
  await f.ui.acceptAction(f.callback('projects'));
  await f.ui.tick();
  const projects = JSON.stringify(f.cards.at(-1).card);
  assert.match(projects, /示例项目/);
  assert.doesNotMatch(projects, /本地代码/);
});

test('private callbacks reject other users/chats, forged cards/actions, expired cards, and missing IDs', async () => {
  const f = await fixture();
  const valid = f.callback('chats');
  const invalid = [
    { ...valid, operator: { open_id: 'ou_other' } },
    { ...valid, context: { ...valid.context, open_chat_id: 'oc_other' } },
    { ...valid, context: { ...valid.context, open_message_id: 'om_forged' } },
    { ...valid, action: { value: { ...valid.action.value, card: 'constructor' } } },
    { ...valid, action: { value: { ...valid.action.value, action: '__proto__' } } },
    { ...valid, token: undefined },
  ];
  for (const raw of invalid) assert.equal((await f.ui.acceptAction(raw)).toast.type, 'error');
  f.ui.now = () => 8 * 86400000;
  assert.equal((await f.ui.acceptAction(valid)).toast.type, 'error');
  await f.ui.tick();
  assert.equal(f.cards.length, 1);
  assert.equal(f.sent.length, 0);
});

test('selecting a new conversation preserves queued and in-flight targets, including callback tampering', async () => {
  const f = await fixture();
  await f.bridge.accept(event('om_a'));
  await f.ui.acceptAction(f.callback('chats'));
  await f.ui.tick();
  const select = f.callback('select', action => action.threadId === 'chat-b');
  select.action.value.threadId = 'chat-c'; // Client fields cannot override the server-issued action.
  await f.ui.acceptAction(select);
  await f.ui.tick();
  assert.equal(f.bridge.currentBinding(root.id).chatgptThreadId, 'chat-b');
  assert.equal((await f.bridge.accept(event('om_a'))).duplicate, true, 'deduplication survives a switch');
  await f.bridge.accept(event('om_b'));
  await f.bridge.tick();
  assert.deepEqual(f.sent.map(message => message.id).sort(), ['chat-a', 'chat-b']);
  for (const message of f.sent) f.histories[message.id].turns.unshift(turn(`new-${message.id}`, message.prompt, `回答来自 ${message.id}`));
  await f.bridge.tick();
  const replies = f.cards.filter(item => !item.card);
  assert.equal(replies.length, 2);
  assert.match(replies.find(item => item.replyTo === 'om_a').text, /回答来自 chat-a/);
  assert.match(replies.find(item => item.replyTo === 'om_b').text, /回答来自 chat-b/);
  assert.equal(f.bridge.activeBindings().length, 1, 'finished old bindings stop polling');
  await f.bridge.tick();
  assert.equal(f.cards.filter(item => !item.card).length, 2, 'no duplicate completions');
});

test('selection persists across restart and returning to an inactive chat does not replay its history', async () => {
  const f = await fixture();
  await f.bridge.select(root.id, 'chat-b');
  await f.bridge.initialize();
  await f.ui.initialize();
  await f.ui.tick();
  assert.equal(f.bridge.currentBinding(root.id).chatgptThreadId, 'chat-b');
  assert.equal(f.cards.length, 1, 'installation card is not replayed');
  f.histories['chat-a'].turns.unshift(turn('offline-a', '离开时的问题', '离开时的回答'));
  await f.bridge.select(root.id, 'chat-a');
  await f.bridge.tick();
  assert.equal(f.cards.length, 1, 'old content is a new observation baseline');
});

test('a quote reply returns to its source conversation after selecting a different target', async () => {
  const f = await fixture();
  await f.bridge.accept(event('om_original'));
  await f.bridge.tick();
  f.histories['chat-a'].turns.unshift(turn('answer-a', f.sent[0].prompt, 'A 的回答'));
  await f.bridge.tick();
  const responseId = Object.values(f.store.data.outbox)[0].parts[0].messageId;
  await f.bridge.select(root.id, 'chat-b');
  await f.bridge.accept(event('om_quote', '追问 A', { parent_id: responseId }));
  await f.bridge.tick();
  assert.equal(f.sent.at(-1).id, 'chat-a');
  assert.equal(f.bridge.currentBinding(root.id).chatgptThreadId, 'chat-b', 'quoted replies do not change the menu selection');
});

test('native identity must confirm an ordinary ChatGPT target before selection changes', async () => {
  const f = await fixture();
  await assert.rejects(f.bridge.select(root.id, 'chat-c'), /IDENTITY_MISMATCH/);
  assert.equal(f.bridge.currentBinding(root.id).chatgptThreadId, 'chat-a');
  assert.equal(f.sent.length, 0);
});

test('menu commands and latest-round actions never become model prompts', async () => {
  const f = await fixture();
  assert.equal(await f.ui.acceptMessage(event('om_menu', '菜单')), true);
  assert.equal(await f.ui.acceptMessage(event('om_menu', '菜单')), true);
  await f.ui.tick();
  await f.ui.acceptAction(f.callback('last'));
  await f.ui.tick();
  assert.match(JSON.stringify(f.cards.at(-1).card), /原有回答/);
  assert.equal(f.sent.length, 0);
  assert.equal(Object.keys(f.store.data.inbox).length, 0);
  assert.equal(await f.ui.acceptMessage(event('om_regular', '正常问题')), false);
});

test('a lost card send receipt is recorded as unknown and never retried after restart', async () => {
  const f = await fixture();
  let attempts = 0;
  f.feishu.send = async () => { attempts++; throw new Error('lost response'); };
  await f.ui.acceptMessage(event('om_menu2', '菜单'));
  await f.ui.tick();
  await f.ui.initialize();
  await f.ui.tick();
  assert.equal(attempts, 1);
  assert.equal(Object.values(f.store.data.ui.commands).at(-1).status, 'UNKNOWN');
});
