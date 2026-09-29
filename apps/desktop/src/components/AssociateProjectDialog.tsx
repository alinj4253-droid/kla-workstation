import { FolderKanban, Link2, X } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import {
  associationKey,
  normalizeEnterpriseProjects,
  normalizeProjectAssociations,
  type EnterpriseProject,
  type EnterpriseProjectAssociations,
  type ProjectNodeKind,
} from '../enterprise-projects';

export function AssociateProjectDialog({
  kind,
  resourceId,
  resourceName,
  onClose,
  onSaved,
}: {
  kind: ProjectNodeKind;
  resourceId: string;
  resourceName: string;
  onClose: () => void;
  onSaved: (projects: EnterpriseProject[], associations: EnterpriseProjectAssociations) => void;
}): React.JSX.Element {
  const [projects, setProjects] = useState<EnterpriseProject[]>([]);
  const [associations, setAssociations] = useState<EnterpriseProjectAssociations>({});
  const [projectId, setProjectId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async (): Promise<void> => {
      const result = await window.kunqing?.settings.getAll() as { ok?: boolean; data?: Record<string, unknown> } | undefined;
      const available = normalizeEnterpriseProjects(result?.data?.enterpriseProjects);
      const current = normalizeProjectAssociations(result?.data?.enterpriseProjectAssociations);
      setProjects(available);
      setAssociations(current);
      setProjectId(current[associationKey(kind, resourceId)] ?? '');
      setLoading(false);
    })();
  }, [kind, resourceId]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    const key = associationKey(kind, resourceId);
    const next = { ...associations };
    if (projectId) next[key] = projectId;
    else delete next[key];
    const result = await window.kunqing?.settings.update({ enterpriseProjectAssociations: next }) as { ok?: boolean } | undefined;
    setSaving(false);
    if (!result?.ok) { setError('关联保存失败，请稍后重试'); return; }
    if (kind === 'operation' && window.kunqing?.operations?.ensureWorkspace) {
      const workspace = await window.kunqing.operations.ensureWorkspace({ platformId: resourceId, ...(projectId ? { projectId } : {}) }) as { ok?: boolean; error?: { message?: string } } | undefined;
      if (workspace?.ok === false) { setError(workspace.error?.message || '操作智能体项目工作区初始化失败'); return; }
    }
    onSaved(projects, next);
    onClose();
  };

  return <div className="modal-backdrop modal-backdrop--nested" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form className="operation-platform-dialog operation-platform-dialog--compact" role="dialog" aria-modal="true" aria-labelledby="associate-project-title" onSubmit={(event) => void submit(event)}>
      <header><div><h2 id="associate-project-title">关联项目</h2><p>将“{resourceName}”挂载到一个企业项目。</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>
      <label><span>所属项目</span><div className="associate-project-select"><FolderKanban size={16} /><select aria-label="所属项目" disabled={loading} value={projectId} onChange={(event) => { setProjectId(event.target.value); setError(''); }}><option value="">未关联项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div></label>
      {projects.length === 0 && !loading && <small className="operation-platform-dialog__error">请先创建一个企业项目</small>}
      {error && <small className="operation-platform-dialog__error">{error}</small>}
      <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={saving || loading || projects.length === 0}><Link2 size={15} />{saving ? '保存中...' : '确认关联'}</button></footer>
    </form>
  </div>;
}
