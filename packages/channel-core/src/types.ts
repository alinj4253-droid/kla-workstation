export type ChannelType = 'telegram' | 'lark' | 'dingtalk' | 'wecom-webhook';

export type ChannelStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type ChannelTestResult = {
  success: boolean;
  message: string;
  latencyMs?: number;
  httpStatus?: number;
};

export type ChannelHealth = {
  connected: boolean;
  lastPingAt: string | null;
  lastError: string | null;
  uptimeMs: number;
};

export type ResolvedChannelConfig = {
  type: ChannelType;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
};

export type RemoteAttachment = {
  externalId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  downloadUrl: string;
};

export type InboundChannelEvent = {
  channelId: string;
  externalEventId: string;
  externalConversationId: string;
  externalUserId: string;
  text: string;
  attachments: RemoteAttachment[];
  receivedAt: string;
};

export type OutboundChannelMessage = {
  conversationId: string;
  text: string;
  replyToEventId?: string;
  attachments?: Array<{ fileName: string; data: Uint8Array; mimeType: string }>;
};

export type ExternalTarget = {
  conversationId: string;
  userId?: string;
};

export type DeliveryReceipt = {
  ok: boolean;
  externalEventId: string | null;
  error: string | null;
  sentAt: string;
};

export type ChannelEventSink = {
  onEvent(event: InboundChannelEvent): void;
  onError(error: Error): void;
  onStatusChange(status: ChannelStatus): void;
};

export interface ChannelAdapter {
  readonly type: ChannelType;
  test(config: ResolvedChannelConfig, signal: AbortSignal): Promise<ChannelTestResult>;
  start(config: ResolvedChannelConfig, sink: ChannelEventSink): Promise<void>;
  stop(): Promise<void>;
  send(target: ExternalTarget, message: OutboundChannelMessage): Promise<DeliveryReceipt>;
  health(): ChannelHealth;
}