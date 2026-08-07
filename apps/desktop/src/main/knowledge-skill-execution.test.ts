import { describe, expect, it, vi } from 'vitest';
import {
  executeKnowledgeFileProcessingSkill,
  executeKnowledgeRetrievalSkills,
  type KnowledgeSkillActivity,
} from './knowledge-skill-execution';

function registryFor(skillIds: string[]) {
  return {
    loadForRun: vi.fn((_runId: string, skillId: string) => skillIds.includes(skillId) ? `# ${skillId}` : null),
  };
}

describe('knowledge skill execution', () => {
  it('records the file-processing skill around direct ingestion', async () => {
    const activities: KnowledgeSkillActivity[] = [];
    const result = await executeKnowledgeFileProcessingSkill({
      registry: registryFor(['process-knowledge-files']),
      runId: 'run-ingest',
      report: (activity) => activities.push(activity),
      execute: async (instructions) => instructions.includes('process-knowledge-files') ? 'done' : 'missing',
    });

    expect(result).toBe('done');
    expect(activities.map((activity) => [activity.skillId, activity.status])).toEqual([
      ['process-knowledge-files', 'running'],
      ['process-knowledge-files', 'completed'],
    ]);
    expect(activities[0]?.id).toBe(activities[1]?.id);
  });

  it('records retrieval without falsely showing preprocessing when sources are unchanged', async () => {
    const activities: KnowledgeSkillActivity[] = [];
    const result = await executeKnowledgeRetrievalSkills({
      registry: registryFor(['process-knowledge-files', 'retrieve-knowledge']),
      runId: 'run-search',
      report: (activity) => activities.push(activity),
      synchronize: async () => ({ changedFileIds: [], deletedFileIds: [], failedFileIds: [] }),
      retrieve: () => 'evidence',
    });

    expect(result).toBe('evidence');
    expect(activities.map((activity) => [activity.skillId, activity.status])).toEqual([
      ['retrieve-knowledge', 'running'],
      ['retrieve-knowledge', 'completed'],
    ]);
  });

  it('allows an unchanged legacy Run snapshot to retrieve without the processing skill', async () => {
    const activities: KnowledgeSkillActivity[] = [];
    await expect(executeKnowledgeRetrievalSkills({
      registry: registryFor(['retrieve-knowledge']),
      runId: 'run-legacy-search',
      report: (activity) => activities.push(activity),
      synchronize: async () => ({ changedFileIds: [], deletedFileIds: [], failedFileIds: [] }),
      retrieve: () => 'existing evidence',
    })).resolves.toBe('existing evidence');
    expect(activities.some((activity) => activity.skillId === 'process-knowledge-files')).toBe(false);
  });

  it('shows incremental file processing before retrieval when a source changed', async () => {
    const activities: KnowledgeSkillActivity[] = [];
    const result = await executeKnowledgeRetrievalSkills({
      registry: registryFor(['process-knowledge-files', 'retrieve-knowledge']),
      runId: 'run-refresh-search',
      report: (activity) => activities.push(activity),
      synchronize: async (onChangesDetected) => {
        const change = { changedFileIds: ['file-1'], deletedFileIds: [], failedFileIds: [] };
        onChangesDetected(change);
        return change;
      },
      retrieve: () => 'fresh evidence',
    });

    expect(result).toBe('fresh evidence');
    expect(activities.map((activity) => [activity.skillId, activity.status])).toEqual([
      ['process-knowledge-files', 'running'],
      ['process-knowledge-files', 'completed'],
      ['retrieve-knowledge', 'running'],
      ['retrieve-knowledge', 'completed'],
    ]);
    expect(activities[0]?.id).toBe(activities[1]?.id);
  });

  it('refuses to execute a knowledge workflow when its Run snapshot lacks the skill', async () => {
    await expect(executeKnowledgeRetrievalSkills({
      registry: registryFor(['process-knowledge-files']),
      runId: 'run-other-agent',
      report: () => undefined,
      synchronize: async () => ({ changedFileIds: [], deletedFileIds: [], failedFileIds: [] }),
      retrieve: () => 'should not run',
    })).rejects.toThrow('retrieve-knowledge');
  });
});
