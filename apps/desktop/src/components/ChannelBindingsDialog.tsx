import { AlertTriangle, CheckCircle2, Link, Loader2, RefreshCw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

type ChannelRow = {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  status: string;
};

type BindingRow = {
  channelId: string;
  channelName: string;
  channelType: string;
  externalConversationId: string;
  projectId: string;
  projectName: string;
  createdAt: string;
};

const BINDABLE_TYPES = ['lark', 'telegram', 'dingtalk'];
const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  lark: '飞书 / Lark',
  dingtalk: '钉钉',
  'wecom-webhook': '企业微信群机器人',
};

export function ChannelBindingsDialog({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName?: string;
  onClose: () => void;
}): React.JSX.Element {
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [bindings, setBindings] = useState<BindingRow[]>([]);
  const [channelId, setChannelId] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [preview, setPreview] = useState<{ name?: string; exists: boolean; verified: boolean; error?: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [channelsRes, bindingsRes] = await Promise.all([
      (window.kunqing?.channels.list() as Promise<{ ok: boolean; data?: ChannelRow[] }> | undefined) ?? Promise.resolve({ ok: true, data: [] }),
      (window.kunqing?.channels.listBindings({}) as Promise<{ ok: boolean; data?: BindingRow[] }> | undefined) ?? Promise.resolve({ ok: true, data: [] }),
    ]);
    const rows = (channelsRes?.data ?? []).filter((c) => BINDABLE_TYPES.includes(c.type));
    setChannels(rows);
    if (!channelId && rows.length > 0 && rows[0]) setChannelId(rows[0].id);
    setBindings((bindingsRes?.data ?? []).filter((b) => b.projectId === projectId));
  }, [projectId, channelId]);

  useEffect(() => { void load(); }, [load]);

  const selectedChannel = channels.find((c) => c.id === channelId);

  const handlePreview = async (): Promise<void> => {
    if (!channelId || !conversationId.trim()) return;
    setPreviewing(true);
    setError(null);
    setPreview(null);
    try {
      const res = await (window.kunqing?.channels.previewConversation({
        channelId,
        externalConversationId: conversationId.trim(),
      }) as Promise<{ ok: boolean; data?: { name?: string; exists: boolean; verified: boolean; error?: string } }> | undefined);
      if (res?.ok && res.data) setPreview(res.data);
      else setError((res as { error?: { message?: string } } | undefined)?.error?.message ?? '校验失败');
    } catch {
      setError('校验失败');
    }
    setPreviewing(false);
  };

  const handleBind = async (): Promise<void> => {
    if (!channelId || !conversationId.trim()) return;
    setBinding(true);
    setError(null);
    try {
      let res = await (window.kunqing?.channels.bind({
        channelId,
        externalConversationId: conversationId.trim(),
        projectId,
      }) as Promise<{ ok: boolean; error?: { code?: string; message?: string } }> | undefined);
      if (!res?.ok && res?.error?.code === 'ALREADY_BOUND') {
        const confirmed = window.confirm('该会话已绑定到其他项目，确认改为绑定到当前项目？');
        if (!confirmed) { setBinding(false); return; }
        res = await (window.kunqing?.channels.bind({
          channelId,
          externalConversationId: conversationId.trim(),
          projectId,
          force: true,
        }) as Promise<{ ok: boolean; error?: { code?: string; message?: string } }> | undefined);
      }
      if (!res?.ok) {
        setError(res?.error?.message ?? '绑定失败');
        return;
      }
      setConversationId('');
      setPreview(null);
      await load();
    } catch {
      setError('绑定失败');
    }
    setBinding(false);
  };

  const handleUnbind = async (channelId: string, conversationId: string): Promise<void> => {
    if (!window.confirm('确定解绑该渠道会话吗？解绑后该群消息将不再路由到本项目。')) return;
    await window.kunqing?.channels.unbind({ channelId, externalConversationId: conversationId });
    await load();
  };

  const guidance = selectedChannel?.type === 'dingtalk'
    ? '在钉钉群里 @机器人 发送 /id，复制回复中的会话 ID。'
    : selectedChannel?.type === 'telegram'
      ? '在 Telegram 里向机器人发送 /id，复制回复中的会话 ID。'
      : '在飞书群右上角 ⋯ → 群设置 中复制「群 ID」；也可在群内 @机器人 发送 /id 获取。';

  return (
    <div className="modal-backdrop modal-backdrop--nested" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="project-action-dialog channel-bind-dialog" role="dialog" aria-modal="true" aria-labelledby="channel-bind-title">
        <header>
          <div>
            <h3 id="channel-bind-title">绑定渠道会话</h3>
            <p>将 IM 群聊绑定到项目「{projectName ?? projectId}」，群内 @机器人 即可使用项目上下文。</p>
          </div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="channel-bind-form">
          <label>
            <span>渠道</span>
            <select value={channelId} onChange={(event) => { setChannelId(event.target.value); setPreview(null); setError(null); }}>
              {channels.length === 0 && <option value="">暂无可用渠道，请先到「设置 → 渠道」配置</option>}
              {channels.map((c) => (
                <option key={c.id} value={c.id}>{CHANNEL_LABELS[c.type] ?? c.name}（{c.enabled ? '已启用' : '未启用'}）</option>
              ))}
            </select>
          </label>
          <label>
            <span>会话 ID</span>
            <input
              autoFocus
              value={conversationId}
              placeholder="oc_xxxxxxxx 或 cidxxxxxxxx"
              onChange={(event) => { setConversationId(event.target.value); setPreview(null); setError(null); }}
            />
            <small>{guidance}</small>
          </label>

          {preview && (
            <div className={`channel-bind-preview${preview.exists ? ' channel-bind-preview--ok' : ' channel-bind-preview--bad'}`}>
              {preview.exists ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
              <span>
                {preview.exists
                  ? preview.verified
                    ? `校验通过${preview.name ? `：${preview.name}` : ''}`
                    : '该渠道暂不支持在线校验，请确认会话 ID 无误。'
                  : (preview.error ?? '未找到该会话，请确认机器人已加入目标群且 ID 正确。')}
              </span>
            </div>
          )}
          {error && <div className="channel-bind-preview channel-bind-preview--bad"><AlertTriangle size={15} /><span>{error}</span></div>}

          <footer>
            <button type="button" className="secondary-button" onClick={() => void handlePreview()} disabled={!channelId || !conversationId.trim() || previewing}>
              {previewing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 校验
            </button>
            <button type="button" className="primary-button" disabled={!channelId || !conversationId.trim() || binding} onClick={() => void handleBind()}>
              {binding ? <Loader2 size={14} className="spin" /> : <Link size={14} />} 确认绑定
            </button>
          </footer>
        </div>

        {bindings.length > 0 && (
          <div className="channel-bind-list">
            <strong>当前项目已绑定</strong>
            <ul>
              {bindings.map((b) => (
                <li key={`${b.channelId}:${b.externalConversationId}`}>
                  <span className="channel-bind-list__icon">{CHANNEL_LABELS[b.channelType] ?? b.channelType}</span>
                  <span className="channel-bind-list__id"><code>{b.externalConversationId}</code><small>{b.channelName}</small></span>
                  <button type="button" className="icon-button" aria-label="解绑" title="解绑" onClick={() => void handleUnbind(b.channelId, b.externalConversationId)}><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
