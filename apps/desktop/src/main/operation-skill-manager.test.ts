import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  WebContentsView: class {},
}));

import { buildBusinessExecutionWorkflow, buildWorkflowFromTrace, operationStepConfirmationPolicy, operationVerificationIndicatesFailure, OperationSkillManager, validateOperationWorkflowStructure } from './operation-skill-manager';
import type { OperationWorkflowPlan } from './operation-skill-manager';
import type { ModelGateway } from './model-gateway';
import { runMigrations } from './db/migrate';
import { closeDatabase } from './db/connection';

describe('operation skill workflow', () => {
  it('builds deterministic steps and parameterizes recorded input', () => {
    const workflow = buildWorkflowFromTrace({
      skillId: 'operation-login', platformId: 'platform-a', ownerAgentId: 'operation-agent-a',
      name: '登录平台', description: '填写账号密码并登录', visionEnabled: false,
      events: [
        { type: 'navigate', timestamp: '2026-01-01T00:00:00.000Z', url: 'https://example.com/login' },
        { type: 'input', timestamp: '2026-01-01T00:00:01.000Z', url: 'https://example.com/login', selectorCandidates: ['#username'], fieldKey: 'username', accessibleName: '用户名' },
        { type: 'input', timestamp: '2026-01-01T00:00:02.000Z', url: 'https://example.com/login', selectorCandidates: ['#password'], fieldKey: 'password', accessibleName: '密码', sensitive: true },
        { type: 'click', timestamp: '2026-01-01T00:00:03.000Z', url: 'https://example.com/login', selectorCandidates: ['button[type="submit"]'], accessibleName: '登录', locator: { text: '登录', role: 'button', tag: 'button' }, screenshotRelPath: '.kstudio/operations/test/screenshots/0004.png' },
      ],
    });

    expect(workflow.allowedDomains).toEqual(['example.com']);
    expect(workflow.steps.map((step) => step.action)).toEqual(['navigate', 'fill', 'fill', 'click']);
    expect(workflow.inputSchema.required).toEqual(['username', 'password']);
    expect(workflow.steps[2]?.value).toBe('{{input.password}}');
    expect(workflow.steps[3]?.locator).toMatchObject({ text: '登录', role: 'button', tag: 'button' });
    expect(workflow.steps[3]?.recordingScreenshotRelPath).toContain('0004.png');
    expect(JSON.stringify(workflow)).not.toContain('真实密码');
    expect(workflow.fallback.strategy).toBe('dom-only');
  });

  it('keeps business nodes independent from DOM steps and rejects positional title drift', () => {
    const plan = {
      goal: '登录平台',
      completionCriteria: ['平台首页已经出现'],
      businessSteps: [
        { id: 'check-session', title: '确认当前登录状态', purpose: '避免重复登录', domStepIndexes: [], verification: 'vision', completionCriteria: ['视觉确认当前是否处于平台首页'] },
        { id: 'open-login', title: '进入并确认登录页', purpose: '准备登录', domStepIndexes: [1], verification: 'dom-and-vision', completionCriteria: ['页面出现账号、密码和登录控件'] },
        { id: 'fill-user', title: '填写用户名', purpose: '填写登录账号', domStepIndexes: [2], verification: 'dom', completionCriteria: ['用户名字段已经填写'] },
        { id: 'fill-password', title: '填写密码', purpose: '填写登录密码', domStepIndexes: [3], verification: 'dom', completionCriteria: ['密码字段已经填写'] },
        { id: 'submit-login', title: '提交登录', purpose: '触发认证', domStepIndexes: [4], verification: 'dom-and-vision', completionCriteria: ['登录请求已提交并发生页面跳转'] },
        { id: 'confirm-home', title: '确认进入平台首页', purpose: '确认登录成功', domStepIndexes: [], verification: 'vision', completionCriteria: ['视觉确认当前已经进入平台首页'] },
      ],
      // Unknown model fields must not leak into the normalized plan.
      steps: [{ title: '错误的模型内部步骤' }],
    } as unknown as OperationWorkflowPlan;
    const workflow = buildWorkflowFromTrace({
      skillId: 'operation-login-business', platformId: 'platform-a', ownerAgentId: 'operation-agent-a',
      name: '登录平台', description: '填写用户名和密码后登录', visionEnabled: true, plan,
      events: [
        { type: 'navigate', timestamp: '2026-01-01T00:00:00.000Z', url: 'https://example.com/login' },
        { type: 'input', timestamp: '2026-01-01T00:00:01.000Z', url: 'https://example.com/login', selectorCandidates: ['#username'], fieldKey: 'username', accessibleName: '用户名' },
        { type: 'input', timestamp: '2026-01-01T00:00:02.000Z', url: 'https://example.com/login', selectorCandidates: ['#password'], fieldKey: 'password', accessibleName: '密码', sensitive: true },
        { type: 'click', timestamp: '2026-01-01T00:00:03.000Z', url: 'https://example.com/login', selectorCandidates: ['button[type="submit"]'], accessibleName: '登录', locator: { text: '登录', role: 'button', tag: 'button' } },
      ],
      stepTitles: ['打开登录页', '输入密码', '点击登录', '填写用户名'],
    });

    expect(workflow.plan?.businessSteps).toHaveLength(6);
    expect(workflow.plan?.businessSteps?.filter((step) => !step.domStepIndexes?.length)).toHaveLength(2);
    expect(workflow.steps.map((step) => step.action)).toEqual(['navigate', 'fill', 'fill', 'click']);
    expect(workflow.steps.map((step) => step.title)).toEqual(['打开登录页', '填写“用户名”', '填写“密码”', '点击“登录”']);
    expect('steps' in (workflow.plan ?? {})).toBe(false);
    expect(validateOperationWorkflowStructure(workflow).valid).toBe(true);
  });

  it('executes only DOM actions referenced by selected business nodes', () => {
    const workflow = buildWorkflowFromTrace({
      skillId: 'operation-business-driven', platformId: 'platform-a', ownerAgentId: 'operation-agent-a',
      name: '提交申请', description: '进入申请页并提交申请', visionEnabled: true,
      plan: {
        goal: '提交申请', completionCriteria: ['提交结果已经出现'],
        businessSteps: [
          { id: 'open-form', title: '进入申请页', domStepIndexes: [1], verification: 'dom', completionCriteria: ['申请页已打开'] },
          { id: 'submit-form', title: '提交申请', domStepIndexes: [3], dependsOn: ['open-form'], verification: 'dom-and-vision', completionCriteria: ['提交结果已出现'] },
        ],
      },
      events: [
        { type: 'navigate', timestamp: '2026-01-01T00:00:00.000Z', url: 'https://example.com/form' },
        { type: 'click', timestamp: '2026-01-01T00:00:01.000Z', url: 'https://example.com/form', text: '录制噪声', locator: { text: '录制噪声', role: 'button', tag: 'button' } },
        { type: 'click', timestamp: '2026-01-01T00:00:03.000Z', url: 'https://example.com/form', text: '提交', locator: { text: '提交', role: 'button', tag: 'button' } },
      ],
    });

    expect(validateOperationWorkflowStructure(workflow).valid).toBe(true);
    const execution = buildBusinessExecutionWorkflow(workflow, ['submit-form']);
    expect(execution.steps.map((step) => step.id)).toEqual(['step-001', 'step-003']);
    expect(execution.steps.map((step) => step.businessStepId)).toEqual(['open-form', 'submit-form']);
    expect(execution.steps.some((step) => step.id === 'step-002')).toBe(false);
  });

  it('collapses delegated DOM events into one business action while retaining the event chain', () => {
    const workflow = buildWorkflowFromTrace({
      skillId: 'operation-delegated-login', platformId: 'platform-a', ownerAgentId: 'operation-agent-a',
      name: '点击登录', description: '点击登录控件并等待表单提交', visionEnabled: true,
      events: [
        { type: 'navigate', timestamp: '2026-01-01T00:00:00.000Z', url: 'https://example.com/login' },
        {
          type: 'click', timestamp: '2026-01-01T00:00:01.000Z', url: 'https://example.com/login',
          nativeEventTrusted: true, text: '登录', locator: { text: '登录', tag: 'div' },
          domSource: { text: '登录', tag: 'div' }, domPath: [{ text: '登录', tag: 'div' }, { text: '登录', role: 'button', tag: 'button' }],
        },
        {
          type: 'click', timestamp: '2026-01-01T00:00:01.120Z', url: 'https://example.com/login',
          nativeEventTrusted: false, accessibleName: '登录', locator: { text: '登录', role: 'button', tag: 'button' },
          domSource: { text: '登录', tag: 'div' }, domPath: [{ text: '登录', tag: 'div' }, { text: '登录', role: 'button', tag: 'button' }],
        },
        {
          type: 'submit', timestamp: '2026-01-01T00:00:01.240Z', url: 'https://example.com/login',
          nativeEventTrusted: false, locator: { role: 'form', tag: 'form' },
        },
      ],
    });

    expect(workflow.steps.map((step) => step.action)).toEqual(['navigate', 'click']);
    const interaction = workflow.steps[1]?.domInteraction;
    expect(interaction?.eventTypes).toEqual(['click', 'submit']);
    expect(interaction?.feedbackTypes).toContain('submit');
    expect(interaction?.source).toMatchObject({ tag: 'div' });
    expect(interaction?.effective).toMatchObject({ role: 'button', tag: 'button' });
    expect(interaction?.propagated?.some((target) => target.tag === 'div')).toBe(true);
    expect(interaction?.propagated?.some((target) => target.tag === 'button')).toBe(true);
  });

  it('treats delegated form submission and its navigations as one recorded login gesture', () => {
    const workflow = buildWorkflowFromTrace({
      skillId: 'operation-form-login', platformId: 'platform-a', ownerAgentId: 'operation-agent-a',
      name: '登录平台', description: '填写账号密码并登录平台', visionEnabled: true,
      events: [
        { type: 'navigate', timestamp: '2026-01-01T00:00:00.000Z', url: 'https://example.com/login' },
        { type: 'click', timestamp: '2026-01-01T00:00:01.000Z', url: 'https://example.com/login', text: '登录', nativeEventTrusted: true, selectorCandidates: ['a > div'], locator: { text: '登录', role: 'div', tag: 'div' }, domPath: [{ text: '登录', tag: 'div' }, { text: '登录', role: 'a', tag: 'a' }] },
        { type: 'click', timestamp: '2026-01-01T00:00:01.006Z', url: 'https://example.com/login', text: '登录', nativeEventTrusted: false, selectorCandidates: ['form'], locator: { text: '登录', role: 'form', tag: 'form' }, domSource: { name: 'btn_submit', tag: 'input' } },
        { type: 'submit', timestamp: '2026-01-01T00:00:01.006Z', url: 'https://example.com/login', text: '登录', nativeEventTrusted: true, selectorCandidates: ['form'], locator: { text: '登录', role: 'form', tag: 'form' } },
        { type: 'navigate', timestamp: '2026-01-01T00:00:01.200Z', url: 'https://example.com/' },
        { type: 'navigate', timestamp: '2026-01-01T00:00:01.300Z', url: 'https://example.com/home' },
      ],
    });

    expect(workflow.steps.map((step) => step.action)).toEqual(['navigate', 'click']);
    expect(workflow.success.finalUrl).toBe('https://example.com/home');
    expect(workflow.steps[1]?.locator).toMatchObject({ tag: 'input', name: 'btn_submit' });
    expect(workflow.steps[1]?.selectorCandidates?.[0]).toBe('input[name="btn_submit"]');
    expect(workflow.steps[1]?.domInteraction?.eventTypes).toEqual(['click', 'submit', 'navigate']);
    expect(workflow.steps[1]?.domInteraction?.effective).toMatchObject({ tag: 'input', name: 'btn_submit' });
    expect(workflow.steps[1]?.domInteraction?.feedbackUrls).toEqual(['https://example.com/', 'https://example.com/home']);
    expect(workflow.plan?.businessSteps?.at(0)).toMatchObject({ id: 'auth-state-check', verification: 'page-state' });
    expect(workflow.plan?.businessSteps?.at(0)?.domStepIndexes).toBeUndefined();
  });

  it('confirms only authentication state and submit boundaries', () => {
    const workflow = buildWorkflowFromTrace({
      skillId: 'operation-fast-login', platformId: 'platform-a', ownerAgentId: 'operation-agent-a',
      name: '登录平台', description: '填写账号密码并登录平台', visionEnabled: true,
      plan: {
        goal: '登录平台', completionCriteria: ['进入平台首页'],
        businessSteps: [
          { id: 'check-session', title: '确认登录状态', domStepIndexes: [], verification: 'page-state', completionCriteria: ['判断是否已经登录'] },
          { id: 'open-login', title: '进入登录页', domStepIndexes: [1], verification: 'dom', completionCriteria: ['登录表单可用'] },
          { id: 'fill-user', title: '填写用户名', domStepIndexes: [2], verification: 'dom', completionCriteria: ['用户名已填写'] },
          { id: 'fill-password', title: '填写密码', domStepIndexes: [3], verification: 'dom', completionCriteria: ['密码已填写'] },
          { id: 'submit-login', title: '提交登录', domStepIndexes: [4], verification: 'dom-and-vision', completionCriteria: ['页面离开登录页'] },
        ],
      },
      events: [
        { type: 'navigate', timestamp: '2026-01-01T00:00:00.000Z', url: 'https://example.com/login' },
        { type: 'input', timestamp: '2026-01-01T00:00:01.000Z', url: 'https://example.com/login', selectorCandidates: ['#username'], fieldKey: 'username', accessibleName: '用户名' },
        { type: 'input', timestamp: '2026-01-01T00:00:02.000Z', url: 'https://example.com/login', selectorCandidates: ['#password'], fieldKey: 'password', accessibleName: '密码', sensitive: true },
        { type: 'click', timestamp: '2026-01-01T00:00:03.000Z', url: 'https://example.com/login', selectorCandidates: ['input[name="btn_submit"]'], accessibleName: '登录', locator: { name: 'btn_submit', tag: 'input', role: 'button' }, domInteraction: { id: 'login-submit', eventTypes: ['click', 'submit'], effective: { name: 'btn_submit', tag: 'input', role: 'button' }, feedbackTypes: ['submit', 'navigate'] } },
      ],
    });
    const execution = buildBusinessExecutionWorkflow(workflow);
    const policies = execution.steps.map((step, index) => operationStepConfirmationPolicy(execution, step, index));

    expect(policies.slice(0, 4)).toEqual([
      { before: false, after: false, reason: 'authentication-state-local' },
      { before: false, after: false, reason: 'authentication-dom-local' },
      { before: false, after: false, reason: 'authentication-dom-local' },
      { before: false, after: false, reason: 'authentication-dom-local' },
    ]);
    expect(policies[4]).toEqual({ before: false, after: true, reason: 'authentication-result' });
  });

  it('infers abstract stages and list/detail branches without fixing the recorded row', () => {
    const workflow = buildWorkflowFromTrace({
      skillId: 'operation-process-query', platformId: 'platform-a', ownerAgentId: 'operation-agent-a',
      name: '流程查询', description: '进入流程列表，根据用户要查询列表、统计或具体详情选择对应路径。', visionEnabled: true,
      events: [
        { type: 'navigate', timestamp: '2026-01-01T00:00:00.000Z', url: 'https://example.com/home' },
        { type: 'click', timestamp: '2026-01-01T00:00:01.000Z', url: 'https://example.com/home', accessibleName: '流程管理', locator: { text: '流程管理', role: 'button', tag: 'button' } },
        { type: 'navigate', timestamp: '2026-01-01T00:00:02.000Z', url: 'https://example.com/processes' },
        { type: 'click', timestamp: '2026-01-01T00:00:03.000Z', url: 'https://example.com/processes', text: '示例流程', locator: { text: '示例流程', role: 'link', tag: 'a' } },
        { type: 'navigate', timestamp: '2026-01-01T00:00:04.000Z', url: 'https://example.com/processes/detail' },
      ],
    });

    expect(workflow.steps.map((step) => step.action)).toEqual(['navigate', 'click', 'click']);
    expect(workflow.plan?.stages?.length).toBeGreaterThan(1);
    expect(workflow.plan?.branches?.map((branch) => branch.id)).toEqual(['collection-result', 'item-detail']);
    expect(workflow.plan?.branches?.[0]?.when).toContain('列表');
    expect(workflow.plan?.branches?.[1]?.targetStepIndex).toBe(3);
    expect(workflow.plan?.branches?.[1]?.stepIndexes).toEqual([1, 2, 3]);
  });

  it('binds a recorded example-row click to the dynamic business node without fixing the row text', () => {
    const workflow = buildWorkflowFromTrace({
      skillId: 'operation-dynamic-record', platformId: 'platform-a', ownerAgentId: 'operation-agent-a',
      name: '流程查询', description: '根据用户当前需求定位列表记录，需要字段不在列表时进入对应详情。录制点击仅为示例。', visionEnabled: true,
      plan: {
        goal: '查询与当前用户目标匹配的流程', completionCriteria: ['页面达到结果位置：https://example.com/home'],
        businessSteps: [
          // Simulate an older learned skill that attached the example-row
          // click to the preceding list node instead of the dynamic node.
          { id: 'open-list', title: '进入流程列表', domStepIndexes: [1, 2, 3], verification: 'dom-and-vision', completionCriteria: ['列表已显示'] },
          { id: 'read-list', title: '读取列表', dependsOn: ['open-list'], kind: 'collection', verification: 'page-state', completionCriteria: ['已读取当前列表字段'] },
          { id: 'open-target', title: '动态定位并打开目标记录', dependsOn: ['read-list'], kind: 'navigation', verification: 'dom-and-vision', completionCriteria: ['已进入本次目标记录'] },
          { id: 'read-detail', title: '读取目标详情', domStepIndexes: [4], dependsOn: ['open-target'], kind: 'detail', verification: 'vision', completionCriteria: ['已读取详情字段'] },
        ],
        branches: [{ id: 'item-detail', when: '所需字段不在列表时', purpose: '动态进入匹配记录', targetStepIndex: 3, stepIndexes: [1, 2, 3] }],
      },
      events: [
        { type: 'navigate', timestamp: '2026-01-01T00:00:00.000Z', url: 'https://example.com/home' },
        { type: 'click', timestamp: '2026-01-01T00:00:01.000Z', url: 'https://example.com/home', accessibleName: '流程管理', locator: { text: '流程管理', role: 'button', tag: 'button' } },
        { type: 'click', timestamp: '2026-01-01T00:00:02.000Z', url: 'https://example.com/processes', text: '示例请假流程', locator: { text: '示例请假流程', role: 'td', tag: 'td' } },
        { type: 'scroll', timestamp: '2026-01-01T00:00:03.000Z', url: 'https://example.com/processes/detail', scrollY: 500 },
      ],
    });

    expect(workflow.plan?.businessSteps?.find((step) => step.id === 'open-target')?.domStepIndexes).toEqual([3]);
    expect(workflow.plan?.businessSteps?.find((step) => step.id === 'open-list')?.domStepIndexes).toEqual([1, 2]);
    expect(workflow.plan?.completionCriteria).toEqual(['已取得足以回答当前用户需求的列表、统计或详情证据']);
    expect(validateOperationWorkflowStructure(workflow).valid).toBe(true);
    const execution = buildBusinessExecutionWorkflow(workflow, ['read-detail']);
    const targetStep = execution.steps.find((step) => step.businessStepId === 'open-target');
    expect(targetStep).toMatchObject({ id: 'step-003', action: 'click', locator: { text: '示例请假流程' } });
  });

  it('defaults a branching list query to the collection path when the planner omits node ids', () => {
    const workflow = buildWorkflowFromTrace({
      skillId: 'operation-default-collection', platformId: 'platform-a', ownerAgentId: 'operation-agent-a',
      name: '流程查询', description: '进入流程列表，按需读取列表或详情。', visionEnabled: true,
      plan: {
        goal: '查询流程', completionCriteria: ['取得列表或详情证据'],
        businessSteps: [
          { id: 'enter-list', title: '进入列表', domStepIndexes: [2], kind: 'navigation', dependsOn: [], completionCriteria: ['列表已打开'] },
          { id: 'read-list', title: '读取列表', domStepIndexes: [3], kind: 'collection', dependsOn: ['enter-list'], completionCriteria: ['列表字段已读取'] },
          { id: 'open-detail', title: '打开目标详情', domStepIndexes: [4], kind: 'detail', dependsOn: ['read-list'], completionCriteria: ['详情已打开'] },
          { id: 'return-home', title: '返回首页', domStepIndexes: [1], kind: 'navigation', dependsOn: ['open-detail'], completionCriteria: ['已返回首页'] },
        ],
        branches: [
          { id: 'collection-result', when: '用户需要列表或统计', purpose: '只读取集合结果', stepIndexes: [1, 2, 3] },
          { id: 'item-detail', when: '用户需要详情', purpose: '动态打开目标', stepIndexes: [1, 2, 3, 4], targetStepIndex: 4 },
        ],
      },
      events: [
        { type: 'navigate', timestamp: '2026-01-01T00:00:00.000Z', url: 'https://example.com/home' },
        { type: 'click', timestamp: '2026-01-01T00:00:01.000Z', url: 'https://example.com/home', accessibleName: '流程管理', locator: { text: '流程管理', role: 'button', tag: 'button' } },
        { type: 'scroll', timestamp: '2026-01-01T00:00:02.000Z', url: 'https://example.com/processes', scrollY: 400 },
        { type: 'click', timestamp: '2026-01-01T00:00:03.000Z', url: 'https://example.com/processes', text: '示例条目', locator: { text: '示例条目', role: 'link', tag: 'a' } },
      ],
    });

    const execution = buildBusinessExecutionWorkflow(workflow, undefined, undefined, '查一下最近三个月请假了多少次');
    expect(execution.steps.map((step) => step.action)).toEqual(['navigate', 'click', 'scroll']);
    expect(execution.steps.some((step) => step.locator?.text === '示例条目')).toBe(false);
  });

  it('does not accept a contradictory completion statement as success', () => {
    expect(operationVerificationIndicatesFailure('页面仍停留在列表页，点击动作未生效')).toBe(true);
    expect(operationVerificationIndicatesFailure('页面已经进入目标详情，没有异常')).toBe(false);
  });

  it('rejects a structurally incomplete workflow before activation', () => {
    const workflow = buildWorkflowFromTrace({
      skillId: 'operation-incomplete', platformId: 'platform-a', ownerAgentId: 'operation-agent-a',
      name: '打开平台', description: '打开平台并确认页面可用', visionEnabled: false,
      events: [{ type: 'navigate', timestamp: '2026-01-01T00:00:00.000Z', url: 'https://example.com/' }],
    });

    const review = validateOperationWorkflowStructure({ ...workflow, plan: { ...workflow.plan, stages: [], businessSteps: [] } });
    expect(review.valid).toBe(false);
    expect(review.issues.join(' ')).toContain('业务');
  });

  it('fills omitted trailing actions into an inferred stage', () => {
    const workflow = buildWorkflowFromTrace({
      skillId: 'operation-partial-plan', platformId: 'platform-a', ownerAgentId: 'operation-agent-a',
      name: '简单操作', description: '进入页面并完成操作', visionEnabled: false,
      events: [
        { type: 'navigate', timestamp: '2026-01-01T00:00:00.000Z', url: 'https://example.com/' },
        { type: 'click', timestamp: '2026-01-01T00:00:01.000Z', url: 'https://example.com/', accessibleName: '开始' },
        { type: 'click', timestamp: '2026-01-01T00:00:02.000Z', url: 'https://example.com/', accessibleName: '确认' },
      ],
      plan: {
        goal: '完成页面操作', completionCriteria: ['页面显示已完成'],
        stages: [{ id: 'open-page', title: '打开页面', purpose: '进入页面', stepIndexes: [1], completionCriteria: ['页面已经打开'] }],
      },
    });

    expect(workflow.plan?.stages?.flatMap((stage) => stage.stepIndexes ?? [])).toEqual([1, 2, 3]);
    expect(validateOperationWorkflowStructure(workflow).valid).toBe(true);
  });
});

