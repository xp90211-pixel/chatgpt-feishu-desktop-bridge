export function textOf(item) {
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  return (item.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
}

export async function resolveChat(client, title) {
  const inventory = await client.callTool('list_threads', { limit: 50 });
  const unique = new Map([...(inventory.pinnedThreads ?? []), ...(inventory.threads ?? [])]
    .filter(thread => thread.kind === 'chatgpt' && thread.title === title)
    .map(thread => [thread.id, thread]));
  if (unique.size !== 1) throw new Error(`Expected one ordinary ChatGPT conversation named ${title}; found ${unique.size}.`);
  return [...unique.values()][0];
}

export async function readChat(client, threadId, { cursor, turnLimit = 10 } = {}) {
  const result = await client.callTool('read_thread', {
    threadId, turnLimit, maxOutputCharsPerItem: 20000, includeOutputs: false,
    ...(cursor ? { cursor } : {}),
  });
  if (result.thread?.id !== threadId || result.thread?.kind !== 'chatgpt') {
    throw new Error('CHAT_IDENTITY_MISMATCH: expected the bound ordinary ChatGPT conversation.');
  }
  return result;
}

export function findReply(history, prompt) {
  const turn = (history.turns ?? []).find(candidate => (candidate.items ?? [])
    .some(item => item.type === 'userMessage' && !item.truncated && textOf(item) === prompt));
  if (!turn) return null;
  const replies = (turn.items ?? []).filter(item => item.type === 'agentMessage');
  if (turn.status !== 'completed' || replies.length === 0 || replies.some(item => item.truncated)) return null;
  return {
    turnId: turn.id,
    assistantItemIds: replies.map(item => item.id),
    text: replies.map(textOf).join('\n\n'),
    status: turn.status,
  };
}
