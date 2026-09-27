// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ModelGateway } from './model-gateway';
import { analyzeMeetingSpeakers, generateMeetingMinutes, refineMeetingSpeakers } from './meeting-agent';

const transcript = [{ id: 'line-1', speaker: '说话人1', text: '张三，你负责发布检查。', speakerClusterId: 'context:0' }];
const speaker = { clusterId: 'context:0', label: '说话人1' };

describe('meeting agent', () => {
  it('keeps inferred names as suggestions until the user confirms them', async () => {
    const generateObject = vi.fn().mockResolvedValue({ speakers: [{ ...speaker, suggestedName: '张三', confidence: 0.8, evidenceLineIds: ['line-1'] }], question: '请确认。' });
    const result = await analyzeMeetingSpeakers({ generateObject } as unknown as ModelGateway, {
      meetingName: '发布会', projectName: '产品项目', knownPeople: ['张三'], transcript, speakers: [speaker],
    });
    expect(result.speakers[0]).toMatchObject({ name: '张三', status: 'suggested', evidenceLineIds: ['line-1'] });
  });

  it('treats an explicit chat correction as a user confirmation', async () => {
    const generateObject = vi.fn();
    const identity = { ...speaker, name: '说话人1', status: 'unresolved' as const };
    const result = await refineMeetingSpeakers({ generateObject } as unknown as ModelGateway, {
      meetingName: '发布会', projectName: '产品项目', knownPeople: [], transcript, speakers: [speaker], identities: [identity], message: '说话人1是李明',
    });
    expect(result.speakers[0]).toMatchObject({ name: '李明', status: 'confirmed' });
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('blocks minutes before confirmation and preserves unknown owners and dates', async () => {
    const generateObject = vi.fn().mockResolvedValue({ summary: '完成发布安排。', conclusions: ['按计划发布'], actions: [{ title: '检查发布环境' }] });
    const gateway = { generateObject } as unknown as ModelGateway;
    await expect(generateMeetingMinutes(gateway, {
      meetingName: '发布会', projectName: '产品项目', transcript, speakers: [{ ...speaker, name: '张三', status: 'suggested' }], confirmations: [],
    })).rejects.toThrow('请先确认全部说话人');
    await expect(generateMeetingMinutes(gateway, {
      meetingName: '发布会', projectName: '产品项目', transcript, speakers: [{ ...speaker, name: '张三', status: 'confirmed' }], confirmations: ['说话人1是张三'],
    })).resolves.toMatchObject({ actions: [{ owner: '待确认', due: '待确认' }] });
  });
});
