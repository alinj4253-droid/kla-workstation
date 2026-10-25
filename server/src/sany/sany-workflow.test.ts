import Fastify from 'fastify';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { MemoryAccountRepository } from '../mock/memory-account-repository.js';
import { CatalogPool } from '../mock/catalog-pool.js';
import { registerSanyRoutes } from './routes.js';
import type { Identity } from '../repositories/types.js';

async function setup() {
  const accounts = new MemoryAccountRepository();
  const { user } = await accounts.register({ email: `sany-${Date.now()}@example.test`, password: 'TestPass2026!', nickname: '三一管理员' });
  const identity = (await accounts.listIdentities(user.id))[0];
  const session = await accounts.createSession(user.id);
  const pool = new CatalogPool(accounts);
  const app = Fastify({ logger: false });
  await registerSanyRoutes(app, {
    pool: pool as unknown as Pool,
    authorize: async (request) => {
      const token = String(request.headers.authorization ?? '').replace('Bearer ', '');
      const found = await accounts.getSession(token);
      if (!found) return null;
      return (await accounts.listIdentities(found.userId)).find(item => item.id === request.headers['x-identity-id']) ?? null;
    },
  });
  const headers = { authorization: `Bearer ${session.accessToken}`, 'x-identity-id': identity.id };
  return { app, accounts, identity, headers };
}

