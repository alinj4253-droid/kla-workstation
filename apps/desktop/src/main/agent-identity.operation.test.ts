// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildRoleCard, buildAgentCoordinationSummary } from './agent-identity';

describe('operation agent group role card', () => {
  const input = {
    projectId: 'project-1',
    instanceId: 'project-1-agent-operation',
    name: 'EKP V2操作智能体',
    role: 'teammate',
    runtimeMode: 'native-model',
    definitionId: 'operation-agent-ekp-v2',
    definitionVersion: '1.0.0',
    operationPlatform: {
      id: 'platform-ekp-v2',
      name: 'EKP V2',
      url: 'https://example.test/login',
      description: '企业流程平台',
      skills: [{ name: '流程查询', description: '按用户条件查询流程记录' }],
    },
  };

  it('includes the platform context and enabled skills in ROLE.md content', () => {
    const role = buildRoleCard(input);
    expect(role).toContain('平台名称：EKP V2');
    expect(role).toContain('平台地址：https://example.test/login');
    expect(role).toContain('平台描述：企业流程平台');
    expect(role).toContain('流程查询（按用户条件查询流程记录）');
  });

  it('publishes an operation-specific coordination summary', () => {
    expect(buildAgentCoordinationSummary(input)).toContain('绑定的操作平台');
    expect(buildAgentCoordinationSummary(input)).toContain('网页操作');
  });
});

describe('external CLI role cards', () => {
  const base = {
    projectId: 'project-external-role',
    instanceId: 'project-external-role-agent',
    role: 'teammate',
    runtimeMode: 'external-cli',
    definitionVersion: '1.0.0',
  } as const;

  it('defines CodeBuddy as an acceptance reviewer', () => {
    const input = { ...base, name: 'CodeBuddy', definitionId: 'custom.codebuddy' };
    expect(buildAgentCoordinationSummary(input)).toContain('验收本地执行智能体');
    expect(buildRoleCard(input)).toContain('只执行独立验收');
    expect(buildRoleCard(input)).not.toContain('代码工作包闭环完成');
  });

  it('defines Kimi Code as a code-writing agent', () => {
    const input = { ...base, name: 'Kimi Code', definitionId: 'custom.kimi-code' };
    expect(buildAgentCoordinationSummary(input)).toContain('代码编写智能体');
    expect(buildRoleCard(input)).toContain('代码工作包闭环完成');
  });
});
