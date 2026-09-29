import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeetingsPage } from './MeetingsPage';

const pptxPreviewMock = vi.hoisted(() => {
  const previewer = {
    preview: vi.fn().mockResolvedValue(undefined),
    renderNextSlide: vi.fn(),
    renderPreSlide: vi.fn(),
    updatePagination: vi.fn(),
    destroy: vi.fn(),
  };
  return {
    init: vi.fn((host: HTMLElement) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'pptx-preview-wrapper';
      host.append(wrapper);
      return previewer;
    }),
    previewer,
  };
});

vi.mock('pptx-preview', () => ({ init: pptxPreviewMock.init }));

const meeting = {
  id: 'meeting-1',
  name: '版本发布会',
  description: '确认产品路线图',
  kind: 'realtime',
  projectId: 'enterprise-project-1',
  projectName: '产品平台项目',
  status: 'ready',
  createdAt: '2026-08-26T08:00:00.000Z',
  transcript: [],
  summary: '待开始',
  actions: [],
  speakerHints: [],
  updatedAt: '2026-08-26T08:00:00.000Z',
};

afterEach(() => {
  Object.defineProperty(window, 'kunqing', { configurable: true, value: undefined });
  Reflect.deleteProperty(navigator, 'mediaDevices');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('meeting project presentation', () => {
  it('presents HTML and PPTX files in native fullscreen and exits with Escape', async () => {
    const ensureEnterpriseProject = vi.fn().mockResolvedValue({ ok: true });
    const setFullscreen = vi.fn().mockResolvedValue({ ok: true });
    let presentationKeyHandler: ((key: 'ArrowUp' | 'ArrowDown') => void) | undefined;
    const onPresentationKey = vi.fn((handler: (key: 'ArrowUp' | 'ArrowDown') => void) => {
      presentationKeyHandler = handler;
      return vi.fn();
    });
    const listSystemDirs = vi.fn().mockResolvedValue({
      ok: true,
      data: [{
        name: '成果', relativePath: 'outputs', physicalName: 'outputs', kind: 'directory', system: true,
        size: 0, modifiedAt: '2026-08-26T08:00:00.000Z',
      }],
    });
    const listProjectDir = vi.fn().mockResolvedValue({
      ok: true,
      data: [
        {
          name: 'roadmap.html', relativePath: 'outputs/roadmap.html', kind: 'file',
          size: 1024, modifiedAt: '2026-08-26T08:00:00.000Z',
        },
        {
          name: 'speaker-notes.md', relativePath: 'outputs/speaker-notes.md', kind: 'file',
          size: 512, modifiedAt: '2026-08-26T08:00:00.000Z',
        },
        {
          name: 'release-deck.pptx', relativePath: 'outputs/release-deck.pptx', kind: 'file',
          size: 2048, modifiedAt: '2026-08-26T08:00:00.000Z',
        },
      ],
    });
    const getPreview = vi.fn().mockImplementation(({ relativePath }: { relativePath: string }) => Promise.resolve(relativePath.endsWith('.pptx')
      ? { ok: true, data: { kind: 'pptx', bytes: new Uint8Array([80, 75, 3, 4]), fileName: 'release-deck.pptx' } }
      : { ok: true, data: { kind: 'html', content: '<!doctype html><h1>产品路线图</h1>', fileName: 'roadmap.html' } }));

    Object.defineProperty(window, 'kunqing', {
      configurable: true,
      value: {
        app: { setFullscreen, onPresentationKey },
        settings: {
          getAll: vi.fn().mockResolvedValue({
            ok: true,
            data: {
              meetings: [meeting],
              enterpriseProjects: [{ id: meeting.projectId, name: meeting.projectName }],
            },
          }),
          update: vi.fn().mockResolvedValue({ ok: true }),
        },
        workspace: {
          ensureEnterpriseProject,
          listSystemDirs,
          listProjectDir,
          listFiles: vi.fn(),
          getPreview,
        },
      },
    });

    const user = userEvent.setup();
    render(<MeetingsPage />);

    await user.click(await screen.findByRole('button', { name: /版本发布会/ }));
    await user.click(await screen.findByRole('button', { name: '会议演讲' }));
    expect(await screen.findByRole('heading', { name: '项目演示文件' })).toBeInTheDocument();
    await waitFor(() => expect(ensureEnterpriseProject).toHaveBeenCalledWith({ projectId: meeting.projectId, name: meeting.projectName }));
    expect(listSystemDirs).toHaveBeenCalledWith({ projectId: meeting.projectId, scopeType: 'project-shared', scopeId: meeting.projectId, resourceType: 'meeting', resourceId: meeting.id });

    await user.click(await screen.findByRole('button', { name: /成果/ }));
    await waitFor(() => expect(listProjectDir).toHaveBeenCalledWith({ projectId: meeting.projectId, scopeType: 'project-shared', scopeId: meeting.projectId, resourceType: 'meeting', resourceId: meeting.id, relativePath: 'outputs', systemDir: 'outputs' }));
    expect(await screen.findByText('speaker-notes.md')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '演示 speaker-notes.md' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '演示 release-deck.pptx' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '演示 roadmap.html' }));

    const presentation = await screen.findByTestId('meeting-presentation');
    expect(presentation).toBeInTheDocument();
    expect(getPreview).toHaveBeenCalledWith({ projectId: meeting.projectId, relativePath: 'outputs/roadmap.html', scopeType: 'project-shared', scopeId: meeting.projectId, resourceType: 'meeting', resourceId: meeting.id });
    expect(setFullscreen).toHaveBeenCalledWith({ enabled: true, presentationType: 'html' });

    const htmlFrame = screen.getByTitle('会议演示：roadmap.html') as HTMLIFrameElement;
    const scrollBy = vi.fn();
    Object.defineProperty(htmlFrame.contentWindow, 'scrollBy', { configurable: true, value: scrollBy });
    fireEvent.load(htmlFrame);
    fireEvent.keyDown(htmlFrame.contentWindow!, { key: 'ArrowDown' });
    expect(scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ top: expect.any(Number) }));
    expect(scrollBy.mock.calls.at(-1)?.[0].top).toBeGreaterThan(0);
    fireEvent.keyDown(htmlFrame.contentWindow!, { key: 'ArrowUp' });
    expect(scrollBy.mock.calls.at(-1)?.[0].top).toBeLessThan(0);

    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('meeting-presentation')).not.toBeInTheDocument();
    expect(setFullscreen).toHaveBeenCalledWith({ enabled: false });

    await user.click(screen.getByRole('button', { name: '演示 release-deck.pptx' }));
    expect(await screen.findByLabelText('PPTX 演示：release-deck.pptx')).toBeInTheDocument();
    await waitFor(() => expect(pptxPreviewMock.previewer.preview).toHaveBeenCalledWith(expect.any(ArrayBuffer)));
    expect(pptxPreviewMock.previewer.updatePagination).toHaveBeenCalled();
    expect(getPreview).toHaveBeenCalledWith({ projectId: meeting.projectId, relativePath: 'outputs/release-deck.pptx', scopeType: 'project-shared', scopeId: meeting.projectId, resourceType: 'meeting', resourceId: meeting.id });
    expect(setFullscreen).toHaveBeenCalledWith({ enabled: true, presentationType: 'pptx' });
    expect(onPresentationKey).toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown' });
    expect(pptxPreviewMock.previewer.renderNextSlide).toHaveBeenCalledOnce();
    // The main-process fallback sends the same physical key over IPC; it must not advance twice.
    act(() => presentationKeyHandler?.('ArrowDown'));
    expect(pptxPreviewMock.previewer.renderNextSlide).toHaveBeenCalledOnce();
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 100);
    act(() => presentationKeyHandler?.('ArrowUp'));
    expect(pptxPreviewMock.previewer.renderPreSlide).toHaveBeenCalledOnce();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('meeting-presentation')).not.toBeInTheDocument();
    expect(pptxPreviewMock.previewer.destroy).toHaveBeenCalled();
    expect(document.querySelectorAll('.pptx-preview-wrapper')).toHaveLength(0);
  });
});

