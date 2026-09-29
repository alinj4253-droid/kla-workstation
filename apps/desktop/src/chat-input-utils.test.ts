import { describe, expect, it } from 'vitest';
import { displayAgentText, extractMentions, findMentionContext, formatReplyPreview, insertComposerNewline, replaceMention } from './chat-input-utils';

const agents = [
  { id: 'group-orch', agentName: '统筹管理智能体' },
  { id: 'group-knowledge', agentName: '知识管理智能体' },
];

describe('chat input utils', () => {
  it('opens mention context at the beginning, middle or end of text', () => {
    expect(findMentionContext('@知', 2)).toEqual({ start: 0, end: 2, query: '知' });
    expect(findMentionContext('请让@知', 4)).toEqual({ start: 2, end: 4, query: '知' });
    expect(findMentionContext('先处理，然后@', 7)).toEqual({ start: 6, end: 7, query: '' });
  });

  it('replaces only the mention query at the caret and preserves surrounding text', () => {
    const context = findMentionContext('请让@知处理', 4)!;
    expect(replaceMention('请让@知处理', context, '知识管理智能体')).toEqual({
      value: '请让@知识管理智能体 处理',
      caret: 11,
    });
  });

  it('extracts exact display-name mentions and prefers the longest overlap', () => {
    expect(extractMentions('请 @知识管理智能体 处理，然后说明统筹管理智能体的职责', agents)).toEqual([
      expect.objectContaining({ target: { scope: 'instance', id: 'group-knowledge' }, label: '知识管理智能体' }),
    ]);
  });

  it('does not confirm a mention when the matched name continues into an unknown name', () => {
    expect(extractMentions('请 @知识管理智能体助手 处理', agents)).toEqual([]);
    expect(extractMentions('请处理完后告知 @知识管理智能体', agents)).toEqual([
      expect.objectContaining({ target: { scope: 'instance', id: 'group-knowledge' }, label: '知识管理智能体' }),
    ]);
  });

  it('supports ctrl-enter newline insertion and display-name sanitization', () => {
    expect(insertComposerNewline('前后', 1, 1)).toEqual({ value: '前\n后', caret: 2 });
    expect(displayAgentText('等待 group-knowledge 回复', agents)).toBe('等待 知识管理智能体 回复');
  });

  it('compacts and truncates long quoted message previews', () => {
    const preview = formatReplyPreview(`第一行\n\n${'很长的引用内容'.repeat(50)}`, 40);
    expect(preview).toHaveLength(40);
    expect(preview).not.toContain('\n');
    expect(preview.endsWith('…')).toBe(true);
  });
});
