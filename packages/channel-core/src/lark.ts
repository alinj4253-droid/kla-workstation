import type { ChannelAdapter, ChannelTestResult, ResolvedChannelConfig, ChannelEventSink, ExternalTarget, OutboundChannelMessage, DeliveryReceipt, ChannelHealth, ChannelType, InboundChannelEvent, ExternalConversationInfo } from './types';
import * as Lark from '@larksuiteoapi/node-sdk';

const LARK_API = 'https://open.feishu.cn/open-apis';

/** im.message.receive_v1 事件中附件内容解析 */
type LarkMessageContent = {
  text?: string;
  file_key?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

export class LarkAdapter implements ChannelAdapter {
  readonly type: ChannelType = 'lark';
  private _wsClient: Lark.WSClient | null = null;
  private _sink: ChannelEventSink | null = null;
  private _started = false;
  private _startTime = 0;
  private _lastError: string | null = null;
  private _appId = '';
  private _appSecret = '';
  private _token: string | null = null;
  private _tokenExpiresAt = 0;

  async test(config: ResolvedChannelConfig, signal: AbortSignal): Promise<ChannelTestResult> {
    const appId = (config.config.app_id as string) ?? (config.config.appId as string) ?? '';
    const appSecret = config.secrets.token ?? (config.config.app_secret as string) ?? (config.config.appSecret as string) ?? '';
    if (!appId || !appSecret) {
      return { success: false, message: '缺少 App ID 或 App Secret' };
    }
    const start = Date.now();
    try {
      const resp = await fetch(`${LARK_API}/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal,
      });
      const data = await resp.json() as { code: number; msg: string };
      return {
        success: data.code === 0,
        message: data.code === 0 ? '飞书验证成功' : `验证失败: ${data.msg}`,
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
    this._appId = (config.config.app_id as string) ?? (config.config.appId as string) ?? '';
    this._appSecret = config.secrets.token ?? (config.config.app_secret as string) ?? (config.config.appSecret as string) ?? '';
    this._sink = sink;
    this._started = true;
    this._startTime = Date.now();

    sink.onStatusChange('connecting');

    // 使用飞书官方 SDK 的 WSClient 建立长连接
    // SDK 自动处理：token 获取与刷新、WebSocket 连接、心跳维护、断线重连
    this._wsClient = new Lark.WSClient({
      appId: this._appId,
      appSecret: this._appSecret,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.debug,
    });

    try {
      await this._wsClient.start({
        eventDispatcher: new Lark.EventDispatcher({}).register({
          'im.message.receive_v1': async (data) => {
            this._handleEvent(data);
          },
        }),
      });
      sink.onStatusChange('connected');
      console.log('[LarkAdapter] 飞书长连接已建立（SDK）');
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      sink.onStatusChange('error');
      sink.onError(new Error(this._lastError!));
      throw err;
    }
  }

  async stop(): Promise<void> {
    this._started = false;
    try {
      this._wsClient?.close();
    } catch {
      // 忽略关闭时的异常
    }
    this._wsClient = null;
    this._sink = null;
  }

  async send(target: ExternalTarget, message: OutboundChannelMessage): Promise<DeliveryReceipt> {
    try {
      await this._ensureToken();
      const resp = await fetch(`${LARK_API}/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this._token}`,
        },
        body: JSON.stringify({
          receive_id: target.conversationId,
          msg_type: 'text',
          content: JSON.stringify({ text: message.text }),
        }),
      });
      const data = await resp.json() as { code: number; msg: string; data?: { message_id: string } };
      return {
        ok: data.code === 0,
        externalEventId: data.data?.message_id ?? null,
        error: data.code === 0 ? null : data.msg,
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
    const status = this._wsClient?.getConnectionStatus();
    return {
      connected: status?.state === 'connected',
      lastPingAt: null,
      lastError: this._lastError,
      uptimeMs: this._started ? Date.now() - this._startTime : 0,
    };
  }

  async getConversationInfo(target: ExternalTarget, config?: ResolvedChannelConfig): Promise<ExternalConversationInfo> {
    const appId = config ? (config.config.app_id as string) ?? (config.config.appId as string) ?? this._appId : this._appId;
    const appSecret = config ? config.secrets.token ?? (config.config.app_secret as string) ?? (config.config.appSecret as string) ?? this._appSecret : this._appSecret;
    if (!appId || !appSecret) return { exists: false };
    try {
      const token = await this._fetchToken(appId, appSecret);
      const resp = await fetch(`${LARK_API}/im/v1/chats/${encodeURIComponent(target.conversationId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json() as { code: number; msg?: string; data?: { name?: string; chat_mode?: string } };
      if (data.code === 0) {
        return { exists: true, ...(data.data?.name ? { name: data.data.name } : {}) };
      }
      return { exists: false, ...(data.msg ? { error: data.msg } : {}) };
    } catch (err) {
      return { exists: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── 私有方法 ──────────────────────────────────────────────────────────────

  /** 获取 tenant_access_token（用于发送消息的 REST API） */
  private async _ensureToken(): Promise<void> {
    if (Date.now() < this._tokenExpiresAt - 60000) return;
    const token = await this._fetchToken(this._appId, this._appSecret);
    this._token = token;
    this._tokenExpiresAt = Date.now() + 7200 * 1000;
  }

  private async _fetchToken(appId: string, appSecret: string): Promise<string> {
    const resp = await fetch(`${LARK_API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const data = await resp.json() as { code: number; msg: string; tenant_access_token?: string; expire?: number };
    if (data.code === 0 && data.tenant_access_token) {
      return data.tenant_access_token;
    }
    throw new Error(`获取 token 失败: ${data.msg}`);
  }

  /** 处理飞书消息事件 */
  private _handleEvent(data: {
    event_id?: string;
    sender?: { sender_id?: { open_id?: string } };
    message?: {
      message_id: string;
      chat_id: string;
      message_type: string;
      content: string;
    };
  }): void {
    const message = data?.message;
    if (!message) return;

    // 解析消息文本内容
    let text = '';
    try {
      const content = JSON.parse(message.content) as LarkMessageContent;
      text = content.text ?? '';
    } catch {
      text = message.content ?? '';
    }

    // 提取附件信息
    const attachments: Array<{
      externalId: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      downloadUrl: string;
    }> = [];

    if (message.message_type === 'file' || message.message_type === 'image') {
      try {
        const content = JSON.parse(message.content) as LarkMessageContent;
        if (content.file_key) {
          attachments.push({
            externalId: content.file_key,
            fileName: content.file_name ?? 'unknown',
            mimeType: content.mime_type ?? 'application/octet-stream',
            sizeBytes: content.file_size ?? 0,
            downloadUrl: `${LARK_API}/im/v1/messages/${message.message_id}/resources/file_key=${content.file_key}?type=${message.message_type}`,
          });
        }
      } catch {
        // 忽略附件解析失败
      }
    }

    const inboundEvent: InboundChannelEvent = {
      channelId: '', // 由 ChannelManager 填充
      externalEventId: data.event_id ?? '',
      externalConversationId: message.chat_id,
      externalUserId: data.sender?.sender_id?.open_id ?? '',
      text,
      attachments,
      receivedAt: new Date().toISOString(),
    };

    this._sink?.onEvent(inboundEvent);
  }
}