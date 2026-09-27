import {
  ArrowLeft, CalendarDays, Check, ChevronRight, Download, FileAudio, FileCode2,
  FileText, Folder, Loader2, MessageCircle, Mic, Pause, Play, Plus, Presentation, Radio, Send, Square, Users, X,
} from 'lucide-react';
import { init as initPptxPreview } from 'pptx-preview';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { associationKey, normalizeEnterpriseProjects, normalizeProjectAssociations, type EnterpriseProject } from '../enterprise-projects';
import { formatMeetingDuration, Pcm16Chunker } from '../meeting-audio';

type MeetingKind = 'upload' | 'realtime';
type MeetingStatus = 'draft' | 'processing' | 'ready' | 'recording' | 'paused' | 'ended' | 'failed';
type MeetingTranscriptLine = {
  id: string;
  speaker: string;
  text: string;
  at: string;
  stable?: boolean;
  speakerId?: number;
  speakerClusterId?: string;
  startTime?: number;
  endTime?: number;
};
type MeetingAction = { id: string; title: string; owner: string; due: string; done: boolean };
type MeetingSpeakerIdentity = {
  clusterId: string;
  label: string;
  name: string;
  status: 'unresolved' | 'suggested' | 'confirmed' | 'anonymous';
  confidence?: number;
  reason?: string;
  evidenceLineIds?: string[];
};
type MeetingMinutesStatus = 'not-started' | 'analyzing-speakers' | 'awaiting-confirmation' | 'ready' | 'generating' | 'completed' | 'failed';
type Meeting = {
  id: string;
  name: string;
  description: string;
  kind: MeetingKind;
  projectId: string;
  projectName: string;
  status: MeetingStatus;
  createdAt: string;
  audioFileName?: string;
  audioSize?: number;
  audioMimeType?: string;
  audioRelativePath?: string;
  durationSeconds?: number;
  transcript: MeetingTranscriptLine[];
  summary: string;
  actions: MeetingAction[];
  conclusions?: string[];
  speakerHints: string[];
  speakerContextId?: string;
  speakerIdentities?: MeetingSpeakerIdentity[];
  confirmationMessages?: string[];
  minutesStatus?: MeetingMinutesStatus;
  updatedAt: string;
};
type ProjectItem = Pick<EnterpriseProject, 'id' | 'name' | 'description'>;
type RpcResult<T> = { ok?: boolean; data?: T; error?: { message?: string } };
type WorkspaceFileEntry = {
  name: string;
  relativePath: string;
  kind: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  system?: boolean;
  physicalName?: string;
};
type WorkspaceLocation = { systemDir: string; label: string; path: string };
type MeetingPresentationData =
  | { kind: 'html'; content: string; appFileUrl?: string; fileName: string }
  | { kind: 'pptx'; bytes: Uint8Array; fileName: string };
type RecordingPhase = 'idle' | 'starting' | 'recording' | 'paused' | 'ending' | 'ended';
type TencentAsrSentence = {
  sentence: string;
  sentence_type: 0 | 1;
  sentence_id: number;
  speaker_id: number;
  start_time?: number;
  end_time?: number;
};
type TencentAsrSentences = TencentAsrSentence | TencentAsrSentence[] | {
  sentence_list?: TencentAsrSentence[];
};
type TencentAsrMessage = {
  code?: number;
  message?: string;
  final?: number;
  speaker_context_id?: string;
  sentences?: TencentAsrSentences;
};
type RecognitionSession = {
  socket: WebSocket;
  voiceId: string;
  speakerContextId: string;
  chunker: Pcm16Chunker;
  intentionalClose: boolean;
  finalPromise: Promise<void>;
  resolveFinal: () => void;
};

const createId = (): string => globalThis.crypto?.randomUUID?.() ?? `meeting-${Date.now().toString(36)}`;
const formatTime = (value: string): string => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const formatSize = (bytes = 0): string => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const normalizeTencentAsrSentences = (value: TencentAsrSentences): TencentAsrSentence[] => {
  if (Array.isArray(value)) return value;
  if ('sentence' in value) return [value];
  return Array.isArray(value.sentence_list) ? value.sentence_list : [];
};
const defaultMeetingActions = (name: string): MeetingAction[] => [
  { id: createId(), title: `整理“${name}”会议结论并同步给项目成员`, owner: '项目负责人', due: '待确认', done: false },
  { id: createId(), title: '补充待确认的说话人和责任人信息', owner: '会议智能体', due: '待确认', done: false },
];
const defaultProject: ProjectItem = {
  id: 'enterprise-personal',
  name: '个人项目',
  description: '用于承载尚未归入专项项目的会议与工作成果。',
};

function inferSpeakerIdentities(transcript: MeetingTranscriptLine[], existing: MeetingSpeakerIdentity[] = []): MeetingSpeakerIdentity[] {
  const byCluster = new Map(existing.map((identity) => [identity.clusterId, identity]));
  for (const line of transcript) {
    if (line.stable === false || !line.speakerClusterId || byCluster.has(line.speakerClusterId)) continue;
    byCluster.set(line.speakerClusterId, {
      clusterId: line.speakerClusterId,
      label: line.speaker,
      name: line.speaker,
      status: 'unresolved',
    });
  }
  return [...byCluster.values()];
}

function allSpeakersConfirmed(speakers: MeetingSpeakerIdentity[]): boolean {
  return speakers.every((speaker) => speaker.status === 'confirmed' || speaker.status === 'anonymous');
}

function resolvedTranscript(transcript: MeetingTranscriptLine[], speakers: MeetingSpeakerIdentity[]): MeetingTranscriptLine[] {
  const names = new Map(speakers.map((speaker) => [speaker.clusterId, speaker.status === 'confirmed' ? speaker.name : speaker.label]));
  return transcript.map((line) => line.speakerClusterId && names.has(line.speakerClusterId) ? { ...line, speaker: names.get(line.speakerClusterId)! } : line);
}

function resolvedStableTranscript(transcript: MeetingTranscriptLine[], speakers: MeetingSpeakerIdentity[]): MeetingTranscriptLine[] {
  return resolvedTranscript(transcript, speakers).filter((line) => line.stable !== false);
}

function createMeeting(input: { name: string; description: string; kind: MeetingKind; project: ProjectItem; file?: File }): Meeting {
  const now = new Date().toISOString();
  const file = input.file;
  return {
    id: createId(), name: input.name, description: input.description, kind: input.kind, projectId: input.project.id,
    projectName: input.project.name, status: input.kind === 'upload' ? 'processing' : 'ready', createdAt: now,
    ...(file ? { audioFileName: file.name, audioSize: file.size } : {}),
    transcript: input.kind === 'upload' ? [] : [{ id: createId(), speaker: '会议智能体', text: '实时会议记录已准备，开始记录后会在这里显示说话内容。', at: now }],
    summary: input.kind === 'upload' ? '录音正在转写。转写完成后，会议智能体会整理关键结论和待办。' : '会议开始后，会议智能体会持续提炼当前讨论的重点。',
    actions: [], speakerHints: [], updatedAt: now,
  };
}

