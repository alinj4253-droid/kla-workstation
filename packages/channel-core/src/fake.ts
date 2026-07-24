import type { ChannelAdapter, ChannelTestResult, ResolvedChannelConfig, ChannelEventSink, ExternalTarget, OutboundChannelMessage, DeliveryReceipt, ChannelHealth, ChannelType } from './types';

export class FakeChannelAdapter implements ChannelAdapter {
  readonly type: ChannelType = 'telegram';
  private _started = false;
  private _startTime = 0;
  private _lastError: string | null = null;
  private _sentMessages: Array<{ target: ExternalTarget; message: OutboundChannelMessage }> = [];

  get sentMessages(): Array<{ target: ExternalTarget; message: OutboundChannelMessage }> {
    return this._sentMessages;
  }

  async test(_config: ResolvedChannelConfig, _signal: AbortSignal): Promise<ChannelTestResult> {
    return { success: true, message: 'Fake channel test passed', latencyMs: 5 };
  }

  async start(_config: ResolvedChannelConfig, _sink: ChannelEventSink): Promise<void> {
    this._started = true;
    this._startTime = Date.now();
  }

  async stop(): Promise<void> {
    this._started = false;
  }

  async send(target: ExternalTarget, message: OutboundChannelMessage): Promise<DeliveryReceipt> {
    this._sentMessages.push({ target, message });
    return {
      ok: true,
      externalEventId: `fake-${Date.now()}`,
      error: null,
      sentAt: new Date().toISOString(),
    };
  }

  health(): ChannelHealth {
    return {
      connected: this._started,
      lastPingAt: this._started ? new Date().toISOString() : null,
      lastError: this._lastError,
      uptimeMs: this._started ? Date.now() - this._startTime : 0,
    };
  }

  /** Simulate receiving an inbound event (for testing) */
  simulateInbound(sink: ChannelEventSink, event: {
    externalEventId: string;
    externalConversationId: string;
    externalUserId: string;
    text: string;
  }): void {
    sink.onEvent({
      channelId: 'fake',
      externalEventId: event.externalEventId,
      externalConversationId: event.externalConversationId,
      externalUserId: event.externalUserId,
      text: event.text,
      attachments: [],
      receivedAt: new Date().toISOString(),
    });
  }
}