import test from 'node:test';
import assert from 'node:assert/strict';
import { Feishu } from '../src/feishu.mjs';

test('Feishu requires an API success code and a matching-chat message receipt', async () => {
  const adapter = new Feishu({ appId: 'cli_offline_test', appSecret: 'offline_test_only' });
  let result = { code: 230002, msg: 'not in chat' };
  adapter.client = { im: { message: { reply: async () => result } } };
  const input = { chatId: 'oc_test', replyTo: 'om_user', text: 'test', uuid: 'test-uuid' };
  await assert.rejects(adapter.send(input), /FEISHU_API_ERROR:230002/);
  result = { code: 0, data: { message_id: 'om_reply', chat_id: 'oc_wrong' } };
  await assert.rejects(adapter.send(input), /CHAT_MISMATCH/);
  result.data.chat_id = 'oc_test';
  assert.deepEqual(await adapter.send(input), { messageId: 'om_reply' });
  adapter.close();
});

test('selection cards use the interactive message API and retain deduplication UUID', async () => {
  const adapter = new Feishu({ appId: 'cli_offline_test', appSecret: 'offline_test_only' });
  let payload;
  adapter.client = { im: { message: { create: async input => {
    payload = input; return { code: 0, data: { message_id: 'om_card', chat_id: 'oc_test' } };
  } } } };
  const card = { schema: '2.0', body: { elements: [] } };
  await adapter.send({ chatId: 'oc_test', card, uuid: 'unique-card' });
  assert.equal(payload.data.msg_type, 'interactive');
  assert.deepEqual(JSON.parse(payload.data.content), card);
  assert.equal(payload.data.uuid, 'unique-card');
  adapter.close();
});
