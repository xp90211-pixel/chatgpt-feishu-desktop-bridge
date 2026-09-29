import test from 'node:test';
import assert from 'node:assert/strict';
import { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { CardWebSocket } from '../src/card-websocket.mjs';

const logger = { debug() {}, trace() {}, info() {}, warn() {}, error() {} };
function setup(type, handler) {
  const ws = new CardWebSocket({ appId: 'cli_offline_test', appSecret: 'offline_test_only', logger });
  const replies = [];
  ws.sendMessage = frame => replies.push(frame);
  const eventType = type === 'card' ? 'card.action.trigger' : 'im.message.receive_v1';
  ws.eventDispatcher = new EventDispatcher({ logger }).register({ [eventType]: handler });
  const event = { token: 'interaction-token', context: { open_message_id: 'om_menu', open_chat_id: 'oc_test' },
    operator: { open_id: 'ou_owner' }, action: { value: { ui: 'chatgpt_bridge_v1' } } };
  const frame = { method: 1, seqID: 1, logID: 1, service: 1,
    headers: [{ key: 'type', value: type }, { key: 'message_id', value: 'frame-1' },
      { key: 'sum', value: '1' }, { key: 'seq', value: '0' }, { key: 'trace_id', value: 'trace-1' }],
    payload: Buffer.from(JSON.stringify({ schema: '2.0', header: { event_id: 'event-1', event_type: eventType }, event })),
  };
  return { ws, frame, event, replies };
}

test('CARD frames reach the real SDK dispatcher and return a toast using original card headers', async () => {
  let received;
  const f = setup('card', async event => { received = event; return { toast: { type: 'info', content: '正在读取' } }; });
  await f.ws.handleEventData(f.frame);
  assert.equal(received.context.open_message_id, 'om_menu');
  assert.equal(received.operator.open_id, 'ou_owner');
  assert.equal(received.token, 'interaction-token');
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].headers.find(item => item.key === 'type').value, 'card');
  const response = JSON.parse(new TextDecoder().decode(f.replies[0].payload));
  assert.equal(response.code, 200);
  assert.equal(JSON.parse(Buffer.from(response.data, 'base64').toString()).toast.content, '正在读取');
  f.ws.close({ force: true });
});

test('ordinary EVENT frames keep using the upstream dispatcher', async () => {
  let count = 0;
  const f = setup('event', async () => { count++; });
  await f.ws.handleEventData(f.frame);
  assert.equal(count, 1);
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].headers.find(item => item.key === 'type').value, 'event');
  f.ws.close({ force: true });
});

test('failed card handlers return an error acknowledgment without leaking handler details', async () => {
  const f = setup('card', async () => { throw new Error('private diagnostic'); });
  await f.ws.handleEventData(f.frame);
  const response = new TextDecoder().decode(f.replies[0].payload);
  assert.deepEqual(JSON.parse(response), { code: 500 });
  assert.doesNotMatch(response, /private/);
  f.ws.close({ force: true });
});
