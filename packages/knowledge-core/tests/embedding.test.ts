import { describe, expect, it } from 'vitest';
import { cosineSimilarity, embedTextLocally } from '../src/embedding';

describe('local embedding', () => {
  it('creates normalized deterministic vectors', () => {
    const first = embedTextLocally('知识图谱和知识检索');
    const second = embedTextLocally('知识图谱和知识检索');
    expect(first).toEqual(second);
    expect(first).toHaveLength(384);
    expect(cosineSimilarity(first, second)).toBeCloseTo(1, 5);
  });

  it('ranks overlapping multilingual content above unrelated content', () => {
    const query = embedTextLocally('公司经营分析');
    const related = embedTextLocally('公司经营情况与财务分析报告');
    const unrelated = embedTextLocally('前端按钮颜色设计');
    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated));
  });
});
