import { klaApi } from './client';

/**
 * 渠道（设置 → 渠道）：统一走 REST（`/api/v1/channels`）。
 * 旧版通过 Electron 桥接 `window.kunqing.channels` 读取，按仓库规范不再新增该用法。
 */
export type ChannelType = 'telegram' | 'lark' | 'dingtalk' | 'wecom-webhook';
export type ChannelStatus = 'connected' | 'disconnected' | 'error';

export interface ChannelRecord {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  status: ChannelStatus;
  credentialHint: string;
  updatedAt: string;
}

export interface ChannelActivity {
  id: string;
  channelId: string;
  channelName: string;
  channelStatus: ChannelStatus;
  detail: string;
  kind: 'inbound' | 'outbound' | 'system';
  at: string;
}

export interface ChannelStats {
  requestsToday: number;
  errorRate: number;
  connected: number;
  total: number;
  onlineMs: number | null;
  onlineSince: string | null;
}

export interface ChannelOverview { channels: ChannelRecord[]; activity: ChannelActivity[]; stats: ChannelStats }

export const channelTypes: ChannelType[] = ['telegram', 'lark', 'dingtalk', 'wecom-webhook'];
export const channelTypeLabels: Record<ChannelType, string> = { telegram: 'Telegram', lark: '飞书 / Lark', dingtalk: '钉钉', 'wecom-webhook': '企业微信群机器人' };
export const channelTypeDetails: Record<ChannelType, string> = { telegram: 'Bot Token · 长轮询', lark: 'WebSocket 长连接 · 无需公网回调地址', dingtalk: '机器人 Webhook · 支持加签', 'wecom-webhook': '群机器人 Webhook · 仅发送' };

export const channelsApi = {
  overview: () => klaApi.request<ChannelOverview>('/v1/channels'),
  save: (input: { id?: string; type: ChannelType; name?: string; credential?: string; enabled?: boolean }) =>
    klaApi.request<ChannelRecord>('/v1/channels', { method: 'POST', body: JSON.stringify(input) }),
  toggle: (channelId: string, enabled: boolean) => klaApi.request<ChannelRecord>(`/v1/channels/${channelId}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  remove: (channelId: string) => klaApi.request<boolean>(`/v1/channels/${channelId}`, { method: 'DELETE' }),
};