export function MeetingsPage(): React.JSX.Element {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [knownPeople, setKnownPeople] = useState<string[]>(['项目负责人']);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(286);
  const [presentation, setPresentation] = useState<MeetingPresentationData | null>(null);
  const resizingRef = useRef(false);
  const meetingsRef = useRef<Meeting[]>([]);

  const persist = useCallback(async (next: Meeting[]): Promise<boolean> => {
    const result = await window.kunqing?.settings.update({ meetings: next }) as RpcResult<unknown> | undefined;
    if (!result?.ok) { setNotice(result?.error?.message || '会议保存失败'); return false; }
    setMeetings(next); return true;
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [settingsResult] = await Promise.all([
        window.kunqing?.settings.getAll() as Promise<RpcResult<Record<string, unknown>>> | undefined,
      ]);
      const raw = settingsResult?.data?.meetings;
      setMeetings(Array.isArray(raw) ? raw as Meeting[] : []);
      setKnownPeople([String(settingsResult?.data?.personalNickname ?? '').trim() || '项目负责人']);
      const enterpriseProjects = normalizeEnterpriseProjects(settingsResult?.data?.enterpriseProjects);
      setProjects(enterpriseProjects.length > 0 ? enterpriseProjects : [defaultProject]);
    } catch (error) { setNotice(error instanceof Error ? error.message : '会议加载失败'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { meetingsRef.current = meetings; }, [meetings]);
  const selected = useMemo(() => meetings.find((meeting) => meeting.id === selectedId) ?? null, [meetings, selectedId]);

  const updateMeeting = useCallback(async (meetingId: string, changes: Partial<Meeting>): Promise<void> => {
    const next = meetingsRef.current.map((item) => item.id === meetingId ? { ...item, ...changes, updatedAt: new Date().toISOString() } : item);
    meetingsRef.current = next;
    setMeetings(next);
    const result = await window.kunqing?.settings.update({ meetings: next }) as RpcResult<unknown> | undefined;
    if (!result?.ok) setNotice(result?.error?.message || '会议保存失败');
  }, []);

  const startResize = (event: React.MouseEvent): void => {
    event.preventDefault(); resizingRef.current = true;
    const startX = event.clientX; const startWidth = sidebarWidth;
    const onMove = (move: MouseEvent): void => { if (resizingRef.current) setSidebarWidth(Math.max(220, Math.min(460, startWidth + move.clientX - startX))); };
    const onUp = (): void => { resizingRef.current = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  };

  const create = async (input: { name: string; description: string; kind: MeetingKind; project: ProjectItem; file?: File }): Promise<boolean> => {
    if (input.kind === 'realtime') {
      if (!navigator.mediaDevices?.getUserMedia) { setNotice('当前环境不支持麦克风访问，请使用桌面端。'); return false; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        let devices = await navigator.mediaDevices.enumerateDevices();
        if (!devices.some((device) => device.kind === 'audioinput')) { setNotice('未检测到可用麦克风。'); return false; }
        if (!devices.some((device) => device.kind === 'audiooutput')) {
          const selectAudioOutput = (navigator.mediaDevices as MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> }).selectAudioOutput;
          if (selectAudioOutput) {
            try { await selectAudioOutput.call(navigator.mediaDevices); } catch { setNotice('听筒或声卡权限未授权，请允许选择输出设备后重试。'); return false; }
            devices = await navigator.mediaDevices.enumerateDevices();
          }
          if (!devices.some((device) => device.kind === 'audiooutput')) { setNotice('未检测到可用听筒或声卡。'); return false; }
        }
      } catch { setNotice('麦克风权限未授权或设备不可用，请授权后重试。'); return false; }
    }
    const meeting = createMeeting(input);
    if (input.file && window.kunqing?.meetings) {
      const bytes = new Uint8Array(await input.file.arrayBuffer());
      const saved = await window.kunqing.meetings.saveRecording({ projectId: input.project.id, meetingId: meeting.id, fileName: input.file.name, bytes }) as RpcResult<unknown>;
      if (!saved?.ok) { setNotice(saved?.error?.message || '录音文件保存失败'); return false; }
    }
    const next = [meeting, ...meetings];
    const settings = await window.kunqing?.settings.getAll() as RpcResult<Record<string, unknown>> | undefined;
    const associations = normalizeProjectAssociations(settings?.data?.enterpriseProjectAssociations);
    const savedMeeting = await window.kunqing?.settings.update({
      meetings: next,
      enterpriseProjectAssociations: { ...associations, [associationKey('meeting', meeting.id)]: meeting.projectId },
    }) as RpcResult<unknown> | undefined;
    if (!savedMeeting?.ok) { setNotice(savedMeeting?.error?.message || '会议保存失败'); return false; }
    setMeetings(next);
    setSelectedId(meeting.id); setCreateOpen(false); setNotice('');
    if (meeting.kind === 'upload') {
      window.setTimeout(() => {
        setMeetings((current) => {
          const latest = current.map((item) => item.id === meeting.id ? {
            ...item, status: 'ready' as const, transcript: [{ id: createId(), speaker: '说话人 1', text: `已完成对录音“${item.audioFileName || '会议录音'}”的转写。请在右侧对话中确认说话人和关键结论。`, at: new Date().toISOString() }],
            summary: '录音转写已完成。会议智能体已提炼讨论重点，待办事项可在会议纪要中继续确认。', actions: defaultMeetingActions(item.name), updatedAt: new Date().toISOString(),
          } : item);
          void window.kunqing?.settings.update({ meetings: latest });
          return latest;
        });
      }, 1800);
    }
    return true;
  };

  return <div className={`meeting-workspace${sidebarOpen ? '' : ' meeting-workspace--sidebar-closed'}`} style={{ '--meeting-sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}>
    {sidebarOpen && <aside className="meeting-sidebar" aria-label="会议列表"><header><button type="button" className="icon-button" aria-label="收起会议列表" title="收起会议列表" onClick={() => setSidebarOpen(false)}><span className="meeting-sidebar-collapse">‹</span></button><h2>会议</h2><button type="button" className="icon-button" aria-label="创建会议" title="创建会议" onClick={() => setCreateOpen(true)}><Plus size={18} /></button></header><div className="meeting-list">{loading ? <p className="meeting-list-empty">加载中...</p> : meetings.length === 0 ? <p className="meeting-list-empty">暂无会议记录</p> : meetings.map((meeting) => <button type="button" className={`meeting-list-item${meeting.id === selectedId ? ' meeting-list-item--active' : ''}`} key={meeting.id} onClick={() => setSelectedId(meeting.id)}><span className="meeting-list-item__avatar"><CalendarDays size={15} /></span><span><strong>{meeting.name}</strong><small>{meeting.projectName} · {meeting.status === 'processing' ? '转写中' : meeting.kind === 'realtime' ? '实时语音' : '录音文件'}</small></span><time>{new Date(meeting.createdAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</time></button>)}</div><div className="meeting-sidebar-resize" onMouseDown={startResize} /></aside>}
    <main className="meeting-main">{!sidebarOpen && <button type="button" className="icon-button meeting-sidebar-expand" aria-label="展开会议列表" title="展开会议列表" onClick={() => setSidebarOpen(true)}>›</button>}{selected ? <MeetingDetail key={selected.id} meeting={selected} knownPeople={knownPeople} onPresent={setPresentation} onUpdate={(changes) => updateMeeting(selected.id, changes)} /> : <MeetingEmpty onCreate={() => setCreateOpen(true)} />}{notice && <div className="meeting-notice">{notice}</div>}</main>
    {createOpen && <CreateMeetingDialog projects={projects} onClose={() => setCreateOpen(false)} onSubmit={create} />}
    {presentation && <MeetingPresentation presentation={presentation} onExit={() => setPresentation(null)} />}
  </div>;
}

function MeetingEmpty({ onCreate }: { onCreate: () => void }): React.JSX.Element { return <div className="meeting-empty"><span><Mic size={30} /></span><h1>创建会议记录</h1><p>上传录音或开启实时语音记录，会议智能体会帮你整理转写、摘要和待办。</p><button type="button" className="primary-button" onClick={onCreate}><Plus size={16} />创建会议</button></div>; }

function MeetingPresentationWorkspace({ meeting, onPresent }: { meeting: Meeting; onPresent: (presentation: MeetingPresentationData) => void }): React.JSX.Element {
  const [location, setLocation] = useState<WorkspaceLocation | null>(null);
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [presentingPath, setPresentingPath] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    const loadEntries = async (): Promise<void> => {
      const workspace = window.kunqing?.workspace;
      if (!workspace) { setError('请在 KLA 桌面端打开项目工作区'); setLoading(false); return; }
      setLoading(true);
      setEntries([]);
      setError('');
      try {
        const ensured = await workspace.ensureEnterpriseProject({ projectId: meeting.projectId, name: meeting.projectName }) as RpcResult<unknown>;
        if (!ensured?.ok) throw new Error(ensured?.error?.message || '关联项目工作区初始化失败');
        const projectWorkspaceRequest = {
          projectId: meeting.projectId,
          scopeType: 'project-shared' as const,
          scopeId: meeting.projectId,
          resourceType: 'meeting' as const,
          resourceId: meeting.id,
        };
        let result: RpcResult<WorkspaceFileEntry[]> | undefined;
        if (!location) {
          result = await workspace.listSystemDirs(projectWorkspaceRequest) as RpcResult<WorkspaceFileEntry[]>;
        } else if (location.systemDir === 'original-files') {
          result = await workspace.listFiles({ ...projectWorkspaceRequest, relativePath: location.path, systemDir: location.systemDir }) as RpcResult<WorkspaceFileEntry[]>;
        } else {
          result = await workspace.listProjectDir({ ...projectWorkspaceRequest, relativePath: location.path, systemDir: location.systemDir }) as RpcResult<WorkspaceFileEntry[]>;
        }
        if (!disposed) {
          if (!result?.ok) setError(result?.error?.message || '无法读取项目工作区');
          setEntries(result?.data ?? []);
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : '无法读取项目工作区');
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void loadEntries();
    return () => { disposed = true; };
  }, [location, meeting.id, meeting.projectId, meeting.projectName]);

  const openDirectory = (entry: WorkspaceFileEntry): void => {
    if (!location) {
      const systemDir = entry.physicalName || entry.relativePath;
      setLocation({ systemDir, label: entry.name, path: systemDir === 'original-files' ? '' : systemDir });
      return;
    }
    setLocation({ ...location, path: entry.relativePath });
  };

  const goBack = (): void => {
    if (!location) return;
    const rootPath = location.systemDir === 'original-files' ? '' : location.systemDir;
    if (location.path === rootPath) { setLocation(null); return; }
    const parent = location.path.split('/').slice(0, -1).join('/');
    if (location.systemDir !== 'original-files' && parent !== location.systemDir && !parent.startsWith(`${location.systemDir}/`)) setLocation(null);
    else setLocation({ ...location, path: parent });
  };

  const presentFile = async (entry: WorkspaceFileEntry): Promise<void> => {
    const workspace = window.kunqing?.workspace;
    if (!workspace) return;
    setPresentingPath(entry.relativePath);
    setError('');
    try {
      const input = {
        projectId: meeting.projectId,
        relativePath: entry.relativePath,
        scopeType: 'project-shared' as const,
        scopeId: meeting.projectId,
        resourceType: 'meeting' as const,
        resourceId: meeting.id,
      };
      const result = await workspace.getPreview(input) as RpcResult<{ kind: string; content?: string; appFileUrl?: string; bytes?: Uint8Array | number[]; fileName?: string; error?: string }>;
      if (!result?.ok || !result.data || result.data.error) {
        setError(result?.data?.error || result?.error?.message || '所选文件无法演示');
        return;
      }
      if (result.data.kind === 'html') {
        onPresent({ kind: 'html', content: result.data.content ?? '', fileName: result.data.fileName ?? entry.name, ...(result.data.appFileUrl ? { appFileUrl: result.data.appFileUrl } : {}) });
        return;
      }
      const bytes = result.data.bytes instanceof Uint8Array
        ? result.data.bytes
        : Array.isArray(result.data.bytes) ? Uint8Array.from(result.data.bytes) : null;
      if (result.data.kind === 'pptx' && bytes) {
        onPresent({ kind: 'pptx', bytes, fileName: result.data.fileName ?? entry.name });
        return;
      }
      setError('所选文件无法演示');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '演示文件加载失败');
    } finally {
      setPresentingPath('');
    }
  };

  const nestedPath = !location
    ? ''
    : location.systemDir === 'original-files'
      ? location.path
      : location.path === location.systemDir ? '' : location.path.slice(location.systemDir.length + 1);
  const locationLabel = !location ? meeting.projectName : `${meeting.projectName} / ${location.label}${nestedPath ? ` / ${nestedPath}` : ''}`;

  return <section className="meeting-presentation-workspace" aria-labelledby="meeting-presentation-workspace-title">
    <header><div><h2 id="meeting-presentation-workspace-title">项目演示文件</h2><p>浏览“{meeting.projectName}”项目工作区，选择 HTML 或 PPTX 文件开始演示。</p></div></header>
    <div className="meeting-workspace-path"><button type="button" className="icon-button" aria-label="返回上一级" disabled={!location} onClick={goBack}><ArrowLeft size={17} /></button><Folder size={16} /><span>{locationLabel}</span></div>
    <div className="meeting-workspace-files" role="list" aria-label="项目工作区文件">
      {loading ? <div className="meeting-workspace-empty"><Loader2 size={20} className="spin" />正在读取项目文件...</div> : error && entries.length === 0 ? <div className="meeting-workspace-empty">{error}</div> : entries.length === 0 ? <div className="meeting-workspace-empty">当前文件夹为空</div> : entries.map((entry) => entry.kind === 'directory'
        ? <button type="button" className="meeting-workspace-entry meeting-workspace-entry--directory" key={entry.relativePath} onClick={() => openDirectory(entry)}><Folder size={18} /><span><strong>{entry.name}</strong><small>文件夹</small></span><ChevronRight size={16} /></button>
        : <div className="meeting-workspace-entry meeting-workspace-entry--file" role="listitem" key={entry.relativePath}>{/\.html?$/i.test(entry.name) ? <FileCode2 size={18} /> : /\.pptx$/i.test(entry.name) ? <Presentation size={18} /> : <FileText size={18} />}<span><strong>{entry.name}</strong><small>{formatSize(entry.size)}</small></span>{/\.(?:html?|pptx)$/i.test(entry.name) ? <button type="button" className="secondary-button meeting-present-button" aria-label={`演示 ${entry.name}`} disabled={presentingPath === entry.relativePath} onClick={() => void presentFile(entry)}>{presentingPath === entry.relativePath ? <Loader2 size={14} className="spin" /> : <Play size={14} />}演示</button> : <span />}</div>)}
      </div>
      {error && entries.length > 0 && <div className="meeting-workspace-error">{error}</div>}
  </section>;
}

function MeetingPresentation({ presentation, onExit }: { presentation: MeetingPresentationData; onExit: () => void }): React.JSX.Element {
  const exitPresentation = useCallback((): void => {
    void window.kunqing?.app?.setFullscreen?.({ enabled: false });
    onExit();
  }, [onExit]);
  const handleKeyDown = useCallback((event: KeyboardEvent): void => { if (event.key === 'Escape') exitPresentation(); }, [exitPresentation]);
  useEffect(() => {
    void window.kunqing?.app?.setFullscreen?.({ enabled: true, presentationType: presentation.kind });
    const unsubscribe = window.kunqing?.app?.onFullscreenExit?.(exitPresentation);
    return () => {
      unsubscribe?.();
      void window.kunqing?.app?.setFullscreen?.({ enabled: false });
    };
  }, [exitPresentation, presentation.kind]);
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const bindFrameKeyboard = (frame: HTMLIFrameElement): void => {
    frame.focus();
    try {
      const frameWindow = frame.contentWindow;
      if (!frameWindow) return;
      frameWindow.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          exitPresentation();
          return;
        }
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        const distance = Math.max(200, Math.round(frameWindow.innerHeight * 0.8));
        frameWindow.scrollBy({ top: event.key === 'ArrowDown' ? distance : -distance, behavior: 'smooth' });
      });
    } catch { /* cross-origin previews keep native arrow scrolling after the iframe receives focus */ }
  };

  return <div className="meeting-presentation" data-testid="meeting-presentation">
    {presentation.kind === 'html'
      ? <iframe
          src={presentation.appFileUrl}
          srcDoc={presentation.appFileUrl ? undefined : presentation.content}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
          referrerPolicy="no-referrer"
          tabIndex={0}
          title={`会议演示：${presentation.fileName}`}
          onLoad={(event) => bindFrameKeyboard(event.currentTarget)}
        />
      : <PptxPresentationPlayer presentation={presentation} />}
    <button type="button" className="icon-button meeting-presentation-exit" aria-label="退出演示" title="退出演示" onClick={exitPresentation}><X size={20} /></button>
  </div>;
}

function PptxPresentationPlayer({ presentation }: { presentation: Extract<MeetingPresentationData, { kind: 'pptx' }> }): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const previewerRef = useRef<ReturnType<typeof initPptxPreview> | null>(null);
  const loadingRef = useRef(true);
  const lastNavigationRef = useRef<{ key: 'ArrowUp' | 'ArrowDown'; at: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fitSlides = (): void => setScale(Math.min(window.innerWidth / 1280, window.innerHeight / 720));
    fitSlides();
    window.addEventListener('resize', fitSlides);
    return () => window.removeEventListener('resize', fitSlides);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // pptx-preview appends its wrapper to the host but destroy() does not
    // remove that DOM. The host is dedicated to this instance, so clear it
    // before every initialization and after cleanup to handle React StrictMode
    // effect replays without leaving an orphaned, visible presentation behind.
    host.replaceChildren();
    let disposed = false;
    const previewer = initPptxPreview(host, { width: 1280, height: 720, mode: 'slide' });
    previewerRef.current = previewer;
    const buffer = new Uint8Array(presentation.bytes.byteLength);
    buffer.set(presentation.bytes);
    void previewer.preview(buffer.buffer).then(() => {
      if (!disposed) {
        previewer.updatePagination();
        loadingRef.current = false;
        setLoading(false);
        stageRef.current?.focus();
      }
    }).catch((cause: unknown) => {
      if (!disposed) {
        loadingRef.current = false;
        setLoading(false);
        setError(cause instanceof Error ? cause.message : 'PPTX 文件加载失败');
      }
    });
    return () => {
      disposed = true;
      loadingRef.current = true;
      previewerRef.current = null;
      previewer.destroy();
      host.replaceChildren();
    };
  }, [presentation.bytes]);

  useEffect(() => {
    const navigate = (key: string): boolean => {
      const navigationKey = key === 'ArrowUp' || key === 'ArrowLeft' || key === 'PageUp'
        ? 'ArrowUp'
        : key === 'ArrowDown' || key === 'ArrowRight' || key === 'PageDown' || key === ' '
          ? 'ArrowDown'
          : null;
      if (!navigationKey) return false;
      const previewer = previewerRef.current;
      if (!previewer || loadingRef.current) return true;
      const now = performance.now();
      const previous = lastNavigationRef.current;
      if (previous?.key === navigationKey && now - previous.at < 80) return true;
      lastNavigationRef.current = { key: navigationKey, at: now };
      if (navigationKey === 'ArrowDown') {
        previewer.renderNextSlide();
        return true;
      }
      previewer.renderPreSlide();
      return true;
    };
    const changeSlide = (event: KeyboardEvent): void => {
      if (navigate(event.key || event.code)) event.preventDefault();
    };
    const unsubscribe = window.kunqing?.app?.onPresentationKey?.((key) => { navigate(key); });
    window.addEventListener('keydown', changeSlide, true);
    return () => {
      unsubscribe?.();
      window.removeEventListener('keydown', changeSlide, true);
    };
  }, []);

  return <div ref={stageRef} className="meeting-pptx-stage" aria-label={`PPTX 演示：${presentation.fileName}`} tabIndex={-1}>
    <div className="meeting-pptx-renderer" ref={hostRef} style={{ transform: `translate(-50%, -50%) scale(${scale})` }} />
    {loading && <div className="meeting-pptx-status"><Loader2 size={24} className="spin" /><span>正在载入演示文稿</span></div>}
    {error && <div className="meeting-pptx-status meeting-pptx-status--error"><Presentation size={28} /><strong>PPTX 演示加载失败</strong><span>{error}</span></div>}
  </div>;
}

