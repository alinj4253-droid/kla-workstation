import {
  ArrowLeft,
  ChevronRight,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Upload,
  X,
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

type FileEntry = {
  name: string;
  relativePath: string;
  kind: 'file' | 'directory';
  size: number;
  modifiedAt: string;
};

const projects = [
  { id: 'annual-finance', status: 'ACTIVE', name: '年度财务报销审核', preview: 'Financial Agent: 正在校验发票真实性...', time: '14:20' },
  { id: 'supplier-bid', status: 'ARCHIVED', name: 'Q3 供应商招投标', preview: 'Bidding Agent: 招标文件已生成，请查阅', time: 'Yesterday' },
  { id: 'charter-review', status: 'REVIEWING', name: '项目章程审批流程', preview: 'Approval Agent: 主管已确认签字', time: 'Mon' },
] as const;

const demoEntries: FileEntry[] = [
  { name: '差旅凭证备份', relativePath: '差旅凭证备份', kind: 'directory', size: 0, modifiedAt: '2026-07-18T02:12:00.000Z' },
  { name: '年度财务报销审核_2024.pdf', relativePath: '年度财务报销审核_2024.pdf', kind: 'file', size: 2_516_582, modifiedAt: '2026-07-18T06:20:00.000Z' },
  { name: '合规性审查指南 V2.0.docx', relativePath: '合规性审查指南 V2.0.docx', kind: 'file', size: 524_288, modifiedAt: '2026-07-18T02:15:00.000Z' },
  { name: 'Q3 供应商评分汇总.xlsx', relativePath: 'Q3 供应商评分汇总.xlsx', kind: 'file', size: 1_153_434, modifiedAt: '2026-07-17T08:45:00.000Z' },
];

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

export function WorkspacePage(): React.JSX.Element {
  const { projectId = 'annual-finance' } = useParams();
  const navigate = useNavigate();
  const [relativePath, setRelativePath] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderError, setFolderError] = useState('');

  const activeProject = useMemo(() => projects.find((item) => item.id === projectId) ?? projects[0], [projectId]);
  const pathParts = relativePath ? relativePath.split('/') : [];

  const loadFiles = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await window.kunqing?.workspace.listFiles({ projectId, relativePath });
      setFiles(result ?? demoEntries);
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法读取工作区');
    } finally {
      setLoading(false);
    }
  }, [projectId, relativePath]);

  useEffect(() => { void loadFiles(); }, [loadFiles]);

  const enterDirectory = (entry: FileEntry): void => {
    if (entry.kind !== 'directory') {
      void window.kunqing?.workspace.openItem({ projectId, relativePath: entry.relativePath });
      return;
    }
    setRelativePath(entry.relativePath.replaceAll('\\', '/'));
  };

  const uploadFiles = async (): Promise<void> => {
    try {
      const result = await window.kunqing?.workspace.uploadFiles({ projectId, relativePath });
      if (!result) { setNotice('网页预览使用 Mock 数据；请在 Electron 桌面端体验真实文件上传。'); return; }
      if (!result.cancelled) setNotice(`已导入 ${result.importedCount} 个文件到用户原始文件目录`);
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
      const result = await window.kunqing?.workspace.createFolder({ projectId, relativePath, name });
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

  return (
    <div className="workspace-layout">
      <aside className="project-panel" aria-label="协作项目">
        <div className="project-panel__header"><h2>协作项目</h2><button type="button" className="icon-button" aria-label="筛选项目"><SlidersHorizontal size={17} /></button></div>
        <div className="project-list">
          {projects.map((project) => (
            <button type="button" key={project.id} className={`project-list-item${project.id === projectId ? ' project-list-item--active' : ''}`} onClick={() => navigate(`/projects/${project.id}/workspace`)}>
              <div className="project-list-item__meta"><span className={`status-pill status-pill--${project.status.toLowerCase()}`}>{project.status}</span><time>{project.time}</time></div>
              <strong>{project.name}</strong><p>{project.preview}</p>
            </button>
          ))}
        </div>
      </aside>

      <section className="workspace-files">
        <header className="workspace-toolbar">
          <div className="workspace-title"><button type="button" className="icon-button" aria-label="返回群聊" onClick={() => navigate(`/projects/${projectId}/chat`)}><ArrowLeft size={18} /></button><span className="workspace-title-icon"><FolderOpen size={18} /></span><div><h2>{activeProject?.name ?? '群聊'} · 工作区</h2><p>用户原始文件</p></div></div>
          <div className="workspace-actions"><button type="button" className="secondary-button" onClick={() => void uploadFiles()}><Upload size={15} /> 上传文件</button><button type="button" className="primary-button" onClick={() => setFolderDialogOpen(true)}><Plus size={15} /> 新建文件夹</button></div>
        </header>

        <div className="workspace-location-bar">
          <nav aria-label="文件路径"><button type="button" onClick={() => setRelativePath('')}>K_Studio</button><ChevronRight size={13} /><span>群聊文件夹</span><ChevronRight size={13} /><span>{projectId}-workspace</span><ChevronRight size={13} /><button type="button" onClick={() => setRelativePath('')}>用户原始文件</button>{pathParts.map((part, index) => <span className="breadcrumb-part" key={`${part}-${index}`}><ChevronRight size={13} /><button type="button" onClick={() => setRelativePath(pathParts.slice(0, index + 1).join('/'))}>{part}</button></span>)}</nav>
          <button type="button" className="icon-button" aria-label="刷新文件" onClick={() => void loadFiles()}><RefreshCw size={16} /></button>
        </div>

        {notice && <div className="workspace-notice"><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={14} /></button></div>}

        <div className="file-table" role="table" aria-label="用户原始文件">
          <div className="file-table-row file-table-head" role="row"><span>名称</span><span>来源</span><span>大小</span><span>最后修改</span><span>操作</span></div>
          {loading ? <div className="file-empty">正在读取本地工作区…</div> : files.length === 0 ? <div className="file-empty"><FolderOpen size={34} /><strong>这个文件夹还是空的</strong><span>上传文件或新建文件夹，内容将只保存在本机 K_Studio 中。</span><button className="primary-button" type="button" onClick={() => void uploadFiles()}><Upload size={15} /> 上传第一个文件</button></div> : files.map((entry) => (
            <div className="file-table-row" role="row" key={entry.relativePath} onDoubleClick={() => enterDirectory(entry)}>
              <button className={`file-name file-name--${entry.kind}`} type="button" onClick={() => enterDirectory(entry)}>{fileIcon(entry)}<span>{entry.name}</span></button>
              <span>用户上传</span><span>{formatSize(entry.size)}</span><time>{new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(entry.modifiedAt))}</time>
              <button type="button" className="icon-button" aria-label={`操作 ${entry.name}`}><MoreHorizontal size={17} /></button>
            </div>
          ))}
        </div>
      </section>

      {folderDialogOpen && <div className="modal-backdrop modal-backdrop--nested" role="presentation"><form className="folder-dialog" onSubmit={(event) => void createFolder(event)}><header><div><h3>新建文件夹</h3><p>文件夹将创建在当前用户原始文件路径内</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setFolderDialogOpen(false)}><X size={18} /></button></header><label><span>文件夹名称</span><input autoFocus className={folderError ? 'input-invalid' : ''} value={folderName} onChange={(event) => { setFolderName(event.target.value); setFolderError(''); }} placeholder="例如：合同与附件" />{folderError && <small>{folderError}</small>}</label><footer><button type="button" className="secondary-button" onClick={() => setFolderDialogOpen(false)}>取消</button><button type="submit" className="primary-button">创建</button></footer></form></div>}
    </div>
  );
}
