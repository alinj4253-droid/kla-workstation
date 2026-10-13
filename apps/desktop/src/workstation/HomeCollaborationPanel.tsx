import { ChevronRight } from 'lucide-react';
import { Badge, Panel } from './ui';
import './home-collaboration.css';

type Props = {
  groupCount: number;
  loading: boolean;
  workspaceReady: boolean;
  onOpenGroups: () => void;
  onOpenCommunication: () => void;
  onOpenModels: () => void;
};

export function HomeCollaborationPanel({ groupCount, loading, workspaceReady, onOpenGroups, onOpenCommunication, onOpenModels }: Props): React.JSX.Element {
  const groupTitle = loading ? '正在加载群组…' : !workspaceReady ? '群组暂不可用' : groupCount ? `${groupCount} 组可用` : '尚未创建群组';
  return <Panel title="协同应用状态" subtitle="查看群组、通信与模型" className="ws-home-collaboration" action={<Badge tone={loading ? 'muted' : workspaceReady ? 'green' : 'orange'}>{loading ? '加载中' : workspaceReady ? '已加载' : '待加载'}</Badge>}>
    <div className="ws-home-collaboration-list">
      <button type="button" className="ws-home-collaboration-row" aria-label="查看项目与群组" disabled={loading || !workspaceReady} onClick={onOpenGroups}><span><strong>{groupTitle}</strong><small>{!workspaceReady && !loading ? '工作区加载失败，请刷新页面重试' : groupCount ? '查看当前身份的协作群组，进入群聊发起任务' : '进入项目工作区，创建群组并开始协作'}</small></span><ChevronRight size={15} className="ws-home-collaboration-arrow" /></button>
      <button type="button" className="ws-home-collaboration-row" aria-label="查看群组消息与文件" disabled={loading || !workspaceReady} onClick={onOpenCommunication}><span><strong>跨群组通信 · 消息与文件</strong><small>{groupCount ? '进入群聊工作空间，查看消息和共享文件' : '创建群组后即可查看消息和共享文件'}</small></span><ChevronRight size={15} className="ws-home-collaboration-arrow" /></button>
      <button type="button" className="ws-home-collaboration-row" aria-label="查看模型矩阵，打开模型广场" onClick={onOpenModels}><span><strong>模型矩阵 · 模型与能力</strong><small>查看可用模型、调用能力与算力信息</small></span><span className="ws-home-collaboration-view">查看 <ChevronRight size={13} /></span></button>
    </div>
  </Panel>;
}
