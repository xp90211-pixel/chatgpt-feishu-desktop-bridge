import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, splitText, validateConfig } from '../src/bridge.mjs';
import { findReply, readChat } from '../src/chatgpt.mjs';
import { DesktopMcpClient } from '../src/mcp-client.mjs';

const config = { bindings: [{ id: 'test', chatgptThreadId: 'gpt-test', chatgptTitle: '示例对话', feishuChatId: 'oc_test', allowedOpenIds: ['ou_owner'] }] };
const turn = (id, question, answer, extra = {}) => ({
  id, status: 'completed', items: [
    { id: `${id}-u`, type: 'userMessage', content: [{ type: 'text', text: question }] },
    { id: `${id}-a`, type: 'agentMessage', text: answer },
  ], ...extra,
});
const event = (id = 'om_1', overrides = {}) => ({
  sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
  message: { chat_id: 'oc_test', message_id: id, message_type: 'text', create_time: '2000', content: '{"text":"你好"}' },
  ...overrides,
});
async function setup() {
  const state = { version: 1, bindings: {}, inbox: {}, outbox: {} };
  const history = { thread: { id: 'gpt-test', kind: 'chatgpt', status: { type: 'idle' } }, turns: [turn('old', '旧问题', '旧回答')], page: { hasMore: false } };
  const sends = [], forwarded = [], snapshots = [];
  const store = { data: state, async save() { snapshots.push(structuredClone(this.data)); } };
  const desktop = { async read() { return structuredClone(history); }, async send(id, prompt) { sends.push({ id, prompt }); } };
  const feishu = { async send(data) { forwarded.push(data); return { messageId: `om_reply${forwarded.length}` }; } };
  const bridge = new Bridge({ config, store, desktop, feishu, now: () => 1000 });
  await bridge.initialize();
  return { bridge, state, history, sends, forwarded, snapshots, store, desktop, feishu };
}

test('round trip stays in the bound conversation and deduplicates repeated Feishu delivery', async () => {
  const f = await setup();
  assert.equal((await f.bridge.accept(event())).accepted, true);
  assert.equal((await f.bridge.accept(event())).duplicate, true);
  await f.bridge.tick();
  assert.equal(f.forwarded.length, 0, 'historical answers must not be forwarded');
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].id, 'gpt-test');
  assert.ok(f.snapshots.some(snapshot => Object.values(snapshot.inbox)[0]?.status === 'SENDING'));
  f.history.turns.unshift(turn('new', f.sends[0].prompt, '你好，已收到。'));
  await f.bridge.tick();
  await f.bridge.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.forwarded.length, 1);
  assert.equal(f.forwarded[0].chatId, 'oc_test');
  assert.equal(f.forwarded[0].replyTo, 'om_1');
  assert.match(f.forwarded[0].text, /你好，已收到/);
  assert.equal(Object.values(f.state.outbox)[0].status, 'API_ACCEPTED');
});

test('bot echoes, other senders, other chats, and pre-binding messages are ignored', async () => {
  const f = await setup();
  const inputs = [
    event('om_bot', { sender: { sender_type: 'app', sender_id: { open_id: 'ou_owner' } } }),
    event('om_other', { sender: { sender_type: 'user', sender_id: { open_id: 'ou_other' } } }),
    { ...event(), message: { ...event().message, chat_id: 'oc_other' } },
    { ...event(), message: { ...event().message, create_time: '999' } },
  ];
  for (const input of inputs) assert.equal((await f.bridge.accept(input)).accepted, false);
  await f.bridge.tick();
  assert.equal(f.sends.length, 0);
});

test('an unknown desktop write is never replayed and blocks later writes to that conversation', async () => {
  const f = await setup();
  f.desktop.send = async (id, prompt) => { f.sends.push({ id, prompt }); throw new Error('timeout after transmission'); };
  await f.bridge.accept(event());
  await f.bridge.accept(event('om_2'));
  await f.bridge.tick();
  await f.bridge.initialize();
  await f.bridge.tick();
  assert.equal(f.sends.length, 1);
  assert.deepEqual(Object.values(f.state.inbox).map(entry => entry.status), ['UNKNOWN', 'QUEUED']);
  f.history.turns.unshift(turn('late', f.sends[0].prompt, '延迟到达的回复'));
  await f.bridge.tick();
  assert.equal(f.forwarded.length, 1);
  assert.equal(f.sends.length, 2, 'the second queued message may start after read-back confirms the first');
  assert.notEqual(f.sends[0].prompt, f.sends[1].prompt);
});

