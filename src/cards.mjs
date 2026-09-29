import { textOf } from './chatgpt.mjs';

const plain = content => ({ tag: 'plain_text', content });
export const escaped = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_\[\]])/g, '\\$1');
const limited = (value, length) => [...String(value ?? '')].length > length
  ? [...String(value)].slice(0, length).join('') + '\n…（本卡片仅显示节选，完整内容请在原对话查看）' : String(value ?? '');
const md = content => ({ tag: 'markdown', content });
export const row = buttons => ({ tag: 'column_set', flex_mode: 'none', columns: buttons.map(button => ({
  tag: 'column', width: 'weighted', weight: 1, elements: [button],
})) });

export class CardBuilder {
  constructor(id) { this.id = id; this.actions = {}; }
  button(label, action, type = 'default') {
    const id = `a${Object.keys(this.actions).length}`;
    this.actions[id] = action;
    return { tag: 'button', text: plain(label), type,
      behaviors: [{ type: 'callback', value: { ui: 'chatgpt_bridge_v1', card: this.id, action: id } }],
    };
  }
  card(title, elements, template = 'blue') {
    return { schema: '2.0', config: { summary: { content: title } },
      header: { title: plain(title), template }, body: { elements } };
  }
  navigation() {
    return row([this.button('最近对话', { type: 'chats', page: 0 }, 'primary'), this.button('常用操作', { type: 'menu' })]);
  }
  menu(binding, { selected = false, activeOthers = 0 } = {}) {
    return this.card('常用操作 · ChatGPT', [
      md(`${selected ? '✅ 已切换\n\n' : ''}📍 **当前：** ${escaped(binding.chatgptTitle)}`),
      row([this.button('最近对话', { type: 'chats', page: 0 }, 'primary'), this.button('选择项目', { type: 'projects' })]),
      row([this.button('最近一轮', { type: 'last', bindingId: binding.id }), this.button('刷新菜单', { type: 'menu' })]),
      md('直接发送文字，继续当前对话。发送“菜单”可再次打开此界面。' +
        (activeOthers ? `\n\n另有 ${activeOthers} 个先前对话仍在处理消息，回答将标明来源。` : '')),
    ], selected ? 'green' : 'blue');
  }
  chats(chats, projects, binding, { page = 0, projectId } = {}) {
    const filtered = chats.filter(chat => projectId === undefined || (projectId === '__none__' ? !chat.projectId : chat.projectId === projectId));
    const pages = Math.max(1, Math.ceil(filtered.length / 8));
    page = Math.min(pages - 1, Math.max(0, Number(page) || 0));
    const labels = new Map(projects.map(project => [project.projectId, project.label]));
    const title = projectId ? `${projectId === '__none__' ? '未归入项目' : labels.get(projectId) || '所选项目'} · 对话` : '最近对话';
    const elements = [md(`📍 **当前：** ${escaped(binding.chatgptTitle)}\n点击“选择”，后续消息将进入该对话。`)];
    for (const chat of filtered.slice(page * 8, page * 8 + 8)) {
      const current = chat.id === binding.chatgptThreadId;
      elements.push({ tag: 'column_set', flex_mode: 'none', columns: [
        { tag: 'column', width: 'weighted', weight: 1, elements: [md(
          `${current ? '📍 ' : ''}**${escaped(limited(chat.title, 80))}**\n${escaped(labels.get(chat.projectId) || (chat.projectId ? 'ChatGPT 项目' : '未归入项目'))} · ${escaped(chat.id.slice(0, 8))}`)] },
        { tag: 'column', width: 'auto', elements: [this.button(current ? '当前' : '选择', { type: 'select', threadId: chat.id }, current ? 'default' : 'primary')] },
      ] });
    }
    if (!filtered.length) elements.push(md('本次可读取的最近对话中，没有该项目的对话。可先在桌面端打开目标对话，再刷新列表。'));
    elements.push(md(`第 ${page + 1}/${pages} 页 · 本次读取到 ${filtered.length} 个对话\n范围为桌面接口返回的最近 50 条及置顶记录中的 ChatGPT 对话。`));
    const buttons = [];
    if (page > 0) buttons.push(this.button('上一页', { type: 'chats', page: page - 1, projectId }));
    if (page + 1 < pages) buttons.push(this.button('下一页', { type: 'chats', page: page + 1, projectId }, 'primary'));
    if (buttons.length) elements.push(row(buttons));
    elements.push(row([this.button('选择项目', { type: 'projects' }), this.button('刷新列表', { type: 'chats', page, projectId }), this.button('返回菜单', { type: 'menu' })]));
    return this.card(title, elements);
  }
  projects(projects, binding) {
    const elements = [md(`📍 **当前：** ${escaped(binding.chatgptTitle)}\n选择项目后，再选择其中的对话。`),
      row([this.button('全部最近对话', { type: 'chats', page: 0 }, 'primary'), this.button('未归入项目', { type: 'chats', page: 0, projectId: '__none__' })])];
    for (const project of projects) {
      elements.push(row([this.button(project.label, { type: 'chats', page: 0, projectId: project.projectId })]));
    }
    if (!projects.length) elements.push(md('当前没有可读取的 ChatGPT 项目。'));
    elements.push(this.navigation());
    return this.card('选择项目 · ChatGPT', elements);
  }
  last(history, binding, inbox) {
    const turn = history.turns?.[0]; // Desktop read_thread returns newest first.
    const elements = [md(`📍 **对话：** ${escaped(binding.chatgptTitle)}`)];
    if (!turn) elements.push(md('这个对话还没有可显示的轮次。'));
    else {
      const question = turn.items?.find(item => item.type === 'userMessage');
      const answers = turn.items?.filter(item => item.type === 'agentMessage') || [];
      let questionText = question ? textOf(question) : '';
      if (Object.values(inbox).some(entry => entry.bindingId === binding.id && entry.prompt === questionText)) {
        questionText = questionText.replace(/^来自飞书的消息：\n/, '').replace(/\n\n转发标识：[a-f0-9]{16}$/, '');
      }
      if (questionText) elements.push(md('**你**\n' + escaped(limited(questionText, 1800))));
      elements.push(md('**ChatGPT**\n' + (answers.length ? escaped(limited(answers.map(textOf).join('\n\n'), 6500)) : '正在生成或尚无回答。')));
      if (turn.status !== 'completed') elements.push(md('这一轮尚未完成，稍后可重新查看。'));
      if (question?.truncated || answers.some(item => item.truncated)) elements.push(md('桌面接口返回了截断内容，完整内容请在原对话查看。'));
    }
    elements.push(row([this.button('刷新这一轮', { type: 'last', bindingId: binding.id }), this.button('返回菜单', { type: 'menu' })]));
    return this.card('最近一轮 · ChatGPT', elements);
  }
  failure() {
    return this.card('暂时未能完成操作', [md('桌面对话读取或切换未完成，请确认桌面应用仍在运行，然后重新打开菜单。'), this.navigation()], 'orange');
  }
}
