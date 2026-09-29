import { createHash, randomUUID } from 'node:crypto';
import { CardBuilder } from './cards.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const toast = (content, type = 'info') => ({ toast: { type, content } });
const commands = new Map([
  ['菜单', 'menu'], ['/menu', 'menu'], ['/help', 'menu'], ['常用操作', 'menu'],
  ['/chats', 'chats'], ['/tasks', 'chats'], ['最近对话', 'chats'],
  ['/projects', 'projects'], ['选择项目', 'projects'], ['/last', 'last'], ['最近一轮', 'last'],
]);

export class SelectionUI {
  constructor({ bridge, store, desktop, feishu, now = () => Date.now(), log = () => {} }) {
    Object.assign(this, { bridge, store, desktop, feishu, now, log });
  }
  async initialize() {
    this.store.data.ui ??= { version: 1, commands: {}, cards: {} };
    this.state = this.store.data.ui;
    if (this.state.version !== 1) throw new Error('UNSUPPORTED_UI_STATE');
    for (const command of Object.values(this.state.commands)) {
      if (['PROCESSING', 'SENDING'].includes(command.status)) command.status = 'UNKNOWN';
    }
    // Exactly one introductory menu per route and UI version, including restarts.
    for (const root of this.bridge.config.bindings) {
      await this.queue(`welcome-v1:${root.id}`, root.id, { type: 'menu' }, 'installation');
    }
    await this.store.save();
  }
  async queue(source, rootId, action, origin) {
    const key = hash(`${rootId}:${source}`);
    if (Object.hasOwn(this.state.commands, key)) return { duplicate: true, key };
    if (Object.values(this.state.commands).filter(command => command.rootId === rootId && command.status === 'QUEUED').length >= 20) return { full: true };
    this.state.commands[key] = { key, rootId, action: structuredClone(action), origin, createdAt: this.now(), status: 'QUEUED' };
    await this.store.save();
    return { key };
  }
  async acceptMessage(event) {
    const { sender, message } = event ?? {};
    if (sender?.sender_type !== 'user' || message?.message_type !== 'text') return false;
    const root = this.bridge.authorizedRoot(message.chat_id, sender.sender_id?.open_id);
    if (!root) return false;
    let text;
    try { text = JSON.parse(message.content).text; } catch { return false; }
    const type = typeof text === 'string' && commands.get(text.trim().toLowerCase());
    if (!type) return false;
    const created = Number(message.create_time);
    if (typeof message.message_id !== 'string' || message.message_id.length > 256 || !Number.isFinite(created)
      || created < this.store.data.bindings[root.id].startedAt || created > this.now() + 60000) return true;
    const action = { type, ...(type === 'last' ? { bindingId: this.bridge.currentBinding(root.id).id } : {}) };
    const result = await this.queue(`message:${message.message_id}`, root.id, action, 'message');
    this.log({ type: 'ui-command-queued', action: type, ...result });
    return true;
  }
  async acceptAction(raw) {
    const event = raw?.event ?? raw;
    const chatId = event?.context?.open_chat_id ?? event?.open_chat_id;
    const messageId = event?.context?.open_message_id ?? event?.open_message_id;
    const root = this.bridge.authorizedRoot(chatId, event?.operator?.open_id);
    const value = event?.action?.value;
    this.log({ type: 'ui-callback-received', authorizedRoute: Boolean(root), hasMessageId: Boolean(messageId),
      hasOperator: Boolean(event?.operator?.open_id), valueKeys: value && typeof value === 'object' ? Object.keys(value).slice(0, 8) : [] });
    if (!root || value?.ui !== 'chatgpt_bridge_v1' || typeof value.card !== 'string') return toast('此操作不可用。', 'error');
    const issued = Object.hasOwn(this.state.cards, value.card) && this.state.cards[value.card];
    if (!issued || issued.rootId !== root.id || issued.messageId !== messageId || issued.status !== 'API_ACCEPTED'
      || issued.createdAt + 7 * 86400000 < this.now()) {
      this.log({ type: 'ui-card-rejected', knownCard: Boolean(issued), sameMessage: issued?.messageId === messageId,
        sameRoute: issued?.rootId === root.id, cardStatus: issued?.status });
      return toast('卡片已失效，请发送“菜单”重新打开。', 'error');
    }
    const action = typeof value.action === 'string' && Object.hasOwn(issued.actions, value.action) && issued.actions[value.action];
    if (!action) return toast('未识别的按钮。', 'error');
    const token = event.token ?? raw?.header?.event_id ?? event.event_id;
    if (typeof token !== 'string' || token.length > 2048 || !token) {
      this.log({ type: 'ui-callback-missing-id' });
      return toast('未能确认本次操作，请发送“菜单”重试。', 'error');
    }
    // Persist before acknowledging the event. Slow native reads run in tick().
    const result = await this.queue(`card:${messageId}:${value.action}:${token}`, root.id, action, 'card');
    this.log({ type: 'ui-action-queued', action: action.type, ...result });
    if (result.full) return toast('操作较多，请等待前面的卡片返回。', 'warning');
    return toast(result.duplicate ? '该操作已收到。' : action.type === 'select' ? '正在切换，确认卡片到达后再发消息。' : '正在读取，请稍候。');
  }
  async catalog() {
    const [inventory, projectsResult] = await Promise.all([this.desktop.listThreads(), this.desktop.listProjects()]);
    const chats = [...new Map([...(inventory.pinnedThreads ?? []), ...(inventory.threads ?? [])]
      .filter(thread => thread.kind === 'chatgpt' && typeof thread.id === 'string' && typeof thread.title === 'string')
      .map(thread => [thread.id, thread])).values()];
    const projects = (projectsResult.projects ?? []).filter(project => project.projectKind === 'chatgpt');
    return { chats, projects };
  }
  async build(command, builder) {
    const { action, rootId } = command;
    let binding = this.bridge.currentBinding(rootId);
    if (action.type === 'select') {
      binding = await this.bridge.select(rootId, action.threadId);
      command.selectedThreadId = binding.chatgptThreadId;
      command.selectedTitle = binding.chatgptTitle;
      await this.store.save();
    }
    if (action.type === 'menu' || action.type === 'select') {
      const activeOthers = this.bridge.activeBindings().filter(item => item.rootBindingId === rootId && item.id !== binding.id).length;
      return builder.menu(binding, { selected: action.type === 'select', activeOthers });
    }
    if (action.type === 'chats' || action.type === 'projects') {
      const { chats, projects } = await this.catalog();
      return action.type === 'chats' ? builder.chats(chats, projects, binding, action) : builder.projects(projects, binding);
    }
    if (action.type === 'last') {
      binding = this.bridge.binding(action.bindingId);
      if (binding.rootBindingId !== rootId) throw new Error('CROSS_ROUTE_READ_REJECTED');
      const history = await this.bridge.read(binding);
      return builder.last(history, binding, this.store.data.inbox);
    }
    throw new Error('UNKNOWN_UI_ACTION');
  }
  async tick() {
    const queued = Object.values(this.state.commands).filter(command => command.status === 'QUEUED')
      .sort((a, b) => a.createdAt - b.createdAt).slice(0, 3);
    for (const command of queued) {
      command.status = 'PROCESSING';
      await this.store.save();
      const cardId = randomUUID();
      const builder = new CardBuilder(cardId);
      let card;
      try { card = await this.build(command, builder); }
      catch (error) {
        command.operationError = error.code || 'DESKTOP_OPERATION_FAILED';
        this.log({ type: 'ui-operation-failed', key: command.key, action: command.action.type });
        card = builder.failure();
      }
      const binding = this.bridge.currentBinding(command.rootId);
      const issued = this.state.cards[cardId] = {
        rootId: command.rootId, createdAt: this.now(), actions: builder.actions, status: 'SENDING',
        title: card.header.title.content, commandKey: command.key,
      };
      command.status = 'SENDING';
      command.cardId = cardId;
      await this.store.save();
      try {
        const receipt = await this.feishu.send({ chatId: binding.feishuChatId, card, uuid: hash(`ui:${command.key}`).slice(0, 32) });
        if (!receipt?.messageId) throw new Error('MISSING_CARD_RECEIPT');
        issued.status = 'API_ACCEPTED';
        issued.messageId = command.messageId = receipt.messageId;
        command.status = command.operationError ? 'FAILED' : 'COMPLETED';
        command.completedAt = this.now();
        this.log({ type: 'ui-card-sent', action: command.action.type, key: command.key, messageId: receipt.messageId });
      } catch (error) {
        issued.status = command.status = 'UNKNOWN';
        this.log({ type: 'ui-card-send-unknown', key: command.key, code: error.response?.data?.code || error.code || 'NO_RECEIPT' });
      }
      await this.store.save();
    }
  }
}
