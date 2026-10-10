import { taskPlanSchema } from '@kla-workstation/contracts';
import { describe, expect, it } from 'vitest';
import { normalizeTaskPlanPayload } from './agent-loop.js';

describe('normalizeTaskPlanPayload', () => {
  it('accepts a four-step model plan when only the fourth title is missing', () => {
    const agentId = 'd7f241a5-5881-48b1-8f1b-02721b22f49d';
    const result = taskPlanSchema.parse(normalizeTaskPlanPayload({
      tasks: [
        { title: '大纲', instruction: '编写大纲', agentId, dependsOn: [] },
        { title: '第一章', instruction: '编写第一章', agentId, dependsOn: [1] },
        { title: '第二章', instruction: '编写第二章', agentId, dependsOn: [2] },
        { instruction: '整理第四章内容。完成后检查链接', agentId, dependsOn: [3] },
      ],
    }));

    expect(result.tasks.map(task => task.title)).toEqual(['大纲', '第一章', '第二章', '整理第四章内容']);
    expect(result.tasks[3].dependsOn).toEqual([3]);
  });

  it('still rejects a task without executable instructions', () => {
    const agentId = 'd7f241a5-5881-48b1-8f1b-02721b22f49d';
    expect(() => taskPlanSchema.parse(normalizeTaskPlanPayload({ tasks: [{ agentId, dependsOn: [] }] }))).toThrow();
  });
});
