import { useEffect, useState } from 'react';
import { FileText, Paperclip } from 'lucide-react';
import { MarkdownMessage, RunActivity, type RoomRun, type RunEvent, type RunStep } from './CollaborationViews';
import { klaApi } from '../api/client';

export type MessageFile = { id: string; name: string; contentType?: string; sizeBytes: number };
export type ConversationDisplayBlock = { type: 'markdown'; content: string } | { type: 'image' | 'video' | 'audio'; asset_id: string; asset_kind: 'file' | 'artifact'; mime_type: string; url?: string; alt?: string; poster_url?: string } | { type: 'file'; artifact_id: string; name: string; mime_type: string; size_bytes?: number; open_mode?: 'right_drawer' };
export type ConversationMessage = { id?: string; author: string; text: string; time: string; senderType?: string; runId?: string; artifactIds?: string[]; files?: MessageFile[]; submitObject?: Array<{ type: 'user' | 'agent' | 'command'; id: string }>; blocks?: ConversationDisplayBlock[] };

type Props = {
  messages: ConversationMessage[];
  run: RoomRun | null;
  runs: RoomRun[];
  steps: RunStep[];
  events: RunEvent[];
  submitting: boolean;
  onCancel: () => void;
  onOpenFile: (file: MessageFile) => void;
  onOpenArtifact: (id: string) => void;
  memberNames?: Map<string, string>;
};

function InlineMedia({ block }: { block: Extract<ConversationDisplayBlock, { type: 'image' | 'video' | 'audio' }> }) {
  const [source, setSource] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    const path = block.asset_kind === 'artifact' ? `/v1/artifacts/${block.asset_id}/content` : `/v1/files/${block.asset_id}/content`;
    void klaApi.download(path).then(result => {
      if (!active) return;
      if (!result.ok) { setFailed(true); return; }
      objectUrl = URL.createObjectURL(result.blob);
      setSource(objectUrl);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [block.asset_id, block.asset_kind]);
  if (failed) return <span className="ws-inline-media-error">媒体加载失败</span>;
  if (!source) return <span className="ws-inline-media-loading">正在加载媒体…</span>;
  if (block.type === 'image') return <img className="ws-inline-media" src={source} alt={block.alt ?? ''} />;
  if (block.type === 'video') return <video className="ws-inline-media" controls poster={block.poster_url}><source src={source} type={block.mime_type} /></video>;
  return <audio className="ws-inline-audio" controls><source src={source} type={block.mime_type} /></audio>;
}

export function ConversationMessages({ messages, run, runs, steps, events, submitting, onCancel, onOpenFile, onOpenArtifact, memberNames = new Map() }: Props) {
  const isAgent = (message: ConversationMessage) => message.senderType === 'agent';
  const eventRunIds = new Map(events.filter(event => event.kind === 'message.created' && typeof event.payload.messageId === 'string').map(event => [event.payload.messageId as string, event.run_id]));
  const runIds = messages.map(message => message.runId ?? (message.id ? eventRunIds.get(message.id) : undefined));
  const knownRuns = new Map(runs.map(item => [item.id, item]));
  if (run) knownRuns.set(run.id, run);
  // Only the latest reply for a run carries its overall execution status.
  // Match by server IDs so another turn or agent never inherits the wrong log.
  const activityRows = new Map<string, number>();
  messages.forEach((message, index) => {
    const runId = runIds[index];
    if (isAgent(message) && runId) activityRows.set(runId, index);
  });
  for (const [runId, index] of activityRows) {
    const item = knownRuns.get(runId);
    if (item && !['completed', 'failed', 'cancelled'].includes(item.status) && messages[index].author !== (item.currentAgent ?? '统筹智能体')) activityRows.delete(runId);
  }
  const body = (message: ConversationMessage) => { const blocks = message.blocks?.length ? message.blocks : [{ type: 'markdown' as const, content: message.text }]; const embeddedArtifacts = new Set(blocks.filter((block): block is Extract<ConversationDisplayBlock, { type: 'file' }> => block.type === 'file').map(block => block.artifact_id)); return <div className="ws-message-bubble">{message.submitObject?.length ? <div className="ws-message-mentions">{message.submitObject.map((target, index) => <span key={`${target.type}:${target.id}`} className="ws-mention-chip">@{target.type === 'command' ? (target.id === 'coordinator' ? '群聊秘书' : '任务执行') : memberNames.get(`${target.type}:${target.id}`) ?? (target.type === 'agent' ? '智能体' : '成员')}{target.type !== 'command' && !memberNames.has(`${target.type}:${target.id}`) ? index + 1 : ''}</span>)}</div> : null}{blocks.map((block, index) => { if (block.type === 'markdown') return <MarkdownMessage key={`markdown-${index}`} text={block.content} />; if (block.type === 'image' || block.type === 'video' || block.type === 'audio') return <InlineMedia key={`${block.type}-${index}`} block={block} />; const fileBlock = block as Extract<ConversationDisplayBlock, { type: 'file' }>; return <button key={`${block.type}-${index}`} className="ws-text-button" onClick={() => onOpenArtifact(fileBlock.artifact_id)}><FileText size={14} /> {fileBlock.name}</button>; })}{message.files?.map(file => { const mime = file.contentType ?? ''; if (/^(image|video|audio)\//i.test(mime)) { const type = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'audio'; return <InlineMedia key={file.id} block={{ type, asset_id: file.id, asset_kind: 'file', mime_type: mime, alt: file.name }} />; } return <button key={file.id} className="ws-text-button" onClick={() => onOpenFile(file)}><Paperclip size={14} /> {file.name}</button>; })}{message.artifactIds?.filter(id => !embeddedArtifacts.has(id)).map((id, index) => <button key={id} className="ws-text-button" onClick={() => onOpenArtifact(id)}><FileText size={14} /> {index === 0 ? '打开成果文件' : `打开成果文件 ${index + 1}`}</button>)}</div>; };
  return <>
    {messages.map((message, index) => {
      const key = message.id ?? `${message.time}-${index}`;
      if (!isAgent(message)) return <div className={`ws-message ${message.author === '我' ? 'self' : ''}`} key={key}><span className="ws-avatar">{message.author.slice(0, 2)}</span><div><small>{message.author} · {message.time}</small>{body(message)}</div></div>;
      const runId = runIds[index];
      const activity = runId && activityRows.get(runId) === index ? knownRuns.get(runId) ?? null : null;
      return <RunActivity key={key} author={message.author} time={message.time} run={activity} steps={activity?.id === run?.id ? steps : []} events={events} submitting={false} onCancel={onCancel}>{body(message)}</RunActivity>;
    })}
    {submitting ? <RunActivity key="submitting" run={null} steps={[]} events={[]} submitting onCancel={onCancel} /> : run && !activityRows.has(run.id) ? <RunActivity key={run.id} run={run} steps={steps} events={events} submitting={false} onCancel={onCancel} /> : null}
  </>;
}
