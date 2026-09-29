import { createHash } from 'node:crypto';
import { textOf } from './chatgpt.mjs';

const keyOf = value => createHash('sha256').update(value).digest('hex');
const pending = entry => ['SENDING', 'WAITING_ANSWER', 'UNKNOWN'].includes(entry.status);

export function validateConfig(config) {
  if (!Array.isArray(config.bindings) || !config.bindings.length) throw new Error('At least one explicit conversation binding is required.');
  const ids = new Set(), chats = new Set(), threads = new Set();
  for (const binding of config.bindings) {
    for (const field of ['id', 'feishuChatId', 'chatgptThreadId', 'chatgptTitle']) {
      if (typeof binding[field] !== 'string' || !binding[field].trim()) throw new Error(`Binding requires ${field}.`);
    }
    if (['__proto__', 'constructor', 'prototype'].includes(binding.id)) throw new Error('Reserved binding ID.');
    if (!Array.isArray(binding.allowedOpenIds) || !binding.allowedOpenIds.length || binding.allowedOpenIds.some(id => typeof id !== 'string' || !id.startsWith('ou_'))) {
      throw new Error('Each binding requires a non-empty Feishu user allowlist.');
    }
    if (!binding.feishuChatId.startsWith('oc_')) throw new Error('Expected a Feishu chat_id.');
    if (ids.has(binding.id) || chats.has(binding.feishuChatId) || threads.has(binding.chatgptThreadId)) {
      throw new Error('Bindings must map one Feishu chat to one unique ChatGPT conversation.');
    }
    ids.add(binding.id); chats.add(binding.feishuChatId); threads.add(binding.chatgptThreadId);
  }
  return config;
}

export function splitText(text, maxBytes = 6000) {
  const parts = [];
  let part = '', bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes && part) { parts.push(part); part = ''; bytes = 0; }
    part += character; bytes += size;
  }
  if (part) parts.push(part);
  return parts;
}

export class Bridge {
  constructor({ config, store, desktop, feishu, now = () => Date.now(), log = () => {} }) {
    this.config = validateConfig(config);
    this.store = store;
    this.desktop = desktop;
    this.feishu = feishu;
    this.now = now;
    this.log = log;
    this.busy = false;
  }

  async initialize() {
    this.store.data.selections ??= {};
    for (const binding of this.config.bindings) {
      const previous = this.store.data.bindings[binding.id];
      if (previous && (previous.chatgptThreadId !== binding.chatgptThreadId || previous.feishuChatId !== binding.feishuChatId)) {
        throw new Error('BINDING_CHANGED: use a new binding ID and a fresh state directory.');
      }
      const history = await this.read(binding);
      if (!previous) {
        this.store.data.bindings[binding.id] = {
          chatgptThreadId: binding.chatgptThreadId, feishuChatId: binding.feishuChatId,
          startedAt: this.now(), knownTurnIds: (history.turns ?? []).map(turn => turn.id),
          baselineCompletedIds: (history.turns ?? []).filter(turn => turn.status === 'completed').map(turn => turn.id),
        };
      }
      Object.assign(this.store.data.bindings[binding.id], {
        rootBindingId: binding.id, chatgptTitle: previous?.chatgptTitle || binding.chatgptTitle,
      });
      this.store.data.selections[binding.id] ??= binding.id;
    }
    for (const entry of Object.values(this.store.data.inbox)) {
      if (entry.status === 'SENDING') entry.status = 'UNKNOWN';
    }
    for (const entry of Object.values(this.store.data.outbox)) {
      if (entry.status === 'SENDING') entry.status = 'UNKNOWN';
    }
    // Verify persisted selections and outstanding work without changing their targets.
    for (const binding of this.activeBindings()) {
      if (!this.config.bindings.some(root => root.id === binding.id)) await this.read(binding);
    }
    await this.store.save();
  }

  authorizedRoot(chatId, openId) {
    return this.config.bindings.find(root => root.feishuChatId === chatId && root.allowedOpenIds.includes(openId));
  }

  binding(id) {
    const state = Object.hasOwn(this.store.data.bindings, id) ? this.store.data.bindings[id] : undefined;
    const root = state && this.config.bindings.find(item => item.id === state.rootBindingId);
    if (!root || state.feishuChatId !== root.feishuChatId) throw new Error('INVALID_STORED_BINDING');
    return { ...root, id, rootBindingId: root.id, chatgptThreadId: state.chatgptThreadId, chatgptTitle: state.chatgptTitle };
  }

  currentBinding(rootId) {
    return this.binding(this.store.data.selections[rootId]);
  }

  messageBinding(root, message) {
    for (const replyId of [message.parent_id, message.root_id].filter(Boolean)) {
      const outgoing = Object.values(this.store.data.outbox).find(entry => entry.parts.some(part => part.messageId === replyId));
      const incoming = Object.values(this.store.data.inbox).find(entry => entry.feishuMessageId === replyId);
      const id = outgoing?.bindingId ?? incoming?.bindingId;
      if (id) {
        const binding = this.binding(id);
        if (binding.rootBindingId === root.id) return binding;
      }
    }
    return this.currentBinding(root.id);
  }

