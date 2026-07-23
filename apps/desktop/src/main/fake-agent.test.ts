// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSend = vi.fn();
const mockIpcHandle = vi.fn();

class MockBrowserWindow {
  webContents = { send: mockSend };
  static fromWebContents: ReturnType<typeof vi.fn> = vi.fn();
}

vi.mock('electron', () => ({
  ipcMain: { handle: mockIpcHandle, removeHandler: vi.fn() },
  BrowserWindow: MockBrowserWindow,
}));

interface DbMock {
  prepare: ReturnType<typeof vi.fn>;
}

function makeDb(): DbMock {
  const run = vi.fn();
  const all = vi.fn(() => []);
  return { prepare: vi.fn(() => ({ run, all })) };
}

function getLatestHandler(): (event: unknown, input: { idempotencyKey: string; projectId: string; content: { text: string } }) => Promise<unknown> {
  const calls = mockIpcHandle.mock.calls.filter(([name]: string[]) => name === 'messages:send');
  return calls[calls.length - 1]?.[1] as (...args: unknown[]) => Promise<unknown>;
}

async function waitFor(fn: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(): Promise<{ handler: (event: unknown, input: { idempotencyKey: string; projectId: string; content: { text: string } }) => Promise<unknown>; db: DbMock; window: MockBrowserWindow }> {
  const window = new MockBrowserWindow();
  MockBrowserWindow.fromWebContents = vi.fn(() => window);
  const db = makeDb();
  const { startFakeAgentSimulator } = await import('./fake-agent');
  startFakeAgentSimulator(db as never);
  const handler = getLatestHandler();
  return { handler, db, window };
}

describe('fake agent simulator', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockIpcHandle.mockClear();
  });

  it('registers a messages:send handler on startup', async () => {
    const { handler } = await setup();
    expect(handler).toBeDefined();
    expect(mockIpcHandle).toHaveBeenCalledWith('messages:send', expect.any(Function));
  });

  it('inserts user message into DB and dispatches message.committed', async () => {
    const { handler, db } = await setup();

    const result = await handler({} as unknown, {
      idempotencyKey: 'key-1',
      projectId: 'test-project',
      content: { text: '帮我检查一下数据' },
    });

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO messages'));
    expect(mockSend).toHaveBeenCalledWith('event:dispatch', expect.objectContaining({
      type: 'message.committed',
      projectId: 'test-project',
    }));
    expect(result).toEqual({ ok: true, data: expect.objectContaining({ status: 'sent' }) });
  });

  it('dispatches run.status events for agent processing', async () => {
    const { handler } = await setup();

    const resultPromise = handler({} as unknown, {
      idempotencyKey: 'key-2',
      projectId: 'test-project',
      content: { text: '检查财务报表' },
    });

    await waitFor(() => mockSend.mock.calls.some(
      ([, event]) => (event as Record<string, unknown>).type === 'run.status',
    ));
    expect(mockSend).toHaveBeenCalledWith('event:dispatch', expect.objectContaining({
      type: 'run.status',
      projectId: 'test-project',
      run: expect.objectContaining({ status: 'running' }),
    }));

    await resultPromise;
    expect(mockSend).toHaveBeenCalledWith('event:dispatch', expect.objectContaining({
      type: 'run.status',
      projectId: 'test-project',
      run: expect.objectContaining({ status: 'completed' }),
    }));
  });

  it('streams message.delta events with seq and messageId during agent reply', async () => {
    const { handler } = await setup();

    const resultPromise = handler({} as unknown, {
      idempotencyKey: 'key-3',
      projectId: 'test-project',
      content: { text: '审查合规性' },
    });

    await waitFor(() => mockSend.mock.calls.some(
      ([, event]) => (event as Record<string, unknown>).type === 'message.delta',
    ));

    const deltaCalls = mockSend.mock.calls.filter(
      ([, event]) => (event as Record<string, unknown>).type === 'message.delta',
    );
    expect(deltaCalls.length).toBeGreaterThan(0);
    for (const [, event] of deltaCalls) {
      const e = event as Record<string, unknown>;
      expect(e.type).toBe('message.delta');
      expect(e).toHaveProperty('projectId');
      expect(e).toHaveProperty('messageId');
      expect(e).toHaveProperty('seq');
      expect(e).toHaveProperty('delta');
      expect(typeof e.seq).toBe('number');
    }
    const firstSeq = (deltaCalls[0]?.[1] as Record<string, unknown>).seq as number;
    const lastSeq = (deltaCalls[deltaCalls.length - 1]?.[1] as Record<string, unknown>).seq as number;
    expect(lastSeq).toBeGreaterThanOrEqual(firstSeq);

    await resultPromise;
  });

  it('dispatches message.committed with flat spec format for agent reply', async () => {
    const { handler } = await setup();

    await handler({} as unknown, {
      idempotencyKey: 'key-4',
      projectId: 'test-project',
      content: { text: '做个风险评估' },
    });

    const committed = mockSend.mock.calls.filter(
      ([, event]) => (event as Record<string, unknown>).type === 'message.committed',
    );
    expect(committed.length).toBeGreaterThanOrEqual(2);
    for (const [, event] of committed) {
      expect(event).toMatchObject({
        type: 'message.committed',
        projectId: 'test-project',
      });
      expect(event).toHaveProperty('messageId');
      expect(event).toHaveProperty('content');
    }
  });

  it('only dispatches mentioned agents when @mention is used', async () => {
    const { handler } = await setup();

    await handler({} as unknown, {
      idempotencyKey: 'key-5',
      projectId: 'test-project',
      content: { text: '@法务合规官 请审核合同' },
    });

    const agentIds = mockSend.mock.calls
      .filter(([, event]) => (event as Record<string, unknown>).type === 'run.status' &&
        (event as Record<string, unknown>).run &&
        ((event as Record<string, unknown>).run as Record<string, unknown>).status === 'completed')
      .map(([, event]) => ((event as Record<string, unknown>).run as Record<string, unknown>).agentId as string);

    expect(agentIds).toHaveLength(1);
    expect(agentIds[0]).toBe('legal-compliance');
  });

  it('AC-CHAT-01 no @ triggers exactly one agent', async () => {
    const { handler } = await setup();

    await handler({} as unknown, {
      idempotencyKey: 'chat-01a',
      projectId: 'test-project',
      content: { text: '请审核财务报表' },
    });

    const runStatuses = mockSend.mock.calls
      .filter(([, event]) => (event as Record<string, unknown>).type === 'run.status')
      .map(([, event]) => (event as Record<string, unknown>).run as { agentId: string; status: string });

    const completedIds = runStatuses
      .filter((r) => r.status === 'completed')
      .map((r) => r.agentId);

    expect(completedIds).toEqual(['builtin.orchestrator']);
  });

  it('AC-CHAT-01 direct @ sub-agent does not trigger other agents', async () => {
    const { handler } = await setup();

    await handler({} as unknown, {
      idempotencyKey: 'chat-01b',
      projectId: 'test-project',
      content: { text: '@法务合规官 请审核合同' },
    });

    const runStatuses = mockSend.mock.calls
      .filter(([, event]) => (event as Record<string, unknown>).type === 'run.status')
      .map(([, event]) => (event as Record<string, unknown>).run as { agentId: string; status: string });

    const startedIds = [...new Set(runStatuses
      .filter((r) => r.status === 'running')
      .map((r) => r.agentId))];

    expect(startedIds).toHaveLength(1);
    expect(startedIds[0]).toBe('legal-compliance');
  });

  it('inserts agent messages into DB', async () => {
    const { handler, db } = await setup();

    await handler({} as unknown, {
      idempotencyKey: 'key-6',
      projectId: 'test-project',
      content: { text: '嗨' },
    });

    const insertCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('INSERT INTO messages'),
    );
    expect(insertCalls.length).toBeGreaterThanOrEqual(2);
  });
});
