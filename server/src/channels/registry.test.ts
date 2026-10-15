import { beforeEach, describe, expect, it } from 'vitest';
import { channelStats, listActivity, listChannels, removeChannel, resetChannels, saveChannel, setChannelEnabled } from './registry.js';

const me = 'identity-channels';

describe('渠道注册表', () => {
  beforeEach(() => resetChannels(me));

  it('新增渠道后可读回，凭据只保留片段不回显明文', () => {
    const created = saveChannel(me, { type: 'lark', name: '产品组飞书', credential: 'cli_a1b2c3d4e5f6' });
    expect(created).toMatchObject({ type: 'lark', name: '产品组飞书', enabled: true, status: 'connected' });
    expect(created.credentialHint).toBe('cli…e5f6');
    expect(JSON.stringify(created)).not.toContain('cli_a1b2c3d4e5f6');
    expect(listChannels(me)).toHaveLength(1);
  });

  it('启停会更新状态并写入活动，指标随之变化', () => {
    const created = saveChannel(me, { type: 'telegram', name: 'Telegram', credential: '123456:abc' });
    expect(channelStats(me)).toMatchObject({ connected: 1, total: 1 });
    const stopped = setChannelEnabled(me, created.id, false);
    expect(stopped).toMatchObject({ enabled: false, status: 'disconnected' });
    expect(channelStats(me).connected).toBe(0);
    // 每次变更都进活动日志（系统类），并按时间倒序。
    const activity = listActivity(me);
    expect(activity.length).toBeGreaterThanOrEqual(2);
    expect(Date.parse(activity[0]!.at)).toBeGreaterThanOrEqual(Date.parse(activity[activity.length - 1]!.at));
    expect(activity.every(item => item.channelName === 'Telegram')).toBe(true);
  });

  it('无凭据即视为配置异常，移除后不再出现在列表', () => {
    const created = saveChannel(me, { type: 'dingtalk', name: '钉钉' });
    expect(created.status).toBe('error');
    expect(channelStats(me).errorRate).toBeGreaterThan(0);
    expect(removeChannel(me, created.id)).toBe(true);
    expect(listChannels(me)).toHaveLength(0);
    expect(removeChannel(me, created.id)).toBe(false);
  });

  it('按 id 更新既有渠道而不是新建一条', () => {
    const created = saveChannel(me, { type: 'wecom-webhook', name: '全员群', credential: 'https://qyapi.example/hook?a=1' });
    const updated = saveChannel(me, { id: created.id, type: 'wecom-webhook', name: '全员群（生产）' });
    expect(listChannels(me)).toHaveLength(1);
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('全员群（生产）');
    expect(updated.credentialHint).toBe(created.credentialHint);
  });

  it('身份之间互相隔离', () => {
    saveChannel(me, { type: 'telegram', name: 'A 的渠道' });
    expect(listChannels('identity-other')).toHaveLength(0);
  });
});
