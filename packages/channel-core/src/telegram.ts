import type { ChannelAdapter, ChannelTestResult, ResolvedChannelConfig, ChannelEventSink, ExternalTarget, OutboundChannelMessage, DeliveryReceipt, ChannelHealth, ChannelType, InboundChannelEvent, RemoteAttachment, ExternalConversationInfo } from './types';

const TELEGRAM_API = 'https://api.telegram.org';

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from: { id: number; first_name?: string; last_name?: string; username?: string };
    text?: string;
    date: number;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    photo?: Array<{ file_id: string; file_size: number }>;
  };
};

export class TelegramAdapter implements ChannelAdapter {
  readonly type: ChannelType = 'telegram';
  private _token = '';
  private _pollingInterval: ReturnType<typeof setInterval> | null = null;
  private _lastUpdateId = 0;
  private _sink: ChannelEventSink | null = null;
  private _started = false;
  private _startTime = 0;
  private _lastError: string | null = null;
  private _abortController: AbortController | null = null;

  async test(config: ResolvedChannelConfig, signal: AbortSignal): Promise<ChannelTestResult> {
    const token = config.secrets.token ?? (config.config.token as string) ?? '';
    if (!token) {
      return { success: false, message: '缺少 Bot Token' };
    }
    const start = Date.now();
    try {
      const resp = await fetch(`${TELEGRAM_API}/bot${token}/getMe`, { signal });
      const data = await resp.json() as { ok: boolean };
      return {
        success: data.ok,
        message: data.ok ? 'Telegram Bot 验证成功' : 'Token 无效',
        latencyMs: Date.now() - start,
        httpStatus: resp.status,
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : '连接失败',
        latencyMs: Date.now() - start,
      };
    }
  }

  async start(config: ResolvedChannelConfig, sink: ChannelEventSink): Promise<void> {
    this._token = config.secrets.token ?? (config.config.token as string) ?? '';
    if (!this._token) throw new Error('缺少 Bot Token');
    this._sink = sink;
    this._started = true;
    this._startTime = Date.now();
    this._abortController = new AbortController();

    // Start long polling
    this._pollingInterval = setInterval(() => {
      void this._poll();
    }, 1000);
  }

  async stop(): Promise<void> {
    this._started = false;
    if (this._pollingInterval) {
      clearInterval(this._pollingInterval);
      this._pollingInterval = null;
    }
    this._abortController?.abort();
    this._abortController = null;
    this._sink = null;
  }

  async send(target: ExternalTarget, message: OutboundChannelMessage): Promise<DeliveryReceipt> {
    try {
      const chatId = target.conversationId;
      const resp = await fetch(`${TELEGRAM_API}/bot${this._token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: Number(chatId), text: message.text, parse_mode: 'Markdown' }),
      });
      const data = await resp.json() as { ok: boolean; result?: { message_id: number } };
      return {
        ok: data.ok,
        externalEventId: data.ok ? String(data.result?.message_id) : null,
        error: data.ok ? null : '发送失败',
        sentAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        ok: false,
        externalEventId: null,
        error: err instanceof Error ? err.message : '发送失败',
        sentAt: new Date().toISOString(),
      };
    }
  }

  health(): ChannelHealth {
    return {
      connected: this._started,
      lastPingAt: this._started ? new Date().toISOString() : null,
      lastError: this._lastError,
      uptimeMs: this._started ? Date.now() - this._startTime : 0,
    };
  }

  async getConversationInfo(target: ExternalTarget, config?: ResolvedChannelConfig): Promise<ExternalConversationInfo> {
    const token = config ? config.secrets.token ?? (config.config.token as string) ?? this._token : this._token;
    if (!token) return { exists: false };
    try {
      const resp = await fetch(`${TELEGRAM_API}/bot${token}/getChat?chat_id=${encodeURIComponent(target.conversationId)}`);
      const data = await resp.json() as { ok: boolean; description?: string; result?: { title?: string; type?: string } };
      if (data.ok && data.result) {
        return { exists: true, ...(data.result.title ? { name: data.result.title } : {}) };
      }
      return { exists: false, ...(data.description ? { error: data.description } : {}) };
    } catch (err) {
      return { exists: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async _poll(): Promise<void> {
    if (!this._started || !this._sink) return;
    try {
      const resp = await fetch(
        `${TELEGRAM_API}/bot${this._token}/getUpdates?offset=${this._lastUpdateId + 1}&timeout=30`,
        { signal: this._abortController?.signal ?? null },
      );
      const data = await resp.json() as { ok: boolean; result?: TelegramUpdate[] };
      if (!data.ok || !data.result) return;

      for (const update of data.result) {
        if (update.update_id > this._lastUpdateId) {
          this._lastUpdateId = update.update_id;
        }
        if (update.message?.text) {
          const event = this._toInboundEvent(update);
          if (event) this._sink.onEvent(event);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      this._lastError = err instanceof Error ? err.message : String(err);
      this._sink?.onError(new Error(this._lastError!));
    }
  }

  private _toInboundEvent(update: TelegramUpdate): InboundChannelEvent | null {
    const msg = update.message;
    if (!msg) return null;
    const attachments: RemoteAttachment[] = [];
    if (msg.document) {
      attachments.push({
        externalId: msg.document.file_id,
        fileName: msg.document.file_name ?? 'file',
        mimeType: msg.document.mime_type ?? 'application/octet-stream',
        sizeBytes: msg.document.file_size ?? 0,
        downloadUrl: `https://api.telegram.org/file/bot${this._token}/${msg.document.file_id}`,
      });
    }
    if (msg.photo?.length) {
      const largest = msg.photo.reduce((a, b) => a.file_size > b.file_size ? a : b);
      attachments.push({
        externalId: largest.file_id,
        fileName: `photo_${largest.file_id}.jpg`,
        mimeType: 'image/jpeg',
        sizeBytes: largest.file_size,
        downloadUrl: `https://api.telegram.org/file/bot${this._token}/${largest.file_id}`,
      });
    }
    return {
      channelId: '',
      externalEventId: String(update.update_id),
      externalConversationId: String(msg.chat.id),
      externalUserId: String(msg.from.id),
      text: msg.text ?? '',
      attachments,
      receivedAt: new Date(msg.date * 1000).toISOString(),
    };
  }
}