function CreateMeetingDialog({ projects, onClose, onSubmit }: { projects: ProjectItem[]; onClose: () => void; onSubmit: (input: { name: string; description: string; kind: MeetingKind; project: ProjectItem; file?: File }) => Promise<boolean> }): React.JSX.Element {
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [kind, setKind] = useState<MeetingKind>('upload'); const [projectId, setProjectId] = useState(projects[0]?.id ?? ''); const [file, setFile] = useState<File>(); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const project = projects.find((item) => item.id === projectId);
  const submit = async (event: FormEvent): Promise<void> => { event.preventDefault(); if (!name.trim()) { setError('请输入会议名称'); return; } if (!project) { setError('请选择关联项目'); return; } if (kind === 'upload' && !file) { setError('请选择录音文件'); return; } setSaving(true); const ok = await onSubmit({ name: name.trim(), description: description.trim(), kind, project, ...(file ? { file } : {}) }); setSaving(false); if (!ok) setError('会议创建失败，请检查设备权限或稍后重试'); };
  return <div className="modal-backdrop modal-backdrop--nested" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="meeting-create-dialog" role="dialog" aria-modal="true" onSubmit={(event) => void submit(event)}><header><div><span>会议中心</span><h2>创建会议</h2><p>选择会议记录方式，会议内容会保存在本地工作区。</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header><label><span>会议名称 <em>*</em></span><input autoFocus value={name} onChange={(event) => { setName(event.target.value); setError(''); }} placeholder="例如：Q3 经营复盘会" maxLength={80} /></label><label><span>会议简介</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="补充会议背景、目标或参会范围（选填）" /></label><fieldset><legend>记录方式 <em>*</em></legend><div className="meeting-kind-options"><label className={kind === 'upload' ? 'selected' : ''}><input type="radio" checked={kind === 'upload'} onChange={() => setKind('upload')} /> <FileAudio size={17} /><span><strong>上传录音文件</strong><small>创建后自动转写，支持常见音频格式</small></span></label><label className={kind === 'realtime' ? 'selected' : ''}><input type="radio" checked={kind === 'realtime'} onChange={() => setKind('realtime')} /> <Radio size={17} /><span><strong>实时语音记录</strong><small>创建前检查麦克风与听筒权限</small></span></label></div></fieldset>{kind === 'upload' && <label><span>录音文件 <em>*</em></span><input type="file" accept="audio/*" onChange={(event) => { setFile(event.target.files?.[0]); setError(''); }} />{file && <small className="meeting-file-picked">{file.name} · {formatSize(file.size)}</small>}</label>}<label><span>关联项目 <em>*</em></span><select value={projectId} onChange={(event) => { setProjectId(event.target.value); setError(''); }}><option value="" disabled>请选择项目</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{error && <small className="meeting-dialog-error">{error}</small>}<footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={saving}>{saving ? <><Loader2 size={15} className="spin" /> 创建中...</> : '创建会议'}</button></footer></form></div>;
}

