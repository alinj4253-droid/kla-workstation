import type { ChannelAdapter, ChannelTestResult, ResolvedChannelConfig, ChannelEventSink, ExternalTarget, OutboundChannelMessage, DeliveryReceipt, ChannelHealth, ChannelType } from './types';

export class WeComWebhookAdapter implements ChannelAdapter {
  readonly type: ChannelType = 'wecom-webhook';
  private _webhookUrl = '';
  private _started = false;
  private _startTime = 0;
  private _lastError: string | null = null;

  async test(config: ResolvedChannelConfig, signal: AbortSignal): Promise<ChannelTestResult> {
    const webhookUrl = config.secrets.webhookUrl ?? (config.config.webhookUrl as string) ?? '';
    if (!webhookUrl) {
      return { success: false, message: '缺少 Webhook URL' };
    }
    const start = Date.now();
    try {
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: '鲲擎连接测试' } }),
        signal,
      });
      const data = await resp.json() as { errcode: number; errmsg: string };
      return {
        success: data.errcode === 0,
        message: data.errcode === 0 ? '企业微信 Webhook 验证成功' : `验证失败: ${data.errmsg}`,
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

  async start(_config: ResolvedChannelConfig, _sink: ChannelEventSink): Promise<void> {
    this._webhookUrl = _config.secrets.webhookUrl ?? (_config.config.webhookUrl as string) ?? '';
    this._started = true;
    this._startTime = Date.now();
    // WeCom webhook is outbound-only, no long-running connection needed
  }

  async stop(): Promise<void> {
    this._started = false;
  }

  async send(target: ExternalTarget, message: OutboundChannelMessage): Promise<DeliveryReceipt> {
    try {
      const url = target.conversationId || this._webhookUrl;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { content: message.text },
        }),
      });
      const data = await resp.json() as { errcode: number; errmsg: string };
      return {
        ok: data.errcode === 0,
        externalEventId: data.errcode === 0 ? `wecom-${Date.now()}` : null,
        error: data.errcode === 0 ? null : data.errmsg,
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
      lastPingAt: null,
      lastError: this._lastError,
      uptimeMs: this._started ? Date.now() - this._startTime : 0,
    };
  }
}