describe('operation platform revocation', () => {
  let directory: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'operation-skill-'));
    dbPath = join(directory, 'test.db');
    runMigrations(dbPath);
    db = new Database(dbPath);
  });

  afterEach(async () => {
    db.close(); closeDatabase();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });

  it('revokes skills without deleting packages or run history', () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO operation_platforms (id, owner_agent_id, name, url, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`)
      .run('platform-a', 'operation-agent-a', '测试平台', 'https://example.com/', now, now);
    db.prepare(`INSERT INTO operation_skills (id, platform_id, owner_agent_id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
      .run('operation-login', 'platform-a', 'operation-agent-a', '登录', '登录测试平台', now, now);
    db.prepare(`INSERT INTO skill_packages (id, version, name, description, package_rel_path, entry_rel_path, manifest_json, checksum, source, enabled, installed_at, updated_at) VALUES (?, '1.0.0', ?, ?, ?, 'SKILL.md', '{}', 'digest', 'custom', 1, ?, ?)`)
      .run('operation-login', '登录', '登录测试平台', 'skills/operation-login', now, now);
    db.prepare(`INSERT INTO operation_skill_runs (id, skill_id, platform_id, owner_agent_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'completed', ?, ?)`)
      .run('run-a', 'operation-login', 'platform-a', 'operation-agent-a', now, now);

    const manager = new OperationSkillManager(db, () => null, () => undefined, directory);
    manager.revokePlatform('platform-a');

    expect((db.prepare('SELECT status FROM operation_platforms WHERE id = ?').get('platform-a') as { status: string }).status).toBe('revoked');
    expect((db.prepare('SELECT status FROM operation_skills WHERE id = ?').get('operation-login') as { status: string }).status).toBe('revoked');
    expect((db.prepare('SELECT enabled FROM skill_packages WHERE id = ?').get('operation-login') as { enabled: number }).enabled).toBe(0);
    expect((db.prepare('SELECT COUNT(*) as count FROM operation_skill_runs WHERE id = ?').get('run-a') as { count: number }).count).toBe(1);
  });

  it('deletes a skill after removing definition bindings that reference its package', async () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO operation_platforms (id, owner_agent_id, name, url, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`)
      .run('platform-delete', 'operation-agent-delete', '删除测试平台', 'https://example.com/', now, now);
    db.prepare(`INSERT INTO operation_skills (id, platform_id, owner_agent_id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
      .run('operation-delete', 'platform-delete', 'operation-agent-delete', '测试技能', '删除测试技能', now, now);
    db.prepare(`INSERT INTO skill_packages (id, version, name, description, package_rel_path, entry_rel_path, manifest_json, checksum, source, enabled, installed_at, updated_at) VALUES (?, '1.0.0', ?, ?, ?, 'SKILL.md', '{}', 'digest', 'custom', 1, ?, ?)`)
      .run('operation-delete', '测试技能', '删除测试技能', 'agent-definitions/custom/operation-agent-delete/1.0.0/skills/operation-delete', now, now);
    db.prepare(`INSERT INTO agent_definition_skills (agent_definition_id, agent_definition_version, skill_id, skill_version, ordinal, config_json) VALUES (?, '1.0.0', ?, '1.0.0', 0, '{}')`)
      .run('operation-agent-delete', 'operation-delete');
    db.prepare(`INSERT INTO operation_skill_runs (id, skill_id, platform_id, owner_agent_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'completed', ?, ?)`)
      .run('run-delete', 'operation-delete', 'platform-delete', 'operation-agent-delete', now, now);
    db.prepare(`INSERT INTO operation_conversation_messages (id, platform_id, role, content, related_run_id, created_at) VALUES (?, ?, 'agent', ?, ?, ?)`)
      .run('message-delete', 'platform-delete', '执行完成', 'run-delete', now);

    const manager = new OperationSkillManager(db, () => null, () => undefined, directory);
    await manager.deleteSkill('operation-delete');

    expect(db.prepare('SELECT COUNT(*) as count FROM agent_definition_skills WHERE skill_id = ?').get('operation-delete')).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) as count FROM skill_packages WHERE id = ?').get('operation-delete')).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) as count FROM operation_skills WHERE id = ?').get('operation-delete')).toEqual({ count: 0 });
    expect(db.prepare('SELECT related_run_id as relatedRunId FROM operation_conversation_messages WHERE id = ?').get('message-delete')).toEqual({ relatedRunId: null });
  });
});