const getAudioMimeType = (): string => ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  .find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? '';

const buildTranscriptText = (meeting: Meeting, transcript: MeetingTranscriptLine[], durationSeconds: number): string => [
  `会议名称：${meeting.name}`,
  `关联项目：${meeting.projectName}`,
  `录制时长：${formatMeetingDuration(durationSeconds)}`,
  `会议时间：${new Date(meeting.createdAt).toLocaleString('zh-CN')}`,
  '',
  '会议转写',
  ...transcript.map((line) => `[${formatTime(line.at)}] ${line.speaker}：${line.text}`),
  '',
  '会议摘要',
  meeting.summary || '暂无摘要',
].join('\n');

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

function MeetingDetail({ meeting, onPresent, onUpdate, knownPeople }: { meeting: Meeting; onPresent: (presentation: MeetingPresentationData) => void; onUpdate: (changes: Partial<Meeting>) => Promise<void>; knownPeople: string[] }): React.JSX.Element {
  const [tab, setTab] = useState<'transcript' | 'minutes' | 'presentation'>('transcript');
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState<RecordingPhase>(meeting.status === 'ended' ? 'ended' : 'idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(meeting.durationSeconds ?? 0);
  const [transcript, setTranscript] = useState(meeting.transcript);
  const initialSpeakerIdentities = useMemo(() => inferSpeakerIdentities(meeting.transcript, meeting.speakerIdentities ?? []), [meeting.speakerIdentities, meeting.transcript]);
  const [speakerIdentities, setSpeakerIdentities] = useState<MeetingSpeakerIdentity[]>(initialSpeakerIdentities);
  const [speakerDrafts, setSpeakerDrafts] = useState<Record<string, string>>(() => Object.fromEntries(initialSpeakerIdentities.map((speaker) => [speaker.clusterId, speaker.name])));
  const [minutesStatus, setMinutesStatus] = useState<MeetingMinutesStatus>(meeting.minutesStatus ?? (meeting.kind === 'upload' && meeting.status === 'ready' ? 'completed' : 'not-started'));
  const [confirmationMessages, setConfirmationMessages] = useState<string[]>(meeting.confirmationMessages ?? []);
  const [recordNotice, setRecordNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [generatingMinutes, setGeneratingMinutes] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ id: string; role: 'agent' | 'user'; text: string }>>([{ id: createId(), role: 'agent', text: '我会协助确认说话人、项目人员和会议中的不确定事项。请告诉我需要修正的地方。' }]);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioBlobRef = useRef<Blob | null>(null);
  const audioRelativePathRef = useRef(meeting.audioRelativePath ?? '');
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioGainRef = useRef<GainNode | null>(null);
  const recognitionRef = useRef<RecognitionSession | null>(null);
  const speakerContextIdRef = useRef(meeting.speakerContextId ?? '');
  const speakerIdentitiesRef = useRef(speakerIdentities);
  const confirmationMessagesRef = useRef(confirmationMessages);
  const speakerLabelsRef = useRef(new Map(initialSpeakerIdentities.map((speaker) => [speaker.clusterId, speaker.label])));
  const nextSpeakerNumberRef = useRef(Math.max(0, ...initialSpeakerIdentities.map((speaker) => Number(speaker.label.match(/\d+/)?.[0] ?? 0))) + 1);
  const phaseRef = useRef<RecordingPhase>(phase);
  const elapsedSecondsRef = useRef(elapsedSeconds);
  const transcriptRef = useRef(transcript);
  const onUpdateRef = useRef(onUpdate);

  phaseRef.current = phase;
  elapsedSecondsRef.current = elapsedSeconds;
  transcriptRef.current = transcript;
  speakerIdentitiesRef.current = speakerIdentities;
  confirmationMessagesRef.current = confirmationMessages;
  onUpdateRef.current = onUpdate;

  const changePhase = (next: RecordingPhase): void => { phaseRef.current = next; setPhase(next); };

  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = window.setInterval(() => {
      setElapsedSeconds((value) => {
        elapsedSecondsRef.current = value + 1;
        return value + 1;
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [phase]);

  const speakerLabel = (clusterId: string): string => {
    const existing = speakerLabelsRef.current.get(clusterId);
    if (existing) return existing;
    const label = `说话人${nextSpeakerNumberRef.current++}`;
    speakerLabelsRef.current.set(clusterId, label);
    return label;
  };

  const applyRecognitionSentences = (session: RecognitionSession, value: TencentAsrSentences): void => {
    const sentences = normalizeTencentAsrSentences(value);
    if (!sentences.length) return;
    setTranscript((current) => {
      let next = current;
      let hasStableUpdate = false;
      for (const sentence of sentences) {
        const text = sentence.sentence?.trim();
        if (!text || !Number.isInteger(sentence.sentence_id)) continue;
        const id = `tencent-asr-${session.voiceId}-${sentence.sentence_id}`;
        const existingIndex = next.findIndex((item) => item.id === id);
        const stable = sentence.sentence_type === 1;
        const hasSpeaker = Number.isInteger(sentence.speaker_id) && sentence.speaker_id >= 0;
        const clusterId = hasSpeaker ? `${session.speakerContextId || session.voiceId}:${sentence.speaker_id}` : '';
        const line: MeetingTranscriptLine = {
          id,
          speaker: clusterId ? speakerLabel(clusterId) : '说话人识别中',
          text,
          at: existingIndex >= 0 ? next[existingIndex]!.at : new Date().toISOString(),
          stable,
          speakerId: sentence.speaker_id,
          ...(clusterId ? { speakerClusterId: clusterId } : {}),
          ...(sentence.start_time !== undefined ? { startTime: sentence.start_time } : {}),
          ...(sentence.end_time !== undefined ? { endTime: sentence.end_time } : {}),
        };
        next = existingIndex >= 0
          ? next.map((item, index) => index === existingIndex ? line : item)
          : [...next, line];
        hasStableUpdate ||= stable;
      }
      transcriptRef.current = next;
      const nextIdentities = inferSpeakerIdentities(next, speakerIdentitiesRef.current);
      if (nextIdentities.length !== speakerIdentitiesRef.current.length) {
        speakerIdentitiesRef.current = nextIdentities;
        setSpeakerIdentities(nextIdentities);
        setSpeakerDrafts((drafts) => ({ ...Object.fromEntries(nextIdentities.map((speaker) => [speaker.clusterId, speaker.name])), ...drafts }));
      }
      if (hasStableUpdate) void onUpdateRef.current({ transcript: next, speakerIdentities: nextIdentities });
      return next;
    });
  };

  const connectRecognition = async (): Promise<void> => {
    const speakerContextId = speakerContextIdRef.current;
    const response = await window.kunqing?.meetings.getRealtimeRecognitionUrl(speakerContextId ? { speakerContextId } : undefined) as RpcResult<{ url: string; voiceId: string; engineModelType: string }> | undefined;
    if (!response?.ok || !response.data?.url || !response.data.voiceId) {
      throw new Error(response?.error?.message || '无法获取腾讯实时语音识别连接');
    }
    const { url, voiceId } = response.data;
    const socket = new WebSocket(url);
    let resolveFinal = (): void => undefined;
    const finalPromise = new Promise<void>((resolve) => { resolveFinal = resolve; });
    const session: RecognitionSession = { socket, voiceId, speakerContextId, chunker: new Pcm16Chunker(), intentionalClose: false, finalPromise, resolveFinal };
    recognitionRef.current = session;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        session.intentionalClose = true;
        socket.close();
        reject(new Error('连接腾讯实时语音识别超时'));
      }, 10_000);
      const failHandshake = (error: Error): void => {
        if (settled) { setRecordNotice(error.message); return; }
        settled = true;
        window.clearTimeout(timeout);
        reject(error);
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        let payload: TencentAsrMessage;
        try { payload = JSON.parse(event.data) as TencentAsrMessage; } catch { return; }
        if (payload.code !== undefined && payload.code !== 0) {
          const error = new Error(`腾讯实时语音识别失败：${payload.message || `错误码 ${payload.code}`}`);
          failHandshake(error);
          session.resolveFinal();
          return;
        }
        if (!settled) {
          settled = true;
          window.clearTimeout(timeout);
          resolve();
        }
        if (payload.speaker_context_id?.trim()) {
          session.speakerContextId = payload.speaker_context_id.trim();
          speakerContextIdRef.current = session.speakerContextId;
          void onUpdateRef.current({ speakerContextId: session.speakerContextId });
        }
        if (payload.sentences) applyRecognitionSentences(session, payload.sentences);
        if (payload.final === 1) session.resolveFinal();
      };
      socket.onerror = () => failHandshake(new Error('腾讯实时语音识别网络连接失败'));
      socket.onclose = () => {
        window.clearTimeout(timeout);
        session.resolveFinal();
        if (recognitionRef.current === session) recognitionRef.current = null;
        if (!settled) failHandshake(new Error('腾讯实时语音识别连接已关闭'));
        else if (!session.intentionalClose && phaseRef.current === 'recording') setRecordNotice('实时转写连接已中断，本地录音仍在继续；可暂停后再继续以重新连接。');
      };
    });
  };

  const stopRecognition = async (flushAudio: boolean): Promise<void> => {
    const session = recognitionRef.current;
    recognitionRef.current = null;
    if (!session) return;
    session.intentionalClose = true;
    if (session.socket.readyState === WebSocket.OPEN) {
      const partial = flushAudio ? session.chunker.flush() : null;
      if (partial?.byteLength) session.socket.send(partial);
      session.socket.send(JSON.stringify({ type: 'end' }));
      await Promise.race([
        session.finalPromise,
        new Promise<void>((resolve) => window.setTimeout(resolve, 5_000)),
      ]);
    }
    if (session.socket.readyState === WebSocket.OPEN || session.socket.readyState === WebSocket.CONNECTING) session.socket.close();
  };

  const setupAudioPipeline = async (stream: MediaStream): Promise<void> => {
    const AudioContextConstructor = window.AudioContext
      || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) throw new Error('当前环境不支持实时音频处理');
    const context = new AudioContextConstructor();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2_048, 1, 1);
    const silentGain = context.createGain();
    silentGain.gain.value = 0;
    processor.onaudioprocess = (event) => {
      const session = recognitionRef.current;
      if (!session || phaseRef.current !== 'recording' || session.socket.readyState !== WebSocket.OPEN) return;
      const samples = event.inputBuffer.getChannelData(0);
      for (const chunk of session.chunker.push(samples, context.sampleRate)) session.socket.send(chunk);
    };
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);
    audioContextRef.current = context;
    audioSourceRef.current = source;
    audioProcessorRef.current = processor;
    audioGainRef.current = silentGain;
    if (context.state === 'suspended') await context.resume();
  };

  const destroyAudioPipeline = (): void => {
    audioProcessorRef.current?.disconnect();
    audioSourceRef.current?.disconnect();
    audioGainRef.current?.disconnect();
    audioProcessorRef.current = null;
    audioSourceRef.current = null;
    audioGainRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== 'closed') void context.close();
  };

  const stopStream = (): void => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const saveAudioBlob = async (blob: Blob, fileName: string): Promise<string> => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const saved = await window.kunqing?.meetings.saveRecording({ projectId: meeting.projectId, meetingId: meeting.id, fileName, bytes }) as RpcResult<{ relativePath: string }> | undefined;
    if (!saved?.ok || !saved.data?.relativePath) throw new Error(saved?.error?.message || '会议录音保存失败');
    audioRelativePathRef.current = saved.data.relativePath;
    return saved.data.relativePath;
  };

  const startLive = async (): Promise<void> => {
    if (phase !== 'idle' || meeting.status === 'ended') return;
    setRecordNotice('');
    changePhase('starting');
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('当前环境不支持麦克风录音');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      streamRef.current = stream;
      await connectRecognition();
      const mimeType = getAudioMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) audioChunksRef.current.push(event.data); };
      mediaRecorderRef.current = recorder;
      recorder.start(1_000);
      changePhase('recording');
      await setupAudioPipeline(stream);
      const nextTranscript = transcriptRef.current.filter((line) => !(line.speaker === '会议智能体' && line.text.startsWith('实时会议记录已准备')));
      transcriptRef.current = nextTranscript;
      setTranscript(nextTranscript);
      await onUpdateRef.current({ status: 'recording', transcript: nextTranscript, durationSeconds: elapsedSecondsRef.current });
    } catch (cause) {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      mediaRecorderRef.current = null;
      await stopRecognition(false);
      destroyAudioPipeline();
      stopStream();
      changePhase('idle');
      setRecordNotice(cause instanceof Error ? cause.message : '无法开始实时会议记录');
    }
  };

  const pauseLive = async (): Promise<void> => {
    if (phase !== 'recording') return;
    setRecordNotice('');
    changePhase('paused');
    const context = audioContextRef.current;
    if (context?.state === 'running') await context.suspend();
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.pause();
    await stopRecognition(true);
    await onUpdateRef.current({ status: 'paused', durationSeconds: elapsedSecondsRef.current, transcript: transcriptRef.current });
  };

  const resumeLive = async (): Promise<void> => {
    if (phase !== 'paused') return;
    setRecordNotice('');
    changePhase('starting');
    try {
      await connectRecognition();
      if (mediaRecorderRef.current?.state === 'paused') mediaRecorderRef.current.resume();
      const context = audioContextRef.current;
      changePhase('recording');
      if (context?.state === 'suspended') await context.resume();
      await onUpdateRef.current({ status: 'recording', durationSeconds: elapsedSecondsRef.current });
    } catch (cause) {
      await stopRecognition(false);
      if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.pause();
      const context = audioContextRef.current;
      if (context?.state === 'running') await context.suspend();
      changePhase('paused');
      setRecordNotice(cause instanceof Error ? cause.message : '无法继续实时会议记录');
    }
  };

  const analyzeSpeakersAfterMeeting = async (identities: MeetingSpeakerIdentity[], lines: MeetingTranscriptLine[]): Promise<void> => {
    setMinutesStatus('analyzing-speakers');
    await onUpdateRef.current({ minutesStatus: 'analyzing-speakers', speakerIdentities: identities });
    if (identities.length === 0) {
      setMinutesStatus('ready');
      setChatMessages((items) => [...items, { id: createId(), role: 'agent', text: '会议已经结束，但没有识别到可确认的说话人。' }]);
      await onUpdateRef.current({ minutesStatus: 'ready' });
      return;
    }
    const response = await window.kunqing?.meetings.analyzeSpeakers({
      meetingName: meeting.name,
      projectName: meeting.projectName,
      knownPeople,
      transcript: lines,
      speakers: identities.map(({ clusterId, label }) => ({ clusterId, label })),
    }) as RpcResult<{ speakers: MeetingSpeakerIdentity[]; question: string; warning?: string }> | undefined;
    const suggestions = response?.ok && Array.isArray(response.data?.speakers) ? response.data.speakers : [];
    const suggestionMap = new Map(suggestions.map((speaker) => [speaker.clusterId, speaker]));
    const nextIdentities = identities.map((identity) => {
      if (identity.status === 'confirmed' || identity.status === 'anonymous') return identity;
      const suggestion = suggestionMap.get(identity.clusterId);
      return suggestion ? { ...identity, ...suggestion, clusterId: identity.clusterId, label: identity.label } : identity;
    });
    const nextStatus: MeetingMinutesStatus = allSpeakersConfirmed(nextIdentities) ? 'ready' : 'awaiting-confirmation';
    speakerIdentitiesRef.current = nextIdentities;
    setSpeakerIdentities(nextIdentities);
    setSpeakerDrafts(Object.fromEntries(nextIdentities.map((speaker) => [speaker.clusterId, speaker.name])));
    setMinutesStatus(nextStatus);
    setChatMessages((items) => [...items, {
      id: createId(),
      role: 'agent',
      text: response?.data?.question || response?.error?.message || '请逐一确认说话人姓名，也可以保留匿名身份。',
    }]);
    await onUpdateRef.current({ speakerIdentities: nextIdentities, minutesStatus: nextStatus });
  };

  const endLive = async (): Promise<void> => {
    if (phase !== 'recording' && phase !== 'paused') return;
    setRecordNotice('');
    const wasRecording = phase === 'recording';
    changePhase('ending');
    let audioFileName = meeting.audioFileName || `${meeting.name}-会议录音.webm`;
    let audioMimeType = meeting.audioMimeType || 'audio/webm';
    let audioSize = meeting.audioSize ?? 0;
    let audioRelativePath = audioRelativePathRef.current || meeting.audioRelativePath || '';
    try {
      const context = audioContextRef.current;
      if (context?.state === 'running') await context.suspend();
      await stopRecognition(wasRecording);
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          recorder.addEventListener('stop', () => resolve(), { once: true });
          recorder.stop();
        });
      }
      audioMimeType = recorder?.mimeType || 'audio/webm';
      const blob = new Blob(audioChunksRef.current, { type: audioMimeType });
      audioBlobRef.current = blob;
      const extension = audioMimeType.includes('ogg') ? 'ogg' : 'webm';
      audioFileName = `${meeting.name}-会议录音.${extension}`;
      audioSize = blob.size;
      try { audioRelativePath = await saveAudioBlob(blob, audioFileName); }
      catch (cause) { setRecordNotice(cause instanceof Error ? `${cause.message}，下载时会重试保存。` : '会议录音保存失败，下载时会重试保存。'); }
    } catch (cause) {
      setRecordNotice(cause instanceof Error ? `会议已结束，但录音整理失败：${cause.message}` : '会议已结束，但录音整理失败。');
    } finally {
      mediaRecorderRef.current = null;
      destroyAudioPipeline();
      stopStream();
    }
    const stableTranscript = transcriptRef.current.filter((line) => line.stable !== false);
    transcriptRef.current = stableTranscript;
    setTranscript(stableTranscript);
    const identities = inferSpeakerIdentities(stableTranscript, speakerIdentitiesRef.current);
    speakerIdentitiesRef.current = identities;
    setSpeakerIdentities(identities);
    changePhase('ended');
    await onUpdateRef.current({
      status: 'ended',
      durationSeconds: elapsedSecondsRef.current,
      transcript: stableTranscript,
      audioFileName,
      audioSize,
      audioMimeType,
      ...(audioRelativePath ? { audioRelativePath } : {}),
      ...(speakerContextIdRef.current ? { speakerContextId: speakerContextIdRef.current } : {}),
      speakerIdentities: identities,
      actions: [],
      summary: '实时记录已结束。确认全部说话人后，会议智能体会生成纪要和待办。',
      minutesStatus: 'analyzing-speakers',
    });
    await analyzeSpeakersAfterMeeting(identities, stableTranscript);
  };

  const downloadMeetingFiles = async (): Promise<void> => {
    if (phase !== 'ended' || exporting) return;
    setExporting(true);
    setRecordNotice('');
    try {
      let audioRelativePath = audioRelativePathRef.current || meeting.audioRelativePath || '';
      const audioFileName = meeting.audioFileName || `${meeting.name}-会议录音.webm`;
      if (!audioRelativePath && audioBlobRef.current) {
        audioRelativePath = await saveAudioBlob(audioBlobRef.current, audioFileName);
        await onUpdateRef.current({ audioRelativePath });
      }
      if (!audioRelativePath) throw new Error('没有可下载的会议录音文件');
      const result = await window.kunqing?.meetings.exportFiles({
        projectId: meeting.projectId,
        meetingId: meeting.id,
        meetingName: meeting.name,
        audioRelativePath,
        audioFileName,
        transcriptText: buildTranscriptText(meeting, resolvedStableTranscript(transcriptRef.current, speakerIdentitiesRef.current), elapsedSecondsRef.current),
      }) as RpcResult<{ cancelled: boolean; directory?: string }> | undefined;
      if (!result?.ok) throw new Error(result?.error?.message || '会议文件下载失败');
      if (!result.data?.cancelled) setRecordNotice('会议音频和转写文本已下载。');
    } catch (cause) {
      setRecordNotice(cause instanceof Error ? cause.message : '会议文件下载失败');
    } finally { setExporting(false); }
  };

  useEffect(() => () => {
    const session = recognitionRef.current;
    if (session) { session.intentionalClose = true; session.socket.close(); }
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    audioProcessorRef.current?.disconnect();
    audioSourceRef.current?.disconnect();
    audioGainRef.current?.disconnect();
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') void audioContextRef.current.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const confirmSpeaker = async (clusterId: string, anonymous = false): Promise<void> => {
    const current = speakerIdentitiesRef.current.find((speaker) => speaker.clusterId === clusterId);
    if (!current) return;
    const name = anonymous ? current.label : (speakerDrafts[clusterId] ?? '').trim();
    if (!name) { setRecordNotice('请输入说话人姓名后再确认。'); return; }
    const next = speakerIdentitiesRef.current.map((speaker) => speaker.clusterId === clusterId ? {
      ...speaker,
      name,
      status: anonymous ? 'anonymous' as const : 'confirmed' as const,
      ...(!anonymous ? { confidence: 1 } : {}),
      reason: anonymous ? '用户选择保留匿名身份' : '用户已确认',
    } : speaker);
    const nextStatus: MeetingMinutesStatus = allSpeakersConfirmed(next) ? 'ready' : 'awaiting-confirmation';
    speakerIdentitiesRef.current = next;
    setSpeakerIdentities(next);
    setMinutesStatus(nextStatus);
    setRecordNotice('');
    await onUpdateRef.current({ speakerIdentities: next, minutesStatus: nextStatus });
  };

  const sendChat = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!message.trim() || chatBusy) return;
    const text = message.trim();
    setMessage('');
    setChatBusy(true);
    setChatMessages((items) => [...items, { id: createId(), role: 'user', text }]);
    const confirmations = [...confirmationMessagesRef.current, text];
    confirmationMessagesRef.current = confirmations;
    setConfirmationMessages(confirmations);
    try {
      let reply = '这条确认已记录。';
      const currentIdentities = speakerIdentitiesRef.current;
      if (phaseRef.current === 'ended' && currentIdentities.length > 0) {
        const response = await window.kunqing?.meetings.refineSpeakers({
          meetingName: meeting.name,
          projectName: meeting.projectName,
          knownPeople,
          transcript: transcriptRef.current,
          speakers: currentIdentities.map(({ clusterId, label }) => ({ clusterId, label })),
          identities: currentIdentities,
          message: text,
        }) as RpcResult<{ speakers: MeetingSpeakerIdentity[]; reply: string; warning?: string }> | undefined;
        if (response?.ok && Array.isArray(response.data?.speakers)) {
          const identities = response.data.speakers;
          speakerIdentitiesRef.current = identities;
          setSpeakerIdentities(identities);
          setSpeakerDrafts(Object.fromEntries(identities.map((speaker) => [speaker.clusterId, speaker.name])));
          const nextStatus: MeetingMinutesStatus = allSpeakersConfirmed(identities) ? 'ready' : 'awaiting-confirmation';
          setMinutesStatus(nextStatus);
          reply = response.data.reply || reply;
          await onUpdateRef.current({ speakerIdentities: identities, confirmationMessages: confirmations, minutesStatus: nextStatus });
        } else {
          reply = response?.error?.message || '这条补充已记录。请直接填写姓名并确认。';
          await onUpdateRef.current({ confirmationMessages: confirmations });
        }
      } else {
        await onUpdateRef.current({ confirmationMessages: confirmations });
      }
      void window.kunqing?.meetings.saveSharedKnowledge({
        projectId: meeting.projectId,
        meetingId: meeting.id,
        title: `${meeting.name} · 会议确认`,
        content: `会议智能体与用户确认：${text}`,
      });
      setChatMessages((items) => [...items, { id: createId(), role: 'agent', text: reply }]);
    } finally {
      setChatBusy(false);
    }
  };
  const generateMinutes = async (): Promise<void> => {
    if (generatingMinutes || !allSpeakersConfirmed(speakerIdentitiesRef.current)) return;
    const lines = resolvedStableTranscript(transcriptRef.current, speakerIdentitiesRef.current);
    if (!lines.length) { setRecordNotice('没有可用于生成纪要的稳定转写内容。'); return; }
    setGeneratingMinutes(true);
    setMinutesStatus('generating');
    setRecordNotice('');
    await onUpdateRef.current({ minutesStatus: 'generating' });
    try {
      const response = await window.kunqing?.meetings.generateMinutes({
        meetingName: meeting.name,
        projectName: meeting.projectName,
        transcript: lines,
        speakers: speakerIdentitiesRef.current,
        confirmations: confirmationMessagesRef.current,
      }) as RpcResult<{ summary: string; conclusions: string[]; actions: Array<{ title: string; owner: string; due: string }> }> | undefined;
      if (!response?.ok || !response.data?.summary) throw new Error(response?.error?.message || '会议纪要生成失败');
      const actions = (response.data.actions ?? []).map((action) => ({ ...action, id: createId(), done: false }));
      const conclusions = response.data.conclusions ?? [];
      setMinutesStatus('completed');
      await onUpdateRef.current({ summary: response.data.summary, conclusions, actions, minutesStatus: 'completed' });
      const knowledge = ['## 会议摘要', response.data.summary, '', '## 已确认说话人', ...speakerIdentitiesRef.current.map((speaker) => `- ${speaker.label}：${speaker.status === 'anonymous' ? speaker.label : speaker.name}`), '', '## 会议结论', ...conclusions.map((item) => `- ${item}`), '', '## 会议待办', ...actions.map((item) => `- ${item.title}｜负责人：${item.owner}｜时间：${item.due}`)].join('\n');
      void window.kunqing?.meetings.saveSharedKnowledge({ projectId: meeting.projectId, meetingId: meeting.id, title: `${meeting.name} · 会议纪要`, content: knowledge });
      setChatMessages((items) => [...items, { id: createId(), role: 'agent', text: '说话人已全部确认，会议纪要和待办已经生成并保存到项目共享区。' }]);
    } catch (cause) {
      setMinutesStatus('failed');
      setRecordNotice(cause instanceof Error ? cause.message : '会议纪要生成失败');
      await onUpdateRef.current({ minutesStatus: 'failed' });
    } finally {
      setGeneratingMinutes(false);
    }
  };

  const exportMinutes = (): void => {
    const lines = resolvedStableTranscript(transcript, speakerIdentities);
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(meeting.name)} - 会议纪要</title><style>body{font-family:Arial,sans-serif;max-width:900px;margin:40px auto;line-height:1.7;color:#172026}h1{color:#16865d}li{margin:8px 0}</style><h1>${escapeHtml(meeting.name)}</h1><p>${escapeHtml(meeting.description || '会议纪要')}</p><h2>摘要</h2><p>${escapeHtml(meeting.summary)}</p><h2>会议结论</h2><ul>${(meeting.conclusions ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul><h2>会议记录</h2><ul>${lines.map((line) => `<li><b>${escapeHtml(line.speaker)}</b>：${escapeHtml(line.text)}</li>`).join('')}</ul><h2>会议待办</h2><ul>${meeting.actions.map((item) => `<li>${item.done ? '已完成' : '待处理'} · ${escapeHtml(item.title)}（${escapeHtml(item.owner)} · ${escapeHtml(item.due)}）</li>`).join('')}</ul></html>`;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${meeting.name}-会议纪要.html`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const duration = formatMeetingDuration(elapsedSeconds);
  const isBusy = phase === 'starting' || phase === 'ending';
  const detailStatus = meeting.status === 'processing'
    ? <><Loader2 size={15} className="spin" />转写处理中</>
    : meeting.kind !== 'realtime'
      ? <><Check size={15} />记录已就绪</>
      : phase === 'recording'
        ? <><i className="meeting-live-dot" />正在记录 <b>{duration}</b></>
        : phase === 'paused'
          ? <><Pause size={14} />已暂停 <b>{duration}</b></>
          : phase === 'ended'
            ? <><Check size={15} />记录已结束 <b>{duration}</b></>
            : isBusy
              ? <><Loader2 size={15} className="spin" />{phase === 'starting' ? '正在连接' : '正在结束'}</>
              : <><Mic size={15} />等待开始 <b>{duration}</b></>;
  const displayTranscript = resolvedTranscript(transcript, speakerIdentities);
  const meetingForMinutes = { ...meeting, transcript: displayTranscript, speakerIdentities, minutesStatus, durationSeconds: elapsedSeconds };
  return <div className="meeting-detail">
    <header className="meeting-detail-header">
      <div><span className="meeting-detail-eyebrow"><span className="meeting-project-label"><Folder size={13} />{meeting.projectName}</span><i>·</i>会议智能体</span><h1>{meeting.name}</h1><p>{meeting.description || '会议内容、转写和纪要都会保存在本地工作区。'}</p></div>
      <div className={`meeting-detail-status${phase === 'recording' ? ' meeting-detail-status--live' : ''}${phase === 'paused' ? ' meeting-detail-status--paused' : ''}`}>{detailStatus}</div>
    </header>
    <nav className="meeting-tabs"><button type="button" className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}><FileText size={15} />会议语音转写</button><button type="button" className={tab === 'minutes' ? 'active' : ''} onClick={() => setTab('minutes')}><CalendarDays size={15} />会议纪要</button><button type="button" className={tab === 'presentation' ? 'active' : ''} onClick={() => setTab('presentation')}><FileCode2 size={15} />会议演讲</button></nav>
    <div className={`meeting-detail-body${tab === 'presentation' ? ' meeting-detail-body--presentation' : ''}`}><section className="meeting-detail-primary">{tab === 'transcript' ? <>
      <div className="meeting-section-heading"><div><h2>完整会议记录</h2><p>{meeting.kind === 'upload' ? '录音文件转写结果' : '腾讯实时语音识别 V2 · 声纹聚类'}</p></div>{meeting.kind === 'realtime' && <div className="meeting-record-controls">
        {phase === 'idle' && <button type="button" className="primary-button" onClick={() => void startLive()}><Mic size={15} />开始记录</button>}
        {phase === 'recording' && <><button type="button" className="secondary-button" onClick={() => void pauseLive()}><Pause size={15} />暂停记录</button><button type="button" className="danger-button" onClick={() => void endLive()}><Square size={15} />结束记录</button></>}
        {phase === 'paused' && <><button type="button" className="primary-button" onClick={() => void resumeLive()}><Play size={15} />继续记录</button><button type="button" className="danger-button" onClick={() => void endLive()}><Square size={15} />结束记录</button></>}
        {isBusy && <button type="button" className="secondary-button" disabled><Loader2 size={15} className="spin" />{phase === 'starting' ? '正在连接' : '正在结束'}</button>}
        {phase === 'ended' && <button type="button" className="secondary-button" disabled={exporting} onClick={() => void downloadMeetingFiles()}>{exporting ? <Loader2 size={15} className="spin" /> : <Download size={15} />}{exporting ? '正在下载' : '下载会议文件'}</button>}
      </div>}</div>
      {recordNotice && <div className="meeting-record-notice" role="status">{recordNotice}</div>}
      <div className="meeting-transcript">{meeting.status === 'processing' ? <div className="meeting-processing"><Loader2 size={20} className="spin" /><strong>正在转写录音...</strong><span>完成后会自动整理摘要和待办</span></div> : displayTranscript.length === 0 ? <div className="meeting-transcript-empty">会议开始后，实时转写内容会显示在这里。</div> : displayTranscript.map((line) => <article className={line.stable === false ? 'meeting-transcript-line--partial' : ''} key={line.id}><span className="meeting-speaker-avatar">{line.speaker.slice(0, 1)}</span><div><header><strong>{line.speaker}</strong>{line.stable === false && <small>识别中</small>}<time>{formatTime(line.at)}</time></header><p>{line.text}</p></div></article>)}</div>
      {phase === 'ended' && <SpeakerConfirmationPanel identities={speakerIdentities} drafts={speakerDrafts} status={minutesStatus} onDraft={(clusterId, value) => setSpeakerDrafts((current) => ({ ...current, [clusterId]: value }))} onConfirm={(clusterId) => void confirmSpeaker(clusterId)} onAnonymous={(clusterId) => void confirmSpeaker(clusterId, true)} />}
      <div className="meeting-summary-card"><header><MessageCircle size={16} /><strong>会议智能体摘要</strong></header><p>{meeting.summary}</p></div>
    </> : tab === 'minutes' ? <MinutesView meeting={meetingForMinutes} speakerDrafts={speakerDrafts} generating={generatingMinutes} onDraft={(clusterId, value) => setSpeakerDrafts((current) => ({ ...current, [clusterId]: value }))} onConfirm={(clusterId) => void confirmSpeaker(clusterId)} onAnonymous={(clusterId) => void confirmSpeaker(clusterId, true)} onGenerate={() => void generateMinutes()} onExport={exportMinutes} /> : <MeetingPresentationWorkspace meeting={meeting} onPresent={onPresent} />}</section>
      {tab !== 'presentation' && <MeetingChat messages={chatMessages} value={message} busy={chatBusy} onChange={setMessage} onSubmit={sendChat} />}
    </div>
  </div>;
}

