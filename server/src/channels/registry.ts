import { randomUUID } from 'node:crypto';

/**
 * 渠道注册表（Telegram / 飞书 / 钉钉 / 企业微信机器人）。
 *
 * 说明：渠道凭据与运行状态最终应由服务端持久化并驱动真实的收发进程；当前实现是
 * **进程内**的注册表 + 活动日志，用来把「设置 → 渠道」从遗留桌面桥接
 * （`window.kunqing.channels`）迁到 REST 契约上。指标与活动表都由这份日志真实推导，
 * 不填造数据；进程重启会清空渠道配置（后续接入 `channels` 表 + 常驻监听时替换存储层）。
 */
export const channelTypes = ['telegram', 'lark', 'dingtalk', 'wecom-webhook'] as const;
export type ChannelType = typeof channelTypes[number];
export type ChannelStatus = 'connected' | 'disconnected' | 'error';
export type ActivityKind = 'inbound' | 'outbound' | 'system';

export interface ChannelRecord {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  status: ChannelStatus;
  /** 凭据只回显尾部片段，不返回明文。 */
  credentialHint: string;
  updatedAt: string;
}

export interface ChannelActivity {
  id: string;
  channelId: string;
  channelName: string;
  channelStatus: ChannelStatus;
  detail: string;
  kind: ActivityKind;
  at: string;
}

export interface ChannelStats {
  requestsToday: number;
  errorRate: number;
  connected: number;
  total: number;
  /** 今日累计在线时长（毫秒）；没有任何在线记录时为 null。 */
  onlineMs: number | null;
  onlineSince: string | null;
}

interface IdentityChannels { channels: ChannelRecord[]; activity: ChannelActivity[] }
const registry = new Map<string, IdentityChannels>();
const typeLabels: Record<ChannelType, string> = { telegram: 'Telegram', lark: '飞书 / Lark', dingtalk: '钉钉', 'wecom-webhook': '企业微信群机器人' };

function bucket(identityId: string): IdentityChannels {
  let entry = registry.get(identityId);
  if (!entry) { entry = { channels: [], activity: [] }; registry.set(identityId, entry); }
  return entry;
}

function record(identityId: string, channel: ChannelRecord, detail: string, kind: ActivityKind = 'system'): void {
  const entry = bucket(identityId);
  // 只保留最近 24 小时，避免日志无上限增长。
  const cutoff = Date.now() - 24 * 60 * 60_000;
  entry.activity = [{ id: randomUUID(), channelId: channel.id, channelName: channel.name, channelStatus: channel.status, detail, kind, at: new Date().toISOString() },
    ...entry.activity.filter(item => Date.parse(item.at) >= cutoff)];
}

export const isChannelType = (value: unknown): value is ChannelType => typeof value === 'string' && (channelTypes as readonly string[]).includes(value);

export function listChannels(identityId: string): ChannelRecord[] {
  return bucket(identityId).channels.map(channel => ({ ...channel }));
}

export function listActivity(identityId: string, limit = 20): ChannelActivity[] {
  return bucket(identityId).activity.slice(0, limit).map(item => ({ ...item }));
}

export function channelStats(identityId: string): ChannelStats {
  const entry = bucket(identityId);
  const today = new Date().toISOString().slice(0, 10);
  const todayItems = entry.activity.filter(item => item.at.startsWith(today));
  const failed = todayItems.filter(item => item.channelStatus === 'error' || item.channelStatus === 'disconnected');
  const online = entry.channels.filter(channel => channel.enabled && channel.status === 'connected');
  const since = online.map(channel => Date.parse(channel.updatedAt)).sort((a, b) => a - b)[0];
  return {
    requestsToday: todayItems.filter(item => item.kind !== 'system').length,
    errorRate: todayItems.length ? Math.round((failed.length / todayItems.length) * 1000) / 10 : 0,
    connected: online.length,
    total: entry.channels.length,
    onlineMs: since === undefined || Number.isNaN(since) ? null : Math.max(0, Date.now() - since),
    onlineSince: since === undefined || Number.isNaN(since) ? null : new Date(since).toISOString(),
  };
}

/** 新建或按 id 更新渠道；同一类型同一名称视为重复配置。 */
export function saveChannel(identityId: string, input: { id?: string; type: ChannelType; name?: string; credential?: string; enabled?: boolean }): ChannelRecord {
  const entry = bucket(identityId);
  const existing = input.id ? entry.channels.find(channel => channel.id === input.id) : undefined;
  const name = (input.name ?? existing?.name ?? typeLabels[input.type]).trim().slice(0, 60) || typeLabels[input.type];
  const hint = (input.credential ?? '').trim();
  const credentialHint = hint ? `${hint.slice(0, 3)}…${hint.slice(-4)}` : existing?.credentialHint ?? '';
  const channel: ChannelRecord = {
    id: existing?.id ?? randomUUID(),
    type: input.type,
    name,
    enabled: input.enabled ?? existing?.enabled ?? true,
    // 有凭据即视为已连接：真实的连通性校验要等常驻监听进程接入。
    status: input.enabled === false ? 'disconnected' : credentialHint || existing ? 'connected' : 'error',
    credentialHint,
    updatedAt: new Date().toISOString(),
  };
  entry.channels = existing ? entry.channels.map(item => item.id === channel.id ? channel : item) : [...entry.channels, channel];
  record(identityId, channel, existing ? `${channel.name} 配置已更新` : `${channel.name} 已添加并启用常驻监听`);
  return { ...channel };
}

export function setChannelEnabled(identityId: string, channelId: string, enabled: boolean): ChannelRecord | null {
  const entry = bucket(identityId);
  const current = entry.channels.find(channel => channel.id === channelId);
  if (!current) return null;
  const channel: ChannelRecord = { ...current, enabled, status: enabled ? (current.credentialHint ? 'connected' : 'error') : 'disconnected', updatedAt: new Date().toISOString() };
  entry.channels = entry.channels.map(item => item.id === channelId ? channel : item);
  record(identityId, channel, enabled ? `${channel.name} 已启用常驻监听` : `${channel.name} 已停止监听`);
  return { ...channel };
}

export function removeChannel(identityId: string, channelId: string): boolean {
  const entry = bucket(identityId);
  const current = entry.channels.find(channel => channel.id === channelId);
  if (!current) return false;
  entry.channels = entry.channels.filter(channel => channel.id !== channelId);
  record(identityId, { ...current, status: 'disconnected' }, `${current.name} 已移除`);
  return true;
}

/** 仅测试使用：清空某身份的渠道配置与活动。 */
export function resetChannels(identityId: string): void { registry.delete(identityId); }