describe('operation monitor agent', () => {
  let directory: string;
  let db: Database.Database;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'operation-agent-'));
    const dbPath = join(directory, 'test.db');
    runMigrations(dbPath);
    db = new Database(dbPath);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO operation_platforms
      (id, owner_agent_id, name, url, description, model_profile_id, temperature, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
      .run('platform-a', 'operation-agent-a', 'EKP', 'https://example.com/', '企业协同平台', 'model-a', 0.2, now, now);
    for (const item of [
      { id: 'operation-login', name: '登录EKP', description: '登录 EKP 平台', target: '登录' },
      { id: 'operation-logout', name: '退出EKP登录', description: '退出当前 EKP 登录状态', target: '退出' },
    ]) {
      const workflow = buildWorkflowFromTrace({
        skillId: item.id, platformId: 'platform-a', ownerAgentId: 'operation-agent-a', name: item.name,
        description: item.description, visionEnabled: false,
        events: [{ type: 'click', timestamp: now, url: 'https://example.com/', selectorCandidates: [`[aria-label="${item.target}"]`], accessibleName: item.target }],
      });
      db.prepare(`INSERT INTO operation_skills
        (id, platform_id, owner_agent_id, name, description, status, workflow_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
        .run(item.id, 'platform-a', 'operation-agent-a', item.name, item.description, JSON.stringify(workflow), now, now);
    }
  });

  afterEach(async () => {
    db.close(); closeDatabase();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });

  const gatewayReturning = (decision: Record<string, unknown>): ModelGateway => ({
    runWithModelProfileSnapshot: async (_snapshot: string | null | undefined, task: () => Promise<unknown>) => task(),
    generateObject: vi.fn().mockResolvedValue(decision),
  }) as unknown as ModelGateway;

  it('does not execute a default skill when no model gateway is available', async () => {
    const manager = new OperationSkillManager(db, () => null, () => undefined, directory);
    const result = await manager.runInstruction({ platformId: 'platform-a', instruction: '你能做什么？' });

    expect(result.intent).toBe('clarify');
    expect(db.prepare('SELECT COUNT(*) as count FROM operation_skill_runs').get()).toEqual({ count: 0 });
    expect(manager.listConversation('platform-a').map((item) => item.role)).toEqual(['user', 'agent']);
  });

  it('answers a question without executing a skill and persists the conversation', async () => {
    const gateway = gatewayReturning({ intent: 'answer', confidence: 0.99, reply: '我可以登录或退出 EKP。' });
    const manager = new OperationSkillManager(db, () => gateway, () => undefined, directory);
    const result = await manager.runInstruction({ platformId: 'platform-a', instruction: '你有哪些技能？' });

    expect(result).toMatchObject({ intent: 'answer', message: '我可以登录或退出 EKP。' });
    expect(db.prepare('SELECT COUNT(*) as count FROM operation_skill_runs').get()).toEqual({ count: 0 });
    expect(manager.listConversation('platform-a').map((item) => item.content)).toEqual(['你有哪些技能？', '我可以登录或退出 EKP。']);
  });

  it('rejects an unknown skill id instead of falling back to the first skill', async () => {
    const gateway = gatewayReturning({ intent: 'execute', skillId: 'operation-missing', confidence: 0.98, parameters: {}, reply: '开始操作。' });
    const manager = new OperationSkillManager(db, () => gateway, () => undefined, directory);
    const result = await manager.runInstruction({ platformId: 'platform-a', instruction: '打开我的待办' });

    expect(result.intent).toBe('clarify');
    expect(db.prepare('SELECT COUNT(*) as count FROM operation_skill_runs').get()).toEqual({ count: 0 });
  });

  it('executes only the exact skill selected by the model', async () => {
    const gateway = gatewayReturning({ intent: 'execute', skillId: 'operation-logout', confidence: 0.98, parameters: {}, reply: '好的，我现在退出 EKP。' });
    const manager = new OperationSkillManager(db, () => gateway, () => undefined, directory);
    const result = await manager.runInstruction({ platformId: 'platform-a', instruction: '退出 EKP 登录' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toMatchObject({ intent: 'execute', message: '好的，我现在退出 EKP。' });
    expect(db.prepare('SELECT skill_id as skillId FROM operation_skill_runs WHERE id = ?').get(result.runId)).toEqual({ skillId: 'operation-logout' });
  });

  it('waits for clarification instead of turning the complete recording into a fallback macro', async () => {
    const traceRelPath = 'recordings/recording-fallback/trace.jsonl';
    await mkdir(join(directory, 'recordings', 'recording-fallback'), { recursive: true });
    await writeFile(join(directory, traceRelPath), `${JSON.stringify({
      type: 'click', timestamp: new Date().toISOString(), url: 'https://example.com/',
      selectorCandidates: ['[aria-label="开始"]'], accessibleName: '开始', locator: { text: '开始', role: 'button', tag: 'button' },
    })}\n`, 'utf8');
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO operation_recording_sessions
      (id, platform_id, status, trace_rel_path, event_count, started_at, stopped_at, updated_at)
      VALUES (?, ?, 'saved', ?, 1, ?, ?, ?)`)
      .run('recording-fallback', 'platform-a', traceRelPath, now, now, now);
    const gateway = {
      runWithModelProfileSnapshot: async (_snapshot: string | null | undefined, task: () => Promise<unknown>) => task(),
      generateObject: vi.fn().mockRejectedValue(new Error('semantic model timeout')),
    } as unknown as ModelGateway;
    const manager = new OperationSkillManager(db, () => gateway, () => undefined, directory);
    const learned = await manager.learnSkill({ platformId: 'platform-a', recordingId: 'recording-fallback', name: '点击开始', description: '点击开始按钮' });
    let waiting: Record<string, unknown> | undefined;
    for (let index = 0; index < 300; index++) {
      const status = manager.getLearningStatus(learned.skillId);
      if (status.learningPhase === 'awaiting-user') { waiting = status; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(waiting?.status).toBe('learning');
    expect(waiting?.learningError).toBeNull();
    expect(waiting?.workflow).toBeNull();
    expect(JSON.stringify(waiting?.messages)).toContain('不会把全部录制动作直接做成技能');
  });

  it('keeps the recorded login workflow when semantic reviews repeatedly compare incompatible step layers', async () => {
    const traceRelPath = 'recordings/recording-login-review/trace.jsonl';
    await mkdir(join(directory, 'recordings', 'recording-login-review'), { recursive: true });
    const events = [
      { type: 'navigate', timestamp: '2026-01-01T00:00:00.000Z', url: 'https://example.com/login' },
      { type: 'input', timestamp: '2026-01-01T00:00:01.000Z', url: 'https://example.com/login', selectorCandidates: ['#username'], fieldKey: 'username', accessibleName: '用户名' },
      { type: 'input', timestamp: '2026-01-01T00:00:02.000Z', url: 'https://example.com/login', selectorCandidates: ['#password'], fieldKey: 'password', accessibleName: '密码', sensitive: true },
      { type: 'click', timestamp: '2026-01-01T00:00:03.000Z', url: 'https://example.com/login', selectorCandidates: ['button[type="submit"]'], accessibleName: '登录', locator: { text: '登录', role: 'button', tag: 'button' } },
    ];
    await writeFile(join(directory, traceRelPath), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO operation_recording_sessions
      (id, platform_id, status, trace_rel_path, event_count, started_at, stopped_at, updated_at)
      VALUES (?, ?, 'saved', ?, 4, ?, ?, ?)`)
      .run('recording-login-review', 'platform-a', traceRelPath, now, now, now);
    const analysis = {
      ready: true, questions: [], mismatches: [], summary: '登录平台',
      stepTitles: ['打开登录页', '输入密码', '点击登录', '填写用户名'],
      inputDefaults: { username: 'model-user', password: 'model-password' },
      plan: {
        goal: '登录平台', completionCriteria: ['进入平台首页'],
        businessSteps: [
          { id: 'check-session', title: '确认登录状态', domStepIndexes: [], verification: 'vision', completionCriteria: ['确认是否已经登录'] },
          { id: 'open-login', title: '确认登录页', domStepIndexes: [1], verification: 'dom-and-vision', completionCriteria: ['登录表单可见'] },
          { id: 'fill-user', title: '填写用户名', domStepIndexes: [2], verification: 'dom', completionCriteria: ['用户名已填写'] },
          { id: 'fill-password', title: '填写密码', domStepIndexes: [3], verification: 'dom', completionCriteria: ['密码已填写'] },
          { id: 'submit', title: '提交登录', domStepIndexes: [4], verification: 'dom-and-vision', completionCriteria: ['页面离开登录页'] },
          { id: 'confirm-home', title: '确认平台首页', domStepIndexes: [], verification: 'vision', completionCriteria: ['平台首页可见'] },
        ],
      },
    };
    const failedReview = {
      valid: false, needsUserInput: false,
      summary: '错误地比较了两个步骤层级',
      issues: ['顶层steps与plan内steps不一致，且步骤标题与动作错位'],
      repairInstructions: ['重新对齐步骤数组'], questions: [], correctedAnalysis: analysis,
    };
    const generateObject = vi.fn()
      .mockResolvedValueOnce(analysis)
      .mockResolvedValueOnce(failedReview)
      .mockResolvedValueOnce(failedReview)
      .mockResolvedValueOnce(failedReview);
    const gateway = {
      runWithModelProfileSnapshot: async (_snapshot: string | null | undefined, task: () => Promise<unknown>) => task(),
      generateObject,
    } as unknown as ModelGateway;
    const manager = new OperationSkillManager(db, () => gateway, () => undefined, directory);
    const learned = await manager.learnSkill({ platformId: 'platform-a', recordingId: 'recording-login-review', name: '登录平台', description: '用户名是：demo-user，密码是：demo-pass，填写后登录平台' });
    let ready: Record<string, unknown> | undefined;
    for (let index = 0; index < 300; index++) {
      const status = manager.getLearningStatus(learned.skillId);
      if (status.learningPhase === 'ready') { ready = status; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(ready?.status).toBe('draft');
    expect(ready?.learningError).toBeNull();
    expect((ready?.workflow as { validation?: { status?: string } })?.validation?.status).toBe('passed');
    const persisted = db.prepare('SELECT workflow_json as workflowJson FROM operation_skills WHERE id = ?').get(learned.skillId) as { workflowJson: string };
    const persistedWorkflow = JSON.parse(persisted.workflowJson) as { inputSchema?: { properties?: Record<string, { defaultValue?: string }> } };
    expect(persistedWorkflow.inputSchema?.properties?.username?.defaultValue).toBe('demo-user');
    expect(persistedWorkflow.inputSchema?.properties?.password?.defaultValue).toBe('demo-pass');
    expect(JSON.stringify(ready?.messages)).not.toContain('技能学习失败');
    expect(generateObject).toHaveBeenCalledTimes(4);
  });

  it('requires a model when creating or syncing an operation platform', () => {
    const manager = new OperationSkillManager(db, () => null, () => undefined, directory);
    expect(() => manager.syncPlatform({ id: 'new-platform', name: '新平台', url: 'https://example.org/' })).toThrow('操作智能体必须绑定模型');
  });

  it('keeps asking when the DOM trace and the written description do not match', async () => {
    const traceRelPath = 'recordings/recording-a/trace.jsonl';
    await mkdir(join(directory, 'recordings', 'recording-a'), { recursive: true });
    await writeFile(join(directory, traceRelPath), `${JSON.stringify({
      type: 'click', timestamp: new Date().toISOString(), url: 'https://example.com/',
      selectorCandidates: ['[aria-label="退出"]'], accessibleName: '退出',
    })}\n`, 'utf8');
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO operation_recording_sessions
      (id, platform_id, status, trace_rel_path, event_count, started_at, stopped_at, updated_at)
      VALUES (?, ?, 'saved', ?, 1, ?, ?, ?)`)
      .run('recording-a', 'platform-a', traceRelPath, now, now, now);
    const generateObject = vi.fn()
      .mockResolvedValueOnce({ ready: false, mismatches: ['说明要求登录，但录制轨迹执行了退出'], questions: ['这段技能应当登录还是退出 EKP？'] })
      .mockResolvedValueOnce({
        ready: true, mismatches: [], questions: [], summary: '退出当前 EKP 登录状态', stepTitles: ['退出 EKP'],
        stepSemantics: [{ purpose: '清理旧会话并进入登录页', expected: '页面进入统一登录入口' }],
        plan: {
          goal: '进入统一登录入口', completionCriteria: ['页面出现登录入口'],
          stages: [{ id: 'enter-login', title: '进入登录入口', purpose: '清理旧会话', stepIndexes: [1], completionCriteria: ['页面出现登录入口'] }],
        },
      })
      .mockResolvedValueOnce({ valid: true, needsUserInput: false, summary: '工作流与补充说明一致。', issues: [], questions: [] });
    const gateway = {
      runWithModelProfileSnapshot: async (_snapshot: string | null | undefined, task: () => Promise<unknown>) => task(),
      generateObject,
    } as unknown as ModelGateway;
    const manager = new OperationSkillManager(db, () => gateway, () => undefined, directory);
    const learned = await manager.learnSkill({ platformId: 'platform-a', recordingId: 'recording-a', name: '登录EKP', description: '登录 EKP' });
    const waitForPhase = async (phase: string): Promise<Record<string, unknown>> => {
      for (let index = 0; index < 100; index++) {
        const status = manager.getLearningStatus(learned.skillId);
        if (status.learningPhase === phase) return status;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`未进入技能学习状态：${phase}`);
    };
    const awaiting = await waitForPhase('awaiting-user');
    expect(JSON.stringify(awaiting.messages)).toContain('这段技能应当登录还是退出 EKP');

    await manager.replyLearning(learned.skillId, '按钮虽然显示“退出”，但在这个页面它会清理旧会话并进入统一登录页，这就是登录流程的入口。');
    const ready = await waitForPhase('ready');
    expect(ready.status).toBe('draft');
    expect(JSON.stringify(generateObject.mock.calls[1]?.[1])).toContain('按钮虽然显示');
  });

  it('persists the user decision and never reopens the same learning conflict', async () => {
    const traceRelPath = 'recordings/recording-user-priority/trace.jsonl';
    await mkdir(join(directory, 'recordings', 'recording-user-priority'), { recursive: true });
    await writeFile(join(directory, traceRelPath), `${JSON.stringify({
      type: 'click', timestamp: new Date().toISOString(), url: 'https://example.com/',
      selectorCandidates: ['button[data-action="export"]'], accessibleName: '导出',
      locator: { text: '导出', role: 'button', tag: 'button' },
    })}\n`, 'utf8');
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO operation_recording_sessions
      (id, platform_id, status, trace_rel_path, event_count, started_at, stopped_at, updated_at)
      VALUES (?, ?, 'saved', ?, 1, ?, ?, ?)`)
      .run('recording-user-priority', 'platform-a', traceRelPath, now, now, now);
    const repeatedQuestion = '录制截图显示“导出”按钮位于用户菜单内，但用户说明要求在首页直接使用。应以哪一项为准？';
    const repeatedMismatch = '录制截图与用户说明对按钮入口位置的描述不一致';
    const analysisWithPlan = {
      ready: false,
      questions: [repeatedQuestion],
      mismatches: [repeatedMismatch],
      summary: '按用户说明从首页导出结果',
      plan: {
        goal: '从首页导出结果',
        completionCriteria: ['页面已经触发导出'],
        businessSteps: [{
          id: 'export-result', title: '导出结果', purpose: '按用户说明使用首页导出入口',
          domStepIndexes: [1], dependsOn: [], when: '用户需要导出时', verification: 'dom',
          completionCriteria: ['页面已经触发导出'],
        }],
      },
      stepAnnotations: [{ stepIndex: 1, title: '点击导出', purpose: '触发导出', expected: '页面开始导出' }],
    };
    const generateObject = vi.fn()
      .mockResolvedValueOnce({ ready: false, questions: [repeatedQuestion], mismatches: [repeatedMismatch] })
      // Simulate a model that ignores the answer once. The learning state
      // must still prevent the same resolved issue from reaching the user.
      .mockResolvedValueOnce(analysisWithPlan)
      .mockResolvedValueOnce({ valid: true, needsUserInput: false, summary: '已按用户裁决生成业务工作流。', issues: [], questions: [] });
    const gateway = {
      runWithModelProfileSnapshot: async (_snapshot: string | null | undefined, task: () => Promise<unknown>) => task(),
      generateObject,
    } as unknown as ModelGateway;
    const manager = new OperationSkillManager(db, () => gateway, () => undefined, directory);
    const learned = await manager.learnSkill({
      platformId: 'platform-a', recordingId: 'recording-user-priority', name: '导出结果', description: '以用户说明的业务逻辑为准，从首页导出结果',
    });
    const waitForPhase = async (phase: string): Promise<Record<string, unknown>> => {
      for (let index = 0; index < 100; index++) {
        const status = manager.getLearningStatus(learned.skillId);
        if (status.learningPhase === phase) return status;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`未进入技能学习状态：${phase}`);
    };
    await waitForPhase('awaiting-user');

    await manager.replyLearning(learned.skillId, '以我的逻辑为准。');

    const ready = await waitForPhase('ready');
    const repeated = (ready.messages as Array<{ role: string; content: string }>).filter((item) => item.role === 'agent' && item.content === repeatedQuestion);
    expect(repeated).toHaveLength(1);
    expect(ready.status).toBe('draft');
    expect(db.prepare(
      `SELECT status, answer, source_priority as sourcePriority
       FROM operation_learning_resolutions WHERE skill_id = ?`,
    ).get(learned.skillId)).toMatchObject({ status: 'resolved', answer: '以我的逻辑为准。', sourcePriority: 'user-description' });
    expect(JSON.stringify(generateObject.mock.calls[1]?.[1])).toContain('禁止再次询问同一事项');
  });

  it('repairs and revalidates a generated workflow before marking it ready', async () => {
    const traceRelPath = 'recordings/recording-repair/trace.jsonl';
    await mkdir(join(directory, 'recordings', 'recording-repair'), { recursive: true });
    await writeFile(join(directory, traceRelPath), `${JSON.stringify({
      type: 'click', timestamp: new Date().toISOString(), url: 'https://example.com/',
      selectorCandidates: ['[aria-label="流程管理"]'], accessibleName: '流程管理',
    })}\n`, 'utf8');
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO operation_recording_sessions
      (id, platform_id, status, trace_rel_path, event_count, started_at, stopped_at, updated_at)
      VALUES (?, ?, 'saved', ?, 1, ?, ?, ?)`)
      .run('recording-repair', 'platform-a', traceRelPath, now, now, now);
    const correctedAnalysis = {
      ready: true, mismatches: [], questions: [], summary: '进入流程管理并确认列表加载',
      stepTitles: ['打开流程管理'],
      stepSemantics: [{ purpose: '进入流程列表', when: '需要查询流程时', expected: '流程列表已经出现' }],
      plan: {
        goal: '打开流程列表', completionCriteria: ['页面显示流程列表'],
        stages: [{ id: 'open-list', title: '进入流程列表', purpose: '打开流程管理', stepIndexes: [1], completionCriteria: ['页面显示流程列表'] }],
      },
    };
    const generateObject = vi.fn()
      .mockResolvedValueOnce({ ready: true, mismatches: [], questions: [], summary: '打开流程管理', stepTitles: ['打开流程管理'] })
      .mockResolvedValueOnce({
        valid: false, needsUserInput: false, summary: '缺少可观察完成条件', issues: ['阶段没有完成条件'],
        repairInstructions: ['补充列表加载完成的页面证据'], questions: [], correctedAnalysis,
      })
      .mockResolvedValueOnce({ valid: true, needsUserInput: false, summary: '阶段与完成条件已经通过复核', issues: [], questions: [] });
    const gateway = {
      runWithModelProfileSnapshot: async (_snapshot: string | null | undefined, task: () => Promise<unknown>) => task(),
      generateObject,
    } as unknown as ModelGateway;
    const manager = new OperationSkillManager(db, () => gateway, () => undefined, directory);
    const learned = await manager.learnSkill({ platformId: 'platform-a', recordingId: 'recording-repair', name: '流程查询入口', description: '进入流程管理并等待列表加载完成' });
    let ready: Record<string, unknown> | undefined;
    for (let index = 0; index < 100; index++) {
      const status = manager.getLearningStatus(learned.skillId);
      if (status.learningPhase === 'ready') { ready = status; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(ready?.status).toBe('draft');
    expect((ready?.workflow as { validation?: { status?: string; attempts?: number } })?.validation).toMatchObject({ status: 'passed', attempts: 2 });
    expect(generateObject).toHaveBeenCalledTimes(3);
  });
});
