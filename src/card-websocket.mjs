import { WSClient } from '@larksuiteoapi/node-sdk';

// node-sdk 1.74.0 declares MessageType.card but handleEventData only dispatches
// MessageType.event. Keep its event/connection behavior and handle CARD frames
// through the same SDK decoder and dispatcher, preserving the CARD ack headers.
// This adapter intentionally depends on the pinned SDK's runtime methods.
export class CardWebSocket extends WSClient {
  constructor(options, log = () => {}) {
    super(options);
    this.bridgeLog = log;
  }
  async handleEventData(frame) {
    const headers = Object.fromEntries(frame.headers.map(item => [item.key, item.value]));
    if (headers.type !== 'event') this.bridgeLog({ type: 'ws-data-kind', kind: headers.type });
    if (headers.type !== 'card') return super.handleEventData(frame);
    let payload;
    try {
      payload = this.dataCache.mergeData({
        message_id: headers.message_id, sum: Number(headers.sum), seq: Number(headers.seq),
        trace_id: headers.trace_id, data: frame.payload,
      });
    } catch {
      this.bridgeLog({ type: 'card-frame-decode-failed' });
      return;
    }
    if (!payload) return; // Wait for all fragments, as the upstream event path does.
    const started = Date.now();
    const response = { code: 200 };
    try {
      if (!this.eventDispatcher) throw new Error('MISSING_DISPATCHER');
      const result = await this.eventDispatcher.invoke(payload, { needCheck: false });
      if (result) response.data = Buffer.from(JSON.stringify(result)).toString('base64');
      this.bridgeLog({ type: 'card-frame-dispatched' });
    } catch {
      response.code = 500;
      this.bridgeLog({ type: 'card-frame-handler-failed' });
    }
    this.sendMessage({ ...frame,
      headers: [...frame.headers.filter(item => item.key !== 'biz_rt'), { key: 'biz_rt', value: String(Date.now() - started) }],
      payload: new TextEncoder().encode(JSON.stringify(response)),
    });
  }
}
