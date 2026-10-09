import { ArrowUpRight, Building2, FolderKanban, UserRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { KnowledgeBase } from '@kla-workstation/contracts/knowledge';
import { LibraryMenu } from './LibraryMenu';
export const scopeLabels = { company: '公司知识库', project: '项目知识库', personal: '个人知识库' };
export function KnowledgeBaseCard({ base, onEdit, onDelete }: { base: KnowledgeBase; onEdit?: (() => void) | undefined; onDelete?: (() => void) | undefined }): React.JSX.Element {
  const Icon = base.scope === 'company' ? Building2 : base.scope === 'project' ? FolderKanban : UserRound;
  const status = base.status === 'ready' ? base.context.attribution !== 'confirmed-library' ? '服务可用' : '正常' : base.status === 'processing' ? '处理中' : base.status === 'pending' ? base.context.collection ? '连接待确认' : '待配置' : '异常';
  return <article className={`kl-base-card kl-scope-${base.scope}`}>
    <div className="kl-card-top"><span className="kl-library-icon"><Icon size={22}/></span><div className="kl-card-heading"><h2>{base.name}</h2><span className="kl-scope">{scopeLabels[base.scope]}</span></div><LibraryMenu name={base.name} detailUrl={`/knowledge/bases/${encodeURIComponent(base.id)}`} onEdit={onEdit} onDelete={onDelete}/></div>
    <p>{base.description || '暂无说明'}</p>
    <div className="kl-card-counts"><span><strong>{base.fileCount ?? '—'}</strong> 文件</span><span><strong>{base.chunkCount ?? '—'}</strong> 切片</span></div>
    <div className="kl-card-collection">{base.context.collection ? `连接集合 · ${base.context.collection}` : '配置集合后连接知识服务'}</div>
    <footer><div><span className={`kl-badge kl-${base.status === 'ready' ? 'done' : base.status === 'processing' ? 'running' : base.status === 'pending' ? 'pending' : 'failed'}`}>{status}</span>{base.updatedAt && <small className="kl-block">更新于 {base.updatedAt.replace('T', ' ').slice(0, 16)}</small>}</div><Link to={`/knowledge/bases/${encodeURIComponent(base.id)}`}>进入知识库 <ArrowUpRight size={15}/></Link></footer>
  </article>;
}
