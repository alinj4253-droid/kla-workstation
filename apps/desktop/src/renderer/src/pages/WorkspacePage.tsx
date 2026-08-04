import {
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
  Upload,
  X,
  Book,
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { GraphViewer } from '../components/GraphViewer';
import { KnowledgeJobDialog } from '../components/KnowledgeJobDialog';
import { WikiViewer } from '../components/WikiViewer';

type FileEntry = {
  name: string;
  relativePath: string;
  kind: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  fileId?: string;
  currentVersionId?: string;
  mimeType?: string;
  sha256?: string;
  knowledgeStatus?: string;
  system?: boolean;
  physicalName?: string;
};

type ProjectInfo = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
};

const formatSize = (size: number): string => {
  if (!size) return '—';
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

const fileIcon = (entry: FileEntry): React.JSX.Element => {
  if (entry.kind === 'directory') return <Folder size={18} />;
  if (/\.(xlsx?|csv)$/i.test(entry.name)) return <FileSpreadsheet size={18} />;
  if (/\.(zip|rar|7z)$/i.test(entry.name)) return <FileArchive size={18} />;
  return <FileText size={18} />;
};

const knowledgeStatusLabel = (status: string): string => {
  switch (status) {
    case 'pending': return '等待';
    case 'ingesting': return '处理中';
    case 'ready': return '已入库';
    case 'error': return '失败';
    default: return status;
  }
};

const SYSTEM_DIR_LABELS: Record<string, string> = {
  'agent-identities': '智能体身份',
  'agent-memories': '智能体记忆',
  'original-files': '原始文件',
  knowledge: '知识',
  'graph-visualization': '图谱可视化',
  outputs: '成果',
};

export function WorkspacePage(): React.JSX.Element {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const [relativePath, setRelativePath] = useState('');
  const [systemDir, setSystemDir] = useState<string | null>(null);
  const [scopeType, setScopeType] = useState<'project' | 'shared'>('project');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderError, setFolderError] = useState('');

  const [actionTarget, setActionTarget] = useState<FileEntry | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [previewData, setPreviewData] = useState<{ kind: 'text' | 'image' | 'html' | 'pdf'; content: string; appFileUrl?: string; fileName: string; mimeType: string; relativePath: string } | null>(null);
  const [graphViewerOpen, setGraphViewerOpen] = useState(false);
  const [projectPanelOpen, setProjectPanelOpen] = useState(true);
  const [wikiViewerOpen, setWikiViewerOpen] = useState(false);
  const [knowledgeDetail, setKnowledgeDetail] = useState<{ fileId: string; fileName: string } | null>(null);

  const activeProject = useMemo(() => projects.find((p) => p.id === projectId), [projectId, projects]);
  const pathParts = relativePath ? relativePath.split('/') : [];
  const scopeLabel = scopeType === 'shared' ? '共享知识' : (systemDir ? SYSTEM_DIR_LABELS[systemDir] ?? systemDir : '群聊根目录');

  const loadProjects = useCallback(async (): Promise<void> => {
    try {
      const result = await window.kunqing?.projects.list({}) as { ok: boolean; data?: ProjectInfo[] } | undefined;
      if (result?.data) setProjects(result.data);
    } catch { /* ignore */ }
  }, []);

  const loadFiles = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    setLoading(true);
    try {
      if (scopeType === 'shared') {
        const result = await window.kunqing?.workspace.listFiles({ projectId, relativePath, scopeType: 'shared' }) as { ok: boolean; data?: FileEntry[] } | undefined;
        setFiles(result?.data ?? []);
      } else if (!systemDir) {
        const result = await window.kunqing?.workspace.listSystemDirs({ projectId }) as { ok: boolean; data?: FileEntry[] } | undefined;
        setFiles(result?.data ?? []);
      } else if (systemDir === 'original-files') {
        const result = await window.kunqing?.workspace.listFiles({ projectId, relativePath }) as { ok: boolean; data?: FileEntry[] } | undefined;
        setFiles(result?.data ?? []);
      } else {
        const dirPath = systemDir + (relativePath ? '/' + relativePath : '');
        const result = await window.kunqing?.workspace.listProjectDir({ projectId, relativePath: dirPath }) as { ok: boolean; data?: FileEntry[] } | undefined;
        setFiles(result?.data ?? []);
      }
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法读取工作区');
    } finally {
      setLoading(false);
    }
  }, [projectId, relativePath, scopeType, systemDir]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);
  useEffect(() => { void loadFiles(); }, [loadFiles]);

  const enterDirectory = (entry: FileEntry): void => {
    if (entry.kind !== 'directory') {
      void handlePreview(entry);
      return;
    }
    if (entry.system && entry.physicalName) {
      setSystemDir(entry.physicalName);
      setRelativePath('');
      return;
    }
    if (systemDir) {
      setRelativePath(entry.relativePath.replaceAll('\\', '/'));
    } else {
      setRelativePath(entry.relativePath.replaceAll('\\', '/'));
    }
  };

  const uploadFiles = async (): Promise<void> => {
    try {
      const result = await window.kunqing?.workspace.uploadFiles({ projectId, relativePath, ...(scopeType === 'shared' ? { scopeType: 'shared' as const } : {}) }) as { cancelled: boolean; importedCount: number } | undefined;
      if (!result) { setNotice('请在 Electron 桌面端体验真实文件上传。'); return; }
      if (!result.cancelled) setNotice(`已导入 ${result.importedCount} 个文件`);
      await loadFiles();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '文件导入失败');
    }
  };

  const createFolder = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const name = folderName.trim();
    if (!name) { setFolderError('请输入文件夹名称'); return; }
    try {
      const result = await window.kunqing?.workspace.createFolder({ projectId, relativePath, name, ...(scopeType === 'shared' ? { scopeType: 'shared' as const } : {}) });
      if (!result) {
        setFiles((current) => [{ name, relativePath: [relativePath, name].filter(Boolean).join('/'), kind: 'directory', size: 0, modifiedAt: new Date().toISOString() }, ...current]);
      } else {
        await loadFiles();
      }
      setFolderDialogOpen(false);
      setFolderName('');
      setFolderError('');
      setNotice(`已创建文件夹“${name}”`);
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : '无法创建文件夹');
    }
  };

  const handleRename = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!renameTarget || !renameValue.trim()) return;
    try {
      const result = await window.kunqing?.workspace.rename({ projectId, relativePath: renameTarget.relativePath, name: renameValue.trim(), ...(scopeType === 'shared' ? { scopeType: 'shared' as const } : {}) }) as { ok: boolean; error?: string } | undefined;
      if (!result?.ok) { setRenameError(result?.error ?? '重命名失败'); return; }
      setRenameTarget(null);
      setRenameValue('');
      setRenameError('');
      await loadFiles();
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : '重命名失败');
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    try {
      await window.kunqing?.workspace.softDelete({ projectId, paths: [deleteTarget.relativePath], ...(scopeType === 'shared' ? { scopeType: 'shared' as const } : {}) });
      setDeleteTarget(null);
      await loadFiles();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除失败');
    }
  };

  const handlePreview = async (entry: FileEntry): Promise<void> => {
    try {
      const result = await window.kunqing?.workspace.getPreview({ projectId, relativePath: entry.relativePath, ...(scopeType === 'shared' ? { scopeType: 'shared' as const } : {}) }) as { ok: boolean; data?: { kind: string; content?: string; dataUri?: string; appFileUrl?: string; mimeType?: string; error?: string } } | undefined;
      if (!result?.ok || !result.data) { setNotice('无法预览此文件'); return; }
      if ('error' in result.data) { setNotice(result.data.error ?? '预览出错'); return; }
      if (result.data.kind === 'image') {
        setPreviewData({ kind: 'image', content: result.data.dataUri ?? '', fileName: entry.name, mimeType: result.data.mimeType ?? '', relativePath: entry.relativePath });
        return;
      }
      if (result.data.kind === 'pdf') {
        setPreviewData({ kind: 'pdf', content: result.data.appFileUrl ?? '', ...(result.data.appFileUrl ? { appFileUrl: result.data.appFileUrl } : {}), fileName: entry.name, mimeType: 'application/pdf', relativePath: entry.relativePath });
        return;
      }
      if (result.data.kind === 'html') {
        setPreviewData({ kind: 'html', content: result.data.content ?? '', ...(result.data.appFileUrl ? { appFileUrl: result.data.appFileUrl } : {}), fileName: entry.name, mimeType: 'text/html', relativePath: entry.relativePath });
        return;
      }
      if (result.data.kind !== 'text') { setNotice('仅支持文本文件预览'); return; }
      setPreviewData({ kind: 'text', content: result.data.content ?? '', fileName: entry.name, mimeType: result.data.mimeType ?? '', relativePath: entry.relativePath });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '预览失败');
    }
  };

  const handleOpenWithSystem = async (entry: FileEntry): Promise<void> => {
    try {
      await window.kunqing?.workspace.openWithSystem({ projectId, relativePath: entry.relativePath, ...(scopeType === 'shared' ? { scopeType: 'shared' as const } : {}) });
    } catch { setNotice('无法使用系统应用打开'); }
  };

  return (
    <div className={`workspace-layout${projectPanelOpen ? '' : ' workspace-layout--panel-closed'}${previewData ? ' workspace-layout--preview-open' : ''}`}>
      {projectPanelOpen && <aside className="project-panel project-panel--open" aria-label="项目协作群组">
        <div className="project-panel__header">
          <button type="button" className="icon-button project-panel-toggle" aria-label="收起项目栏" title="收起项目栏" onClick={() => setProjectPanelOpen(false)}><PanelLeftClose size={18} /></button>
          <h2>项目协作群组</h2>
        </div>
        <div className="project-list">
          {projects.length === 0 ? (
            <div className="file-empty" style={{ padding: '16px', fontSize: '13px' }}>暂无项目</div>
          ) : projects.map((project) => (
            <button type="button" key={project.id} className={`project-list-item${project.id === projectId ? ' project-list-item--active' : ''}`} onClick={() => navigate(`/projects/${project.id}/workspace`)}>
              <strong>{project.name}</strong>
              <span className="project-list-item__status"><i className={`project-status-dot project-status-dot--${project.status.toLowerCase()}`} />{project.status === 'active' ? '进行中' : project.status}</span>
            </button>
          ))}
        </div>
      </aside>}

      <section className="workspace-files">
        <header className="workspace-toolbar">
          <div className="workspace-title">
            {!projectPanelOpen && <button type="button" className="icon-button project-panel-toggle" aria-label="展开项目栏" title="展开项目栏" onClick={() => setProjectPanelOpen(true)}><PanelLeftOpen size={18} /></button>}
            <button type="button" className="icon-button" aria-label="返回群聊" onClick={() => navigate(`/projects/${projectId}/chat`)}><ArrowLeft size={18} /></button>
            <span className="workspace-title-icon"><FolderOpen size={18} /></span>
            <div><h2>{activeProject?.name ?? '工作区'} · 工作区</h2>
              <div className="scope-toggle">
                <button type="button" className={`scope-btn${scopeType === 'project' ? ' scope-btn--active' : ''}`} onClick={() => { setScopeType('project'); setSystemDir(null); setRelativePath(''); }}>当前群聊</button>
                <button type="button" className={`scope-btn${scopeType === 'shared' ? ' scope-btn--active' : ''}`} onClick={() => { setScopeType('shared'); setSystemDir(null); setRelativePath(''); }}>共享知识</button>
              </div>
            </div>
          </div>
          <div className="workspace-actions">
            <button type="button" className="secondary-button" onClick={() => setGraphViewerOpen(true)}><GitBranch size={15} /> 图谱可视化</button>
            <button type="button" className="secondary-button" onClick={() => setWikiViewerOpen(true)}><FileText size={15} /> Wiki</button>
            {(scopeType === 'shared' || systemDir === 'original-files') && (
              <>
                <button type="button" className="secondary-button" onClick={() => void uploadFiles()}><Upload size={15} /> 上传文件</button>
                <button type="button" className="primary-button" onClick={() => setFolderDialogOpen(true)}><Plus size={15} /> 新建文件夹</button>
              </>
            )}
          </div>
        </header>

        <div className="workspace-location-bar">
          <nav aria-label="文件路径">
            <button type="button" onClick={() => { setSystemDir(null); setRelativePath(''); }}>K_Studio</button>
            <ChevronRight size={13} />
            {scopeType === 'shared' ? (
              <span>共享知识</span>
            ) : (
              <>
                <span>群聊文件夹</span>
                <ChevronRight size={13} />
                {systemDir ? (
                  <button type="button" onClick={() => { setSystemDir(null); setRelativePath(''); }}>{activeProject?.name ?? projectId}</button>
                ) : (
                  <span>{activeProject?.name ?? projectId}</span>
                )}
              </>
            )}
            <ChevronRight size={13} />
            {systemDir ? (
              <button type="button" onClick={() => { setSystemDir(systemDir); setRelativePath(''); }}>{scopeLabel}</button>
            ) : (
              <span>{scopeLabel}</span>
            )}
            {pathParts.map((part, index) => (
              <span className="breadcrumb-part" key={`${part}-${index}`}>
                <ChevronRight size={13} />
                <button type="button" onClick={() => setRelativePath(pathParts.slice(0, index + 1).join('/'))}>{part}</button>
              </span>
            ))}
          </nav>
          <button type="button" className="icon-button" aria-label="刷新文件" onClick={() => void loadFiles()}><RefreshCw size={16} /></button>
        </div>

        {notice && <div className="workspace-notice"><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={14} /></button></div>}

        <div className="file-table" role="table" aria-label="用户原始文件">
          <div className="file-table-row file-table-head" role="row"><span>名称</span><span>来源</span><span>大小</span><span>最后修改</span><span>知识</span><span>操作</span></div>
          {loading ? (
            <div className="file-empty">正在读取本地工作区…</div>
          ) : files.length === 0 ? (
            <div className="file-empty"><FolderOpen size={34} /><strong>这个文件夹还是空的</strong><span>{scopeType === 'project' && !systemDir ? '系统目录将在此列出' : '上传文件或新建文件夹，内容将只保存在本机 K_Studio 中。'}</span>{!systemDir && scopeType === 'shared' ? <button className="primary-button" type="button" onClick={() => void uploadFiles()}><Upload size={15} /> 上传第一个文件</button> : null}</div>
          ) : files.map((entry) => (
            <div className="file-table-row" role="row" key={entry.relativePath}>
              <button className={`file-name file-name--${entry.kind}`} type="button" onClick={() => enterDirectory(entry)}>
                {fileIcon(entry)}<span>{entry.name}</span>
              </button>
              <span>{entry.system ? '系统目录' : (systemDir && systemDir !== 'original-files' ? '系统文件' : '用户上传')}</span>
              <span>{formatSize(entry.size)}</span>
              <time>{new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(entry.modifiedAt))}</time>
              <span style={{ position: 'relative' }}>
                <span className={`knowledge-badge knowledge-badge--${entry.knowledgeStatus ?? 'none'}`}>{entry.knowledgeStatus ? knowledgeStatusLabel(entry.knowledgeStatus) : '—'}</span>
                {entry.knowledgeStatus && entry.fileId && (
                  <span className="knowledge-badge-clickable" onClick={() => setKnowledgeDetail({ fileId: entry.fileId ?? '', fileName: entry.name })} />
                )}
              </span>
              <div className="file-actions-wrapper">
                <button type="button" className="icon-button" aria-label={`操作 ${entry.name}`} onClick={(e) => { e.stopPropagation(); setActionTarget(actionTarget?.relativePath === entry.relativePath ? null : entry); }}>
                  <MoreHorizontal size={17} />
                </button>
                {actionTarget?.relativePath === entry.relativePath && !entry.system && (
                  <div className="file-action-menu" onClick={() => setActionTarget(null)}>
                    {entry.kind === 'file' && <button type="button" onClick={() => { void handlePreview(entry); }}><FileText size={14} /> 预览</button>}
                    <button type="button" onClick={() => { setRenameTarget(entry); setRenameValue(entry.name); }}><Pencil size={14} /> 重命名</button>
                    {entry.kind === 'file' && <button type="button" onClick={() => { void handleOpenWithSystem(entry); }}><ExternalLink size={14} /> 系统打开</button>}
                    <button type="button" className="action-danger" onClick={() => setDeleteTarget(entry)}><Trash2 size={14} /> 删除</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {previewData && (
        <aside className="workspace-preview" aria-label={`预览 ${previewData.fileName}`}>
          <header>
            <div><FileText size={18} /><span><strong>{previewData.fileName}</strong><small>{previewData.mimeType}</small></span></div>
            <div><button type="button" className="icon-button" aria-label="使用系统应用打开" title="系统打开" onClick={() => void handleOpenWithSystem({ name: previewData.fileName, relativePath: previewData.relativePath, kind: 'file', size: 0, modifiedAt: '' })}><ExternalLink size={17} /></button><button type="button" className="icon-button" aria-label="关闭预览" onClick={() => setPreviewData(null)}><X size={18} /></button></div>
          </header>
          <div className={`workspace-preview__body${previewData.kind === 'html' || previewData.kind === 'pdf' ? ' workspace-preview__body--document' : ''}`}>
            {previewData.kind === 'image' ? (
              <div className="preview-image-wrapper"><img src={previewData.content} alt={previewData.fileName} className="preview-image" /></div>
            ) : previewData.kind === 'pdf' ? (
              <iframe src={previewData.appFileUrl ?? previewData.content} className="preview-iframe" title="PDF 预览" />
            ) : previewData.kind === 'html' ? (
              <iframe src={previewData.appFileUrl} srcDoc={previewData.appFileUrl ? undefined : previewData.content} className="preview-iframe" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups" referrerPolicy="no-referrer" title="HTML 预览" />
            ) : previewData.fileName.endsWith('.md') ? (
              <div className="wiki-markdown wiki-markdown--preview"><ReactMarkdown>{previewData.content}</ReactMarkdown></div>
            ) : (
              <pre className="preview-content">{previewData.content}</pre>
            )}
          </div>
        </aside>
      )}

      {folderDialogOpen && (
        <div className="modal-backdrop modal-backdrop--nested" role="presentation" onClick={() => setFolderDialogOpen(false)}>
          <form className="folder-dialog" onClick={(e) => e.stopPropagation()} onSubmit={(event) => void createFolder(event)}>
            <header><div><h3>新建文件夹</h3><p>文件夹将创建在当前用户原始文件路径内</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setFolderDialogOpen(false)}><X size={18} /></button></header>
            <label><span>文件夹名称</span><input autoFocus className={folderError ? 'input-invalid' : ''} value={folderName} onChange={(event) => { setFolderName(event.target.value); setFolderError(''); }} placeholder="例如：合同与附件" />{folderError && <small>{folderError}</small>}</label>
            <footer><button type="button" className="secondary-button" onClick={() => setFolderDialogOpen(false)}>取消</button><button type="submit" className="primary-button">创建</button></footer>
          </form>
        </div>
      )}

      {renameTarget && (
        <div className="modal-backdrop modal-backdrop--nested" role="presentation" onClick={() => setRenameTarget(null)}>
          <form className="folder-dialog" onClick={(e) => e.stopPropagation()} onSubmit={(event) => void handleRename(event)}>
            <header><div><h3>重命名</h3><p>{renameTarget.kind === 'directory' ? '文件夹' : '文件'}名称</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setRenameTarget(null)}><X size={18} /></button></header>
            <label><span>新名称</span><input autoFocus className={renameError ? 'input-invalid' : ''} value={renameValue} onChange={(event) => { setRenameValue(event.target.value); setRenameError(''); }} />{renameError && <small>{renameError}</small>}</label>
            <footer><button type="button" className="secondary-button" onClick={() => setRenameTarget(null)}>取消</button><button type="submit" className="primary-button">确认</button></footer>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-backdrop modal-backdrop--nested" role="presentation" onClick={() => setDeleteTarget(null)}>
          <div className="folder-dialog" onClick={(e) => e.stopPropagation()}>
            <header><div><h3>确认删除</h3><p>将“{deleteTarget.name}”移入回收站？{deleteTarget.kind === 'directory' ? '目录内所有文件将一并删除。' : ''}</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setDeleteTarget(null)}><X size={18} /></button></header>
            <footer><button type="button" className="secondary-button" onClick={() => setDeleteTarget(null)}>取消</button><button type="button" className="primary-button danger" onClick={() => void handleDelete()}>删除</button></footer>
          </div>
        </div>
      )}

      {graphViewerOpen && (
        <GraphViewer scopeType={scopeType} scopeId={scopeType === 'shared' ? 'shared-knowledge' : projectId} projectId={projectId} onClose={() => setGraphViewerOpen(false)} />
      )}

      {wikiViewerOpen && (
        <WikiViewer scopeType={scopeType} scopeId={projectId} projectId={projectId} onClose={() => setWikiViewerOpen(false)} />
      )}

      {knowledgeDetail && (
        <KnowledgeJobDialog fileId={knowledgeDetail.fileId} fileName={knowledgeDetail.fileName} onClose={() => setKnowledgeDetail(null)} />
      )}
    </div>
  );
}
