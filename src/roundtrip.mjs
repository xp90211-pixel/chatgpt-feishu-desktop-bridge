import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DesktopMcpClient } from './mcp-client.mjs';
import { findReply, readChat, resolveChat } from './chatgpt.mjs';

const option = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const journal = path.resolve(option('--journal') || 'runtime/roundtrip');
const sendOnce = process.argv.includes('--send-once');
let client;
try {
  client = new DesktopMcpClient();
  await client.start();
  await mkdir(journal, { recursive: true });
  let intent;
  if (sendOnce) {
    const title = option('--title');
    if (!title) throw new Error('--title is required for the user-authorized one-message test.');
    const target = await resolveChat(client, title);
    const before = await readChat(client, target.id);
    if (before.thread.status?.type !== 'idle') throw new Error('TARGET_BUSY: wait for the conversation to be idle.');
    const nonce = 'CHATGPT-FEISHU-MCP-' + randomUUID();
    intent = {
      createdAt: new Date().toISOString(),
      target: { id: target.id, title: target.title, kind: 'chatgpt' }, nonce,
      prompt: `这是用户授权的桌面 MCP 连通性测试。请仅回复：ACK:${nonce}。不要执行任何其他任务。`,
      expectedReply: `ACK:${nonce}`,
      route: 'node -> bundled-stdio-mcp -> desktop-pipe -> original-chatgpt-conversation',
    };
    // The exclusive intent file is written BEFORE sending. Reusing this directory
    // can only read back the existing attempt, never repeat the write.
    await writeFile(path.join(journal, 'intent.json'), JSON.stringify(intent, null, 2) + '\n', { flag: 'wx' });
    try {
      const result = await client.callTool('send_message_to_thread', { threadId: target.id, prompt: intent.prompt });
      await writeFile(path.join(journal, 'request-returned.json'), JSON.stringify({
        checkedAt: new Date().toISOString(), status: 'REQUEST_RETURNED_NOT_YET_VERIFIED',
        hostStatus: typeof result.status === 'string' ? result.status : undefined,
      }, null, 2) + '\n', { flag: 'wx' });
    } catch (error) {
      await writeFile(path.join(journal, 'send-unknown.json'), JSON.stringify({
        checkedAt: new Date().toISOString(), status: 'UNKNOWN_DO_NOT_RESEND', error: error.message,
      }, null, 2) + '\n', { flag: 'wx' });
      console.log(JSON.stringify({ status: 'send-outcome-unknown', action: 'read-only reconciliation' }));
    }
    console.log(JSON.stringify({ status: 'verifying-original-conversation', target: intent.target, nonce }));
  } else {
    intent = JSON.parse(await readFile(path.join(journal, 'intent.json'), 'utf8'));
  }
  const deadline = Date.now() + 90000;
  let receipt;
  do {
    const history = await readChat(client, intent.target.id);
    const reply = findReply(history, intent.prompt);
    if (reply) {
      const { status: turnStatus, ...replyData } = reply;
      receipt = {
        checkedAt: new Date().toISOString(),
        status: reply.text.trim() === intent.expectedReply ? 'ROUNDTRIP_VERIFIED' : 'REPLIED_WITH_DIFFERENT_TEXT',
        target: intent.target, nonce: intent.nonce, ...replyData, turnStatus,
      };
      break;
    }
    await sleep(5000);
  } while (Date.now() < deadline);
  receipt ||= { checkedAt: new Date().toISOString(), status: 'WAITING_READ_ONLY', target: intent.target, nonce: intent.nonce };
  await writeFile(path.join(journal, `receipt-${Date.now()}.json`), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(receipt, null, 2));
  if (receipt.status !== 'ROUNDTRIP_VERIFIED') process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code, error: error.message }));
  process.exitCode = 1;
} finally {
  await client?.close();
}