  hasWork(id) {
    return Object.values(this.store.data.inbox).some(entry => entry.bindingId === id && (entry.status === 'QUEUED' || pending(entry)))
      || Object.values(this.store.data.outbox).some(entry => entry.bindingId === id && entry.status === 'PREPARED');
  }

  activeBindings() {
    const selected = new Set(Object.values(this.store.data.selections));
    return Object.entries(this.store.data.bindings)
      .filter(([id, state]) => selected.has(id) || state.watchUntilIdle || this.hasWork(id))
      .map(([id]) => this.binding(id));
  }

  async select(rootId, threadId) {
    const root = this.config.bindings.find(item => item.id === rootId);
    if (!root) throw new Error('UNKNOWN_ROUTE');
    const current = this.currentBinding(rootId);
    const target = { ...root, chatgptThreadId: threadId };
    const history = await this.read(target); // Never bind a Codex task or an unverified identity.
    if (this.activeBindings().some(item => item.rootBindingId !== rootId && item.chatgptThreadId === threadId)) {
      throw new Error('CONVERSATION_ALREADY_BOUND');
    }
    const title = history.thread.title || (threadId === current.chatgptThreadId ? current.chatgptTitle : threadId);
    if (current.chatgptThreadId === threadId) {
      this.store.data.bindings[current.id].chatgptTitle = title;
      await this.store.save();
      return this.currentBinding(rootId);
    }
    // Finish observing the previous target before switching. Queued and in-flight
    // messages retain their immutable binding ID and keep being polled afterwards.
    const previousStatus = await this.poll(current);
    this.store.data.bindings[current.id].watchUntilIdle = previousStatus !== 'idle';
    const id = threadId === root.chatgptThreadId ? root.id : `${root.id}~${keyOf(threadId).slice(0, 20)}`;
    let state = this.store.data.bindings[id];
    if (!state) {
      state = this.store.data.bindings[id] = {
        rootBindingId: rootId, feishuChatId: root.feishuChatId,
        chatgptThreadId: threadId, chatgptTitle: title, startedAt: this.now(),
        knownTurnIds: [], baselineCompletedIds: [],
      };
    }
    if (state.chatgptThreadId !== threadId || state.rootBindingId !== rootId) throw new Error('BINDING_ID_COLLISION');
    // Re-entering an inactive conversation starts from now; it must not flood
    // Feishu with old work. Keep the old cursor if a request is still outstanding.
    if (!this.hasWork(id) && !state.watchUntilIdle) {
      state.knownTurnIds = (history.turns ?? []).map(turn => turn.id);
      state.baselineCompletedIds = [...new Set([...state.baselineCompletedIds,
        ...(history.turns ?? []).filter(turn => turn.status === 'completed').map(turn => turn.id)])];
    }
    state.chatgptTitle = title;
    state.selectedAt = this.now();
    this.store.data.selections[rootId] = id;
    await this.store.save();
    this.log({ type: 'conversation-selected', rootId, bindingId: id, threadId });
    return this.currentBinding(rootId);
  }

  async read(binding, cursor) {
    const history = await this.desktop.read(binding.chatgptThreadId, cursor);
    if (history.thread?.id !== binding.chatgptThreadId || history.thread?.kind !== 'chatgpt') {
      throw new Error('CHAT_IDENTITY_MISMATCH');
    }
    return history;
  }

