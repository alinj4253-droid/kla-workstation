import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listAgentPrivateOutputFiles, prepareAgentPrivateWorkspace, syncAgentPrivateOutputs } from './agent-private-workspace';

describe('agent private workspace', () => {
  let root = '';

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('copies only the current agent identity and memory, then syncs outputs', async () => {
    root = await mkdtemp(join(tmpdir(), 'kunqing-agent-private-'));
    await Promise.all([
      mkdir(join(root, 'agent-identities', 'agent-a'), { recursive: true }),
      mkdir(join(root, 'agent-identities', 'agent-b'), { recursive: true }),
      mkdir(join(root, 'agent-memories', 'agent-a', 'long-term'), { recursive: true }),
      mkdir(join(root, 'agent-memories', 'agent-b', 'long-term'), { recursive: true }),
      mkdir(join(root, 'original-files'), { recursive: true }),
      mkdir(join(root, 'outputs'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, 'agent-identities', 'agent-a', 'IDENTITY.md'), 'A 身份', 'utf8'),
      writeFile(join(root, 'agent-identities', 'agent-b', 'IDENTITY.md'), 'B 身份', 'utf8'),
      writeFile(join(root, 'agent-memories', 'agent-a', 'long-term', 'summary.md'), 'A 记忆', 'utf8'),
      writeFile(join(root, 'agent-memories', 'agent-b', 'long-term', 'summary.md'), 'B 记忆', 'utf8'),
      writeFile(join(root, 'original-files', 'brief.md'), '任务资料', 'utf8'),
    ]);

    const workspace = await prepareAgentPrivateWorkspace({
      projectRoot: root,
      agentInstanceId: 'agent-a',
      runId: 'run-1',
      agentName: '知识管理智能体',
    });

    expect(await readFile(join(workspace, 'identity', 'IDENTITY.md'), 'utf8')).toBe('A 身份');
    expect(await readFile(join(workspace, 'memory', 'long-term', 'summary.md'), 'utf8')).toBe('A 记忆');
    expect(await readFile(join(workspace, 'original-files', 'brief.md'), 'utf8')).toBe('任务资料');
    await expect(access(join(workspace, 'agent-identities', 'agent-b', 'IDENTITY.md'))).rejects.toThrow();
    await expect(access(join(workspace, 'agent-memories', 'agent-b', 'long-term', 'summary.md'))).rejects.toThrow();

    await writeFile(join(workspace, 'outputs', 'result.html'), '<h1>完成</h1>', 'utf8');
    await mkdir(join(workspace, 'outputs', 'assets'), { recursive: true });
    await writeFile(join(workspace, 'outputs', 'assets', 'summary.json'), '{}', 'utf8');
    expect(new Set(await listAgentPrivateOutputFiles(workspace))).toEqual(new Set([
      'outputs/result.html',
      'outputs/assets/summary.json',
    ]));
    await syncAgentPrivateOutputs(workspace, root);
    expect(await readFile(join(root, 'outputs', 'result.html'), 'utf8')).toContain('完成');
  });
});