describe('real-time meeting recording', () => {
  it('records, pauses, resumes, ends once, and exports audio with transcript', async () => {
    const sockets: MockWebSocket[] = [];
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      readonly url: string;
      readyState = MockWebSocket.OPEN;
      sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;

      constructor(url: string) {
        this.url = url;
        sockets.push(this);
        queueMicrotask(() => this.emit({ code: 0, message: 'success' }));
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        this.sent.push(data);
        if (typeof data === 'string' && data.includes('"type":"end"')) queueMicrotask(() => this.emit({ code: 0, final: 1 }));
      }

      close(): void {
        this.readyState = 3;
        this.onclose?.();
      }

      emit(payload: unknown): void {
        this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
      }
    }

    class MockMediaRecorder extends EventTarget {
      static isTypeSupported(): boolean { return true; }
      state: RecordingState = 'inactive';
      readonly mimeType = 'audio/webm;codecs=opus';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      start(): void { this.state = 'recording'; }
      pause(): void { this.state = 'paused'; }
      resume(): void { this.state = 'recording'; }
      stop(): void {
        this.ondataavailable?.({ data: new Blob(['recorded-audio'], { type: this.mimeType }) } as BlobEvent);
        this.state = 'inactive';
        this.dispatchEvent(new Event('stop'));
      }
    }

    const audioNode = { connect: vi.fn(), disconnect: vi.fn() };
    class MockAudioContext {
      sampleRate = 16_000;
      state: AudioContextState = 'running';
      destination = audioNode;
      createMediaStreamSource(): MediaStreamAudioSourceNode { return { ...audioNode } as unknown as MediaStreamAudioSourceNode; }
      createScriptProcessor(): ScriptProcessorNode { return { ...audioNode, onaudioprocess: null } as unknown as ScriptProcessorNode; }
      createGain(): GainNode { return { ...audioNode, gain: { value: 1 } } as unknown as GainNode; }
      async suspend(): Promise<void> { this.state = 'suspended'; }
      async resume(): Promise<void> { this.state = 'running'; }
      async close(): Promise<void> { this.state = 'closed'; }
    }

    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);
    vi.stubGlobal('AudioContext', MockAudioContext);

    const saveRecording = vi.fn().mockResolvedValue({ ok: true, data: { relativePath: 'meetings/recordings/meeting-1-audio.webm' } });
    const exportFiles = vi.fn().mockResolvedValue({ ok: true, data: { cancelled: false, directory: 'D:/meetings/版本发布会-会议文件' } });
    const getRealtimeRecognitionUrl = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { url: 'wss://asr.example/first', voiceId: 'voice-1', engineModelType: '16k_zh_en_speaker_2.0' } })
      .mockResolvedValueOnce({ ok: true, data: { url: 'wss://asr.example/second', voiceId: 'voice-2', engineModelType: '16k_zh_en_speaker_2.0' } });
    const analyzeSpeakers = vi.fn().mockResolvedValue({ ok: true, data: {
      speakers: [{ clusterId: 'context-1:0', label: '说话人1', name: '张三', status: 'suggested', confidence: 0.82, reason: '会议中有人称呼张三' }],
      question: '请确认说话人1是否为张三。',
    } });
    const generateMinutes = vi.fn().mockResolvedValue({ ok: true, data: {
      summary: '会议确认了产品发布计划。',
      conclusions: ['按计划发布产品'],
      actions: [{ title: '完成发布检查', owner: '张三', due: '待确认' }],
    } });
    Object.defineProperty(window, 'kunqing', {
      configurable: true,
      value: {
        settings: {
          getAll: vi.fn().mockResolvedValue({ ok: true, data: { meetings: [meeting], enterpriseProjects: [{ id: meeting.projectId, name: meeting.projectName }] } }),
          update: vi.fn().mockResolvedValue({ ok: true }),
        },
        workspace: {
          ensureProject: vi.fn().mockResolvedValue({ ok: true }),
          listSystemDirs: vi.fn().mockResolvedValue({ ok: true, data: [] }),
          listProjectDir: vi.fn().mockResolvedValue({ ok: true, data: [] }),
          listFiles: vi.fn().mockResolvedValue({ ok: true, data: [] }),
          getPreview: vi.fn(),
        },
        meetings: {
          getRealtimeRecognitionUrl,
          analyzeSpeakers,
          refineSpeakers: vi.fn(),
          generateMinutes,
          saveRecording,
          exportFiles,
          saveSharedKnowledge: vi.fn(),
        },
      },
    });

    const user = userEvent.setup();
    render(<MeetingsPage />);
    await user.click(await screen.findByRole('button', { name: /版本发布会/ }));

    await user.click(screen.getByRole('button', { name: '开始记录' }));
    expect(await screen.findByRole('button', { name: '暂停记录' })).toBeInTheDocument();
    expect(screen.getByText(/正在记录/)).toHaveTextContent('00:00');

    expect(sockets[0]!.onmessage).toBeTypeOf('function');
    await act(async () => {
      sockets[0]!.emit({ code: 0, speaker_context_id: 'context-1' });
      sockets[0]!.emit({ code: 0, sentences: { sentence_list: [
        { sentence: '确认产品发布', sentence_type: 0, sentence_id: 0, speaker_id: -1, start_time: 0, end_time: 800 },
      ] } });
      await Promise.resolve();
    });
    expect(await screen.findByText('说话人识别中')).toBeInTheDocument();
    await act(async () => {
      sockets[0]!.emit({ code: 0, sentences: { sentence_list: [
        { sentence: '确认产品发布计划。', sentence_type: 1, sentence_id: 0, speaker_id: 0, start_time: 0, end_time: 1200 },
      ] } });
      await Promise.resolve();
    });
    expect(await screen.findByText('确认产品发布计划。')).toBeInTheDocument();
    expect(screen.queryByText('确认产品发布')).not.toBeInTheDocument();
    expect(await screen.findByText('说话人1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '暂停记录' }));
    expect(await screen.findByRole('button', { name: '继续记录' })).toBeInTheDocument();
    expect(screen.getByText(/已暂停/)).toHaveTextContent('00:00');

    await user.click(screen.getByRole('button', { name: '继续记录' }));
    expect(await screen.findByRole('button', { name: '暂停记录' })).toBeInTheDocument();
    expect(sockets).toHaveLength(2);
    expect(getRealtimeRecognitionUrl).toHaveBeenNthCalledWith(2, { speakerContextId: 'context-1' });

    await user.click(screen.getByRole('button', { name: '结束记录' }));
    expect(await screen.findByRole('button', { name: '下载会议文件' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始记录' })).not.toBeInTheDocument();
    expect(saveRecording).toHaveBeenCalledWith(expect.objectContaining({
      projectId: meeting.projectId,
      meetingId: meeting.id,
      bytes: expect.any(Uint8Array),
    }));

    await user.click(screen.getByRole('button', { name: '会议纪要' }));
    const generateButton = await screen.findByRole('button', { name: '生成纪要和待办' });
    expect(generateButton).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '说话人1姓名' })).toHaveValue('张三');
    await user.click(screen.getByRole('button', { name: '确认' }));
    expect(screen.getByRole('button', { name: '生成纪要和待办' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '生成纪要和待办' }));
    expect(await screen.findByText('会议确认了产品发布计划。')).toBeInTheDocument();
    expect(generateMinutes).toHaveBeenCalledWith(expect.objectContaining({
      speakers: [expect.objectContaining({ name: '张三', status: 'confirmed' })],
    }));

    await user.click(screen.getByRole('button', { name: '会议语音转写' }));
    await user.click(screen.getByRole('button', { name: '下载会议文件' }));
    await waitFor(() => expect(exportFiles).toHaveBeenCalledWith(expect.objectContaining({
      audioRelativePath: 'meetings/recordings/meeting-1-audio.webm',
      transcriptText: expect.stringContaining('确认产品发布计划。'),
    })));
    expect(await screen.findByText('会议音频和转写文本已下载。')).toBeInTheDocument();
  });
});