  async accept(event) {
    const { sender, message } = event ?? {};
    if (!message || sender?.sender_type !== 'user' || message.message_type !== 'text') return { accepted: false };
    const root = this.authorizedRoot(message.chat_id, sender.sender_id?.open_id);
    if (!root) return { accepted: false };
    const binding = this.messageBinding(root, message);
    if (typeof message.message_id !== 'string' || message.message_id.length > 256) return { accepted: false };
    let text;
    try { text = JSON.parse(message.content).text; } catch { return { accepted: false }; }
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 16000) return { accepted: false };
    const created = Number(message.create_time);
    const state = this.store.data.bindings[root.id];
    if (!state || !Number.isFinite(created) || created < state.startedAt || created > this.now() + 60000) return { accepted: false };
    const key = keyOf(`${root.id}:${message.message_id}`);
    if (Object.hasOwn(this.store.data.inbox, key)) return { accepted: false, duplicate: true };
    this.store.data.inbox[key] = {
      key, bindingId: binding.id, feishuMessageId: message.message_id, createdAt: created,
      chatgptThreadId: binding.chatgptThreadId, feishuChatId: binding.feishuChatId,
      prompt: `来自飞书的消息：\n${text.trim()}\n\n转发标识：${key.slice(0, 16)}`,
      status: 'QUEUED',
    };
    await this.store.save();
    return { accepted: true, key };
  }

  async poll(binding) {
    const state = this.store.data.bindings[binding.id];
    const known = new Set(state.knownTurnIds);
    const baseline = new Set(state.baselineCompletedIds);
    const turns = [];
    let page = await this.read(binding), count = 0;
    const threadStatus = page.thread.status?.type;
    while (true) {
      const batch = page.turns ?? [];
      turns.push(...batch);
      if (batch.some(turn => known.has(turn.id)) || !page.page?.hasMore) break;
      if (!page.page.nextCursor || ++count >= 10) throw new Error('HISTORY_GAP: stopped without advancing the cursor.');
      page = await this.read(binding, page.page.nextCursor);
    }
    const incoming = Object.values(this.store.data.inbox).filter(entry => entry.bindingId === binding.id);
    // The API returns newest first. Forward completed turns in chronological order.
    for (const turn of [...turns].reverse()) {
      const matched = incoming.find(entry => (turn.items ?? []).some(item =>
        item.type === 'userMessage' && !item.truncated && textOf(item) === entry.prompt));
      if (matched && pending(matched) && turn.status !== 'completed') {
        matched.status = ['failed', 'interrupted', 'cancelled'].includes(turn.status) ? 'FAILED' : 'WAITING_ANSWER';
      }
      if (turn.status !== 'completed' || baseline.has(turn.id)) continue;
      const answers = (turn.items ?? []).filter(item => item.type === 'agentMessage');
      if (!answers.length) continue;
      const key = keyOf(`${binding.id}:${turn.id}`);
      if (Object.hasOwn(this.store.data.outbox, key)) continue;
      if (matched) matched.status = 'COMPLETED';
      const truncated = answers.some(item => item.truncated);
      const question = (turn.items ?? []).find(item => item.type === 'userMessage');
      const prefix = `ChatGPT · ${binding.chatgptTitle}\n\n`;
      const text = truncated
        ? prefix + '本次回答超过桌面 MCP 的读取上限，完整内容请在原对话查看。'
        : prefix + (!matched && question ? `问：${textOf(question)}\n\n答：` : '') + answers.map(textOf).join('\n\n');
      this.store.data.outbox[key] = {
        key, bindingId: binding.id, turnId: turn.id, status: 'PREPARED',
        replyTo: matched?.feishuMessageId, truncated,
        parts: splitText(text).map((part, index) => ({ text: part, uuid: keyOf(`${key}:${index}`).slice(0, 32), status: 'PREPARED' })),
      };
    }
    state.knownTurnIds = [...new Set([...state.knownTurnIds, ...turns.map(turn => turn.id)])];
    await this.store.save();
    return threadStatus;
  }

  async sendNext(binding, threadStatus) {
    const entries = Object.values(this.store.data.inbox).filter(entry => entry.bindingId === binding.id);
    if (threadStatus !== 'idle' || entries.some(pending)) return;
    const next = entries.filter(entry => entry.status === 'QUEUED').sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!next) return;
    next.status = 'SENDING';
    await this.store.save();
    try {
      await this.desktop.send(binding.chatgptThreadId, next.prompt);
      next.status = 'WAITING_ANSWER';
    } catch {
      next.status = 'UNKNOWN';
      this.log({ type: 'desktop-send-unknown', key: next.key });
    }
    await this.store.save();
  }

  async flush(binding) {
    const outgoing = Object.values(this.store.data.outbox).filter(entry => entry.bindingId === binding.id && entry.status === 'PREPARED');
    for (const entry of outgoing) {
      for (let index = 0; index < entry.parts.length; index++) {
        const part = entry.parts[index];
        if (part.status === 'API_ACCEPTED') continue;
        entry.status = part.status = 'SENDING';
        await this.store.save();
        try {
          const receipt = await this.feishu.send({
            chatId: binding.feishuChatId, replyTo: entry.replyTo, uuid: part.uuid,
            text: entry.parts.length > 1 ? `[${index + 1}/${entry.parts.length}]\n${part.text}` : part.text,
          });
          if (!receipt?.messageId) throw new Error('Missing Feishu message receipt.');
          part.messageId = receipt.messageId;
          part.status = 'API_ACCEPTED';
        } catch {
          entry.status = part.status = 'UNKNOWN';
          this.log({ type: 'feishu-send-unknown', key: entry.key, part: index });
          await this.store.save();
          break;
        }
        await this.store.save();
      }
      if (entry.parts.every(part => part.status === 'API_ACCEPTED')) entry.status = 'API_ACCEPTED';
      await this.store.save();
    }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const binding of this.activeBindings()) {
        try {
          const status = await this.poll(binding);
          await this.flush(binding);
          await this.sendNext(binding, status);
          if (status === 'idle') this.store.data.bindings[binding.id].watchUntilIdle = false;
        } catch (error) {
          this.log({ type: 'binding-poll-failed', bindingId: binding.id });
          throw error;
        }
      }
    } finally { this.busy = false; }
  }
}