function MeetingChat({ messages, value, busy, onChange, onSubmit }: { messages: Array<{ id: string; role: 'agent' | 'user'; text: string }>; value: string; busy: boolean; onChange: (value: string) => void; onSubmit: (event: FormEvent) => Promise<void> }): React.JSX.Element {
  return <aside className="meeting-chat"><header><div><MessageCircle size={16} /><strong>会议智能体</strong></div><small>{busy ? '正在分析' : '确认与补充'}</small></header><div className="meeting-chat-body">{messages.map((item) => <article className={`meeting-chat-message meeting-chat-message--${item.role}`} key={item.id}><span>{item.role === 'agent' ? <Users size={13} /> : '我'}</span><p>{item.text}</p></article>)}</div><form onSubmit={(event) => void onSubmit(event)}><input value={value} disabled={busy} onChange={(event) => onChange(event.target.value)} placeholder="补充说话人或会议事项" /><button type="submit" className="icon-button" aria-label="发送" disabled={busy || !value.trim()}>{busy ? <Loader2 size={16} className="spin" /> : <Send size={16} />}</button></form></aside>;
}

function SpeakerConfirmationPanel({ identities, drafts, status, onDraft, onConfirm, onAnonymous }: {
  identities: MeetingSpeakerIdentity[];
  drafts: Record<string, string>;
  status: MeetingMinutesStatus;
  onDraft: (clusterId: string, value: string) => void;
  onConfirm: (clusterId: string) => void;
  onAnonymous: (clusterId: string) => void;
}): React.JSX.Element {
  const confirmedCount = identities.filter((speaker) => speaker.status === 'confirmed' || speaker.status === 'anonymous').length;
  return <section className="meeting-speaker-confirmation">
    <header><div><Users size={16} /><strong>说话人确认</strong></div><small>{confirmedCount} / {identities.length}</small></header>
    {status === 'analyzing-speakers' ? <div className="meeting-speaker-loading"><Loader2 size={17} className="spin" />正在结合称呼和上下文分析人员姓名...</div>
      : identities.length === 0 ? <div className="meeting-speaker-loading">没有识别到说话人</div>
        : <div className="meeting-speaker-list">{identities.map((speaker) => {
          const confirmed = speaker.status === 'confirmed' || speaker.status === 'anonymous';
          return <article key={speaker.clusterId} className={confirmed ? 'confirmed' : ''}>
            <div className="meeting-speaker-row"><span>{speaker.label.slice(-1)}</span><div><strong>{speaker.label}</strong>{speaker.reason && <small>{speaker.reason}</small>}</div>{confirmed && <Check size={15} />}</div>
            <div className="meeting-speaker-fields"><input aria-label={`${speaker.label}姓名`} value={drafts[speaker.clusterId] ?? speaker.name} disabled={speaker.status === 'anonymous'} onChange={(event) => onDraft(speaker.clusterId, event.target.value)} /><button type="button" className="secondary-button" onClick={() => onConfirm(speaker.clusterId)}>确认</button><button type="button" className="secondary-button" onClick={() => onAnonymous(speaker.clusterId)}>保留匿名</button></div>
          </article>;
        })}</div>}
  </section>;
}

