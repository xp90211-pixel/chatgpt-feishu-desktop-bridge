import * as lark from '@larksuiteoapi/node-sdk';
import { CardWebSocket } from './card-websocket.mjs';

export class Feishu {
  constructor({ appId, appSecret, log = () => {} }) {
    if (!appId || !appSecret) throw new Error('Set FEISHU_APP_ID and FEISHU_APP_SECRET for the dedicated bot.');
    // SDK transport errors can contain request headers. Keep raw SDK diagnostics
    // out of the console and record only bridge state/error codes.
    const logger = {
      debug() {}, trace() {}, info() {},
      warn() { log({ type: 'feishu-sdk-warning' }); },
      error() { log({ type: 'feishu-sdk-error' }); },
    };
    const options = { appId, appSecret, domain: lark.Domain.Feishu, logger };
    this.logger = logger;
    this.client = new lark.Client(options);
    this.ws = new CardWebSocket(options, log);
  }

  async send({ chatId, replyTo, text, card, uuid }) {
    const data = { msg_type: card ? 'interactive' : 'text', content: JSON.stringify(card ?? { text }), uuid };
    const result = replyTo
      ? await this.client.im.message.reply({ path: { message_id: replyTo }, data })
      : await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { ...data, receive_id: chatId } });
    if (result.code !== 0 || !result.data?.message_id) throw new Error(`FEISHU_API_ERROR:${result.code ?? 'no_receipt'}`);
    if (result.data.chat_id && result.data.chat_id !== chatId) throw new Error('FEISHU_RECEIPT_CHAT_MISMATCH');
    return { messageId: result.data.message_id };
  }

  async start(handler, cardHandler) {
    await this.ws.start({
      eventDispatcher: new lark.EventDispatcher({ logger: this.logger }).register({
        'im.message.receive_v1': handler,
        ...(cardHandler ? { 'card.action.trigger': cardHandler } : {}),
      }),
    });
  }

  status() { return this.ws.getConnectionStatus(); }
  close() { this.ws.close({ force: true }); }
}
