import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { knowledgeTransportSettingsSchema, type KnowledgeConnection } from '@kla-workstation/contracts/knowledge';
import { knowledgeApi } from './api';
export function ConnectionDialog({ connection, fixedBaseUrl, fixedCollection, onClose, onSaved }: { connection?: KnowledgeConnection | undefined; fixedBaseUrl?: string; fixedCollection?: string | undefined; onClose: () => void; onSaved: (connection: KnowledgeConnection) => void }): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState(fixedBaseUrl ?? connection?.baseUrl ?? 'http://192.168.10.206:8120');
  const [collection, setCollection] = useState(fixedCollection ?? connection?.collection ?? ''); const [apiKey, setApiKey] = useState(''); const [clear, setClear] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [settings, setSettings] = useState(connection?.settings ?? knowledgeTransportSettingsSchema.parse({}));
  const [clearConsent, setClearConsent] = useState(false);
  const updateSetting = (key: keyof typeof settings, value: string, multiplier = 1) => setSettings(old => ({ ...old, [key]: Number(value) * multiplier }));
  async function save() {
    setError(''); setBusy(true);
    try { const result = await knowledgeApi.configure({ baseUrl: baseUrl.trim(), collection: collection.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), clearCredential: clear, settings, clearUploadConsent: clearConsent }); setApiKey(''); onSaved(result); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) { setApiKey(''); onClose(); } }}><Dialog.Portal><Dialog.Overlay className="kl-modal-overlay"/><Dialog.Content className="kl-connection-dialog kl-module" onInteractOutside={event => { if (busy) event.preventDefault(); }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
    <header><Dialog.Title>知识服务连接</Dialog.Title><button className="kl-icon-button" aria-label="关闭连接设置" disabled={busy} onClick={onClose}><X size={18}/></button></header><Dialog.Description>配置文件处理服务与明确的向量集合；此设置不会创建公司、项目或个人知识库。</Dialog.Description>
    <form onSubmit={e => { e.preventDefault(); void save(); }}>
      <label>服务地址<input required value={baseUrl} readOnly={Boolean(fixedBaseUrl)} onChange={e => setBaseUrl(e.target.value)} disabled={busy}/>{fixedBaseUrl && <small>公司、项目、个人及新建知识库共用此服务地址。</small>}</label>
      <label>目标 collection<input placeholder="填写服务方提供的集合名称" value={collection} readOnly={Boolean(fixedCollection)} maxLength={200} onChange={e => setCollection(e.target.value)} disabled={busy}/><small>{fixedCollection ? '进入知识库时自动选择；可在“编辑知识库”的高级设置中修改映射。' : '未填写时可以保存连接，但上传与文件关联功能暂不启用。'}</small></label>
      <label>API Key（可选）<input autoComplete="off" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} disabled={busy} placeholder={connection?.hasCredential ? '已安全保存，留空保留' : '仅在服务启用 KB_API_KEY 时填写'}/><small>凭证在 Workstation 服务端加密保存，读取配置不会返回明文。</small></label>
      {connection?.hasCredential && <label className="kl-checkbox"><input type="checkbox" disabled={busy} checked={clear} onChange={e => setClear(e.target.checked)}/>清除现有凭证</label>}
      <details className="kl-connection-advanced"><summary>传输与任务设置</summary><div className="kl-settings-grid">
        <label>请求超时（秒）<input type="number" required min={5} max={600} step={5} value={settings.requestTimeoutMs / 1000} disabled={busy} onChange={e => updateSetting('requestTimeoutMs', e.target.value, 1000)}/></label>
        <label>上传超时（秒）<input type="number" required min={30} max={1800} step={1} value={settings.uploadTimeoutMs / 1000} disabled={busy} onChange={e => updateSetting('uploadTimeoutMs', e.target.value, 1000)}/></label>
        <label>同时上传文件数<select value={settings.uploadConcurrency} disabled={busy} onChange={e => updateSetting('uploadConcurrency', e.target.value)}>{[1, 2, 3].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>断流后轮询间隔（秒）<input type="number" required min={2} max={30} step={1} value={settings.pollIntervalMs / 1000} disabled={busy} onChange={e => updateSetting('pollIntervalMs', e.target.value, 1000)}/></label>
      </div><small>同时上传数控制文件提交，不限制后端处理任务数量。上传超时后仍需核对服务是否创建了任务。</small></details>
      {connection?.hasUploadConsent && <label className="kl-checkbox"><input type="checkbox" disabled={busy} checked={clearConsent} onChange={e => setClearConsent(e.target.checked)}/>撤销已保存的上传同意，下次上传重新确认</label>}
      <p className="kl-muted">更换服务、集合或凭证后，上传前需要重新确认数据发送说明。</p>
      {error && <p role="alert" className="kl-error-text">{error}</p>}<footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="kl-primary" disabled={busy} type="submit">{busy ? '保存中……' : '保存连接'}</button></footer>
    </form>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