describe('三一规划任务工作流', () => {
  it('bootstrap 初始化项目并回填派发记录', async () => {
    const { app, headers } = await setup();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/sany/bootstrap', headers });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.data.project.name).toContain('三一');
      expect(body.data.tasks).toHaveLength(4);
      expect(body.data.tasks[0].code).toBe('R-01');
      expect(body.data.assignments).toHaveLength(4);
      expect(body.data.assignments[0].status).toBeTruthy();
      expect(body.data.tasks[0].submissions).toBe(0);
      expect(body.data.tasks[0].latestSubmission).toBeNull();
    } finally { await app.close(); }
  });

  it('派发任务 → 提交成果 → 通过 → 收束 全流程真实落库', async () => {
    const { app, headers } = await setup();
    try {
      await app.inject({ method: 'GET', url: '/api/v1/sany/bootstrap', headers });

      const assign = await app.inject({ method: 'POST', url: '/api/v1/sany/tasks', headers, payload: {
        title: '测试单元 2027—2029 规划',
        intent: '验证派发与收束链路',
        deadline: '2026-12-31',
        planningPeriod: '2027—2029',
        owners: [{ name: '李 伟', unit: '智能家居业务单元', note: '个别要求测试' }],
        requirements: ['上传经营数据'],
      } });
      expect(assign.statusCode).toBe(201);
      expect(assign.json().data.created).toBe(1);

      const boot = await app.inject({ method: 'GET', url: '/api/v1/sany/bootstrap', headers });
      const tasks = boot.json().data.tasks;
      const created = tasks.find((task: { title: string }) => task.title === '测试单元 2027—2029 规划');
      expect(created).toBeTruthy();
      expect(created.status).toBe('待上传');
      expect(created.submissions).toBe(0);
      const assignments = boot.json().data.assignments.filter((item: { taskId: string }) => item.taskId === created.id);
      expect(assignments).toHaveLength(1);
      expect(assignments[0].individualNote).toBe('个别要求测试');

      const submit = await app.inject({ method: 'POST', url: `/api/v1/sany/tasks/${created.id}/submissions`, headers, payload: {
        summary: '提交包 V1 + 诊断 + 3 份材料',
        deliverables: [{ name: '提交包 V1', kind: 'package' }, { name: '正文 V1', kind: 'doc' }],
      } });
      expect(submit.statusCode).toBe(201);
      expect(submit.json().data.no).toBe(1);
      expect(submit.json().data.status).toBe('submitted');

      const afterSubmit = await app.inject({ method: 'GET', url: '/api/v1/sany/bootstrap', headers });
      const submittedTask = afterSubmit.json().data.tasks.find((task: { id: string }) => task.id === created.id);
      expect(submittedTask.status).toBe('已提交');
      expect(submittedTask.submissions).toBe(1);
      expect(submittedTask.latestSubmission?.status).toBe('submitted');

      const workflow = await app.inject({ method: 'GET', url: `/api/v1/sany/tasks/${created.id}/workflow`, headers });
      expect(workflow.statusCode).toBe(200);
      expect(workflow.json().data.submissions).toHaveLength(1);
      expect(workflow.json().data.events.map((event: { eventType: string }) => event.eventType)).toEqual(expect.arrayContaining(['assigned', 'submitted']));

      const accept = await app.inject({ method: 'POST', url: `/api/v1/sany/tasks/${created.id}/closures`, headers, payload: { action: 'accepted', note: '口径已对齐' } });
      expect(accept.statusCode).toBe(200);
      expect(accept.json().data.taskStatus).toBe('已通过');

      const close = await app.inject({ method: 'POST', url: `/api/v1/sany/tasks/${created.id}/closures`, headers, payload: { action: 'closed', note: '正式收束' } });
      expect(close.statusCode).toBe(200);
      expect(close.json().data.taskStatus).toBe('已收束');

      const finalBoot = await app.inject({ method: 'GET', url: '/api/v1/sany/bootstrap', headers });
      const closedTask = finalBoot.json().data.tasks.find((task: { id: string }) => task.id === created.id);
      expect(closedTask.status).toBe('已收束');

      const finalWorkflow = await app.inject({ method: 'GET', url: `/api/v1/sany/tasks/${created.id}/workflow`, headers });
      const closureActions = finalWorkflow.json().data.closures.map((closure: { action: string }) => closure.action);
      expect(closureActions).toEqual(expect.arrayContaining(['accepted', 'closed']));
      expect(closureActions).toHaveLength(2);
      expect(finalWorkflow.json().data.submissions[0].status).toBe('closed');
      expect(finalWorkflow.json().data.events.map((event: { eventType: string }) => event.eventType)).toEqual(expect.arrayContaining(['assigned', 'submitted', 'accepted', 'closed']));

      const resubmit = await app.inject({ method: 'POST', url: `/api/v1/sany/tasks/${created.id}/submissions`, headers, payload: { summary: '收束后再提交' } });
      expect(resubmit.statusCode).toBe(409);
    } finally { await app.close(); }
  });

  it('退回后可重新提交，已确认内容不丢失', async () => {
    const { app, headers } = await setup();
    try {
      await app.inject({ method: 'GET', url: '/api/v1/sany/bootstrap', headers });
      const assign = await app.inject({ method: 'POST', url: '/api/v1/sany/tasks', headers, payload: {
        title: '退回流程测试', intent: 'x', deadline: '2026-12-31',
        owners: [{ name: '陈 刚', unit: '物联平台业务单元' }], requirements: [],
      } });
      expect(assign.statusCode).toBe(201);
      const boot = await app.inject({ method: 'GET', url: '/api/v1/sany/bootstrap', headers });
      const task = boot.json().data.tasks.find((item: { title: string }) => item.title ==='退回流程测试');

      await app.inject({ method: 'POST', url: `/api/v1/sany/tasks/${task.id}/submissions`, headers, payload: { summary: '第一版' } });
      const returned = await app.inject({ method: 'POST', url: `/api/v1/sany/tasks/${task.id}/closures`, headers, payload: { action: 'returned', note: '缺测算材料' } });
      expect(returned.statusCode).toBe(200);
      expect(returned.json().data.taskStatus).toBe('校验中');

      const second = await app.inject({ method: 'POST', url: `/api/v1/sany/tasks/${task.id}/submissions`, headers, payload: { summary: '补充后第二版' } });
      expect(second.statusCode).toBe(201);
      expect(second.json().data.no).toBe(2);

      const workflow = await app.inject({ method: 'GET', url: `/api/v1/sany/tasks/${task.id}/workflow`, headers });
      expect(workflow.json().data.submissions).toHaveLength(2);
      expect(workflow.json().data.submissions[0].status).toBe('returned');
      expect(workflow.json().data.closures.map((closure: { action: string }) => closure.action)).toEqual(expect.arrayContaining(['returned']));
    } finally { await app.close(); }
  });

  it('非项目身份无法访问他人任务', async () => {
    const first = await setup();
    const second = await setup();
    try {
      await first.app.inject({ method: 'GET', url: '/api/v1/sany/bootstrap', headers: first.headers });
      const assign = await first.app.inject({ method: 'POST', url: '/api/v1/sany/tasks', headers: first.headers, payload: {
        title: '隔离测试', intent: 'x', deadline: '2026-12-31',
        owners: [{ name: '赵 敏', unit: '研发中台' }], requirements: [],
      } });
      expect(assign.statusCode).toBe(201);
      const boot = await first.app.inject({ method: 'GET', url: '/api/v1/sany/bootstrap', headers: first.headers });
      const task = boot.json().data.tasks.find((item: { title: string }) => item.title ==='隔离测试');

      const foreign = await second.app.inject({ method: 'GET', url: `/api/v1/sany/tasks/${task.id}/workflow`, headers: second.headers });
      expect(foreign.statusCode).toBe(404);
    } finally { await first.app.close(); await second.app.close(); }
  });

  it('真实文件元数据可登记为材料并支持移除', async () => {
    const { app, headers } = await setup();
    try {
      await app.inject({ method: 'GET', url: '/api/v1/sany/bootstrap', headers });
      const boot = await app.inject({ method: 'GET', url: '/api/v1/sany/bootstrap', headers });
      const task = boot.json().data.tasks.find((item: { code: string }) => item.code === 'R-01');
      const before = boot.json().data.tasks.find((item: { id: string }) => item.id === task.id).docs;

      const add = await app.inject({ method: 'POST', url: '/api/v1/sany/documents', headers, payload: {
        scope: 'unit', moduleKey: 'review', taskId: task.id,
        name: '事业1部-26年业绩.xlsx', ext: 'xlsx', size: '15 KB', color: '#1f7a4d',
        pages: 0, claims: 0, fields: 0,
      } });
      expect(add.statusCode).toBe(201);
      const added = add.json().data;

      const remove = await app.inject({ method: 'DELETE', url: `/api/v1/sany/documents/${added.id}`, headers });
      expect(remove.statusCode).toBe(200);
      const final = await app.inject({ method: 'GET', url: '/api/v1/sany/bootstrap', headers });
      const finalDocs = final.json().data.tasks.find((item: { id: string }) => item.id === task.id).docs;
      expect(finalDocs).toBe(before);
    } finally { await app.close(); }
  });

  it('派发时负责人不在组织中返回 400', async () => {
    const { app, headers } = await setup();
    try {
      await app.inject({ method: 'GET', url: '/api/v1/sany/bootstrap', headers });
      const response = await app.inject({ method: 'POST', url: '/api/v1/sany/tasks', headers, payload: {
        title: '非法负责人', intent: 'x', deadline: '2026-12-31',
        owners: [{ name: '不存在的人', unit: '不存在的单元' }], requirements: [],
      } });
      expect(response.statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