function MinutesView({ meeting, speakerDrafts, generating, onDraft, onConfirm, onAnonymous, onGenerate, onExport }: {
  meeting: Meeting;
  speakerDrafts: Record<string, string>;
  generating: boolean;
  onDraft: (clusterId: string, value: string) => void;
  onConfirm: (clusterId: string) => void;
  onAnonymous: (clusterId: string) => void;
  onGenerate: () => void;
  onExport: () => void;
}): React.JSX.Element {
  const identities = meeting.speakerIdentities ?? [];
  const status = meeting.minutesStatus ?? 'not-started';
  const completed = status === 'completed' || (meeting.kind === 'upload' && meeting.status === 'ready');
  const canGenerate = meeting.transcript.length > 0 && allSpeakersConfirmed(identities) && !generating;
  return <>
    <div className="meeting-section-heading"><div><h2>会议纪要</h2><p>{completed ? '会议摘要、结论和待办' : '说话人确认完成后生成'}</p></div>{completed ? <button type="button" className="secondary-button" onClick={onExport}><Download size={15} />导出 HTML</button> : <button type="button" className="primary-button" disabled={!canGenerate} onClick={onGenerate}>{generating ? <Loader2 size={15} className="spin" /> : <FileText size={15} />}{generating ? '正在生成' : '生成纪要和待办'}</button>}</div>
    {!completed && <SpeakerConfirmationPanel identities={identities} drafts={speakerDrafts} status={status} onDraft={onDraft} onConfirm={onConfirm} onAnonymous={onAnonymous} />}
    {completed && <article className="meeting-minutes-document"><h3>会议摘要</h3><p>{meeting.summary}</p><h3>会议结论</h3>{meeting.conclusions?.length ? <ul className="meeting-conclusion-list">{meeting.conclusions.map((item) => <li key={item}>{item}</li>)}</ul> : <div className="meeting-no-actions">没有形成明确结论</div>}<h3>会议待办</h3>{meeting.actions.length ? <ul>{meeting.actions.map((item) => <li key={item.id}><span className={item.done ? 'done' : ''}>{item.done ? '已完成' : '待处理'}</span><strong>{item.title}</strong><small>{item.owner} · {item.due}</small></li>)}</ul> : <div className="meeting-no-actions">没有识别到明确待办</div>}<h3>关联知识</h3><p className="meeting-knowledge-hint">会议纪要已沉淀到“{meeting.projectName}”的项目共享知识中。</p></article>}
  </>;
}
