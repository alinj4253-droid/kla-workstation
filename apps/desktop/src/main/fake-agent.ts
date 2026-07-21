import { BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { MessageRepository } from '@kunqing/database';

interface AgentProfile {
  id: string;
  name: string;
  label: string;
  tone: string;
  replies: readonly string[];
}

const AGENTS: readonly AgentProfile[] = [
  { id: 'builtin.orchestrator', name: '统筹管理智能体', label: 'OR', tone: 'indigo', replies: [
    '收到，我来统筹分析。正在汇总各智能体的初步发现。',
    '根据已有信息，建议重点关注三个方面：财务数据、合规风险和技术方案。',
  ]},
  { id: 'financial-auditor', name: '财务审计师', label: 'FA', tone: 'indigo', replies: [
    '好的，我来检查财务数据。根据最新报表，**应收账款周转率**下降约 **12%**，需要重点关注。',
    '已核对本季度收支明细。有几笔大额支出缺少对应合同编号，建议补充。',
  ]},
  { id: 'legal-compliance', name: '法务合规官', label: 'LC', tone: 'cyan', replies: [
    '已调取相关合规要求。新《公司法》修订可能影响章程条款，建议同步更新。',
    '合同审查中发现条款 #3.7 存在歧义，建议与法务团队重新确认。`参考文档 v2.1`',
  ]},
  { id: 'risk-analyst', name: '风险分析师', label: 'RA', tone: 'violet', replies: [
    '正在搭建风险模型。初步分析显示 **汇率波动风险** 处于中等偏高水平。',
    '@财务审计师 建议联合评估第三季度坏账风险敞口。',
  ]},
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const dispatch = (window: BrowserWindow, event: Record<string, unknown>): void => {
  window.webContents.send('event:dispatch', event);
};

const _runControllers = new Map<string, AbortController>();

export function cancelProjectRuns(projectId: string): void {
  const controller = _runControllers.get(projectId);
  if (controller) { controller.abort(); _runControllers.delete(projectId); }
}

export async function runAgentsForUserMessage(
  db: ReturnType<typeof import('./db').getDatabase>,
  window: BrowserWindow,
  projectId: string,
  contentText: string,
  signal?: AbortSignal,
): Promise<void> {
  const now = new Date().toISOString();
  const targeted = contentText ?? '';
  const subAgents = AGENTS.filter((a) => a.id !== 'builtin.orchestrator');
  const mentioned = subAgents.filter((a) => targeted.includes(`@${a.name}`));
  const participants = mentioned.length > 0 ? mentioned : [AGENTS[0]!];

  for (const agent of participants) {
    if (signal?.aborted) return;
    const userMsgId = `${projectId}-${now}-${agent.id}`;
    const runId = `${userMsgId}-${agent.id}`;

    dispatch(window, {
      type: 'run.status',
      projectId,
      run: { id: runId, agentId: agent.id, status: 'running', message: `${agent.name} 正在处理...` },
    });

    try {
      await sleep(800 + Math.random() * 1500, signal);
    } catch {
      dispatch(window, { type: 'run.status', projectId, run: { id: runId, agentId: agent.id, status: 'cancelled' } });
      return;
    }

    const tokens = pick(agent.replies);
    const chars = tokens.split('');
    const agentMsgId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);

    for (let i = 0, seq = 0; i < chars.length; i += 3, seq++) {
      if (signal?.aborted) {
        dispatch(window, { type: 'run.status', projectId, run: { id: runId, agentId: agent.id, status: 'cancelled' } });
        return;
      }
      try {
        await sleep(40 + Math.random() * 80, signal);
      } catch {
        dispatch(window, { type: 'run.status', projectId, run: { id: runId, agentId: agent.id, status: 'cancelled' } });
        return;
      }
      dispatch(window, {
        type: 'message.delta',
        projectId,
        messageId: agentMsgId,
        seq,
        delta: chars.slice(i, i + 3).join(''),
      });
    }

    const agentContent = { schemaVersion: 1 as const, text: tokens, mentions: [], stagedUploadIds: [] };
    const agentContentJson = JSON.stringify(agentContent);

    db.prepare(
      'INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(agentMsgId, projectId, 'agent', agent.id, 'text', agentContentJson, 'sent', now, now);

    dispatch(window, {
      type: 'run.status',
      projectId,
      run: { id: runId, agentId: agent.id, status: 'completed' },
    });

    dispatch(window, {
      type: 'message.committed',
      projectId,
      messageId: agentMsgId,
      senderId: agent.id,
      content: agentContentJson,
    });
  }
}

export function startFakeAgentSimulator(_db: ReturnType<typeof import('./db').getDatabase>): () => void {
  const messageRepo = new MessageRepository(_db as never);

  const handleMessagesSend = async (_event: Electron.IpcMainInvokeEvent, input: { idempotencyKey: string; projectId: string; content: { text: string } }) => {
    const window = BrowserWindow.fromWebContents(_event.sender);
    if (!window) return { ok: true, data: { id: '', status: 'sent' as const, createdAt: new Date().toISOString() } };

    const now = new Date().toISOString();
    const contentJson = JSON.stringify(input.content);

    const { id: userMessageId } = messageRepo.createUserMessage(input.projectId, contentJson);

    dispatch(window, {
      type: 'message.committed',
      projectId: input.projectId,
      messageId: userMessageId,
      content: contentJson,
    });

    const controller = new AbortController();
    _runControllers.set(input.projectId, controller);
    try {
      await runAgentsForUserMessage(_db, window, input.projectId, input.content.text ?? '', controller.signal);
    } finally {
      if (_runControllers.get(input.projectId) === controller) _runControllers.delete(input.projectId);
    }

    return { ok: true, data: { id: userMessageId, status: 'sent', createdAt: now } };
  };

  ipcMain.handle('messages:send', handleMessagesSend);

  return () => {
    ipcMain.removeHandler('messages:send');
  };
}