test('a crash with SENDING recorded resumes with read-only reconciliation', async () => {
  const f = await setup();
  await f.bridge.accept(event());
  const entry = Object.values(f.state.inbox)[0];
  entry.status = 'SENDING';
  await f.bridge.initialize();
  await f.bridge.tick();
  assert.equal(entry.status, 'UNKNOWN');
  assert.equal(f.sends.length, 0);
});

test('ambiguous Feishu send outcomes are not automatically repeated across restart', async () => {
  const f = await setup();
  f.feishu.send = async data => { f.forwarded.push(data); throw new Error('connection lost after submission'); };
  f.history.turns.unshift(turn('new', '桌面提问', '桌面回答'));
  await f.bridge.tick();
  await f.bridge.initialize();
  await f.bridge.tick();
  assert.equal(f.forwarded.length, 1);
  assert.equal(Object.values(f.state.outbox)[0].status, 'UNKNOWN');
});

test('only completed answers are forwarded; truncation is explicitly reported', async () => {
  const f = await setup();
  const current = turn('new', '新问题', '部分答案', { status: 'inProgress' });
  f.history.turns.unshift(current);
  await f.bridge.tick();
  assert.equal(f.forwarded.length, 0);
  current.status = 'completed';
  current.items[1].truncated = true;
  await f.bridge.tick();
  assert.equal(f.forwarded.length, 1);
  assert.match(f.forwarded[0].text, /超过桌面 MCP 的读取上限/);
  assert.doesNotMatch(f.forwarded[0].text, /部分答案/);
});

test('pagination gathers all new turns before advancing the observation boundary', async () => {
  const f = await setup();
  f.desktop.read = async (_id, cursor) => cursor
    ? { ...f.history, turns: [turn('new1', '一', '一答'), ...f.history.turns] }
    : { ...f.history, turns: [turn('new2', '二', '二答')], page: { hasMore: true, nextCursor: 'page2' } };
  await f.bridge.tick();
  assert.equal(f.forwarded.length, 2);
  assert.match(f.forwarded[0].text, /一答/);
  assert.match(f.forwarded[1].text, /二答/);
});

test('an unresolved history gap causes no sends and does not advance stored boundaries', async () => {
  const f = await setup();
  f.desktop.read = async () => ({ ...f.history, turns: [turn('new', '一', '一答')], page: { hasMore: true, nextCursor: 'loop' } });
  await assert.rejects(f.bridge.tick(), /HISTORY_GAP/);
  assert.equal(f.forwarded.length, 0);
  assert.deepEqual(f.state.bindings.test.knownTurnIds, ['old']);
});

test('conversation identity and missing native app context fail closed', async () => {
  await assert.rejects(readChat({ callTool: async () => ({ thread: { id: 'wrong', kind: 'chatgpt' } }) }, 'expected'), /IDENTITY_MISMATCH/);
  assert.throws(() => new DesktopMcpClient({ env: {} }), /APP_CONTEXT_REQUIRED/);
  const f = await setup();
  f.history.thread.kind = 'codex';
  await assert.rejects(f.bridge.tick(), /IDENTITY_MISMATCH/);
  assert.equal(f.sends.length, 0);
});

test('configuration cannot route one Feishu chat to multiple conversations', () => {
  assert.throws(() => validateConfig({ bindings: [config.bindings[0], { ...config.bindings[0], id: 'two', chatgptThreadId: 'gpt-two' }] }), /one Feishu chat/);
  assert.throws(() => validateConfig({ bindings: [{ ...config.bindings[0], allowedOpenIds: [] }] }), /allowlist/);
});

test('UTF-8 splitting preserves emoji and content without exceeding the byte cap', () => {
  const text = '中文😃'.repeat(3000);
  const parts = splitText(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(part => Buffer.byteLength(part) <= 6000));
});

test('test receipt matching requires the exact prompt and complete, untruncated assistant output', () => {
  const history = { turns: [turn('t', 'exact prompt', 'ACK')] };
  assert.equal(findReply(history, 'different prompt'), null);
  assert.equal(findReply(history, 'exact prompt').text, 'ACK');
  history.turns[0].items[1].truncated = true;
  assert.equal(findReply(history, 'exact prompt'), null);
});
