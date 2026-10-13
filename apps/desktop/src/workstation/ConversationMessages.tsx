import { FileText, Paperclip } from 'lucide-react';
import { MarkdownMessage, RunActivity, type RoomRun, type RunEvent, type RunStep } from './CollaborationViews';

export type MessageFile = { id: string; name: string; contentType?: string; sizeBytes: number };
export type ConversationMessage = { id?: string; author: string; text: string; time: string; senderType?: string; runId?: string; artifactIds?: string[]; files?: MessageFile[] };

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
};

export function ConversationMessages({ messages, run, runs, steps, events, submitting, onCancel, onOpenFile, onOpenArtifact }: Props) {
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
  const body = (message: ConversationMessage) => <div className="ws-message-bubble"><MarkdownMessage text={message.text} />{message.files?.map(file => <button key={file.id} className="ws-text-button" onClick={() => onOpenFile(file)}><Paperclip size={14} /> {file.name}</button>)}{message.artifactIds?.map((id, index) => <button key={id} className="ws-text-button" onClick={() => onOpenArtifact(id)}><FileText size={14} /> {index === 0 ? '打开成果文件' : `打开成果文件 ${index + 1}`}</button>)}</div>;
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
