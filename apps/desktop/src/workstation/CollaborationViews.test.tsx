import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactPane, MarkdownMessage, RunActivity, type RoomArtifact } from './CollaborationViews';

describe('群聊呈现', () => {
  it('安全呈现 Markdown 表格、代码和链接', () => {
    render(<MarkdownMessage text={'**结论**\n\n| 项目 | 数值 |\n| --- | --- |\n| 收入 | 42 |\n\n```ts\nconst ok = true\n```\n\n[资料](https://example.com)\n\n<script>alert(1)</script>'} />);
    expect(screen.getByText('结论').tagName).toBe('STRONG');
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('const ok = true')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '资料' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(document.querySelector('script')).toBeNull();
  });

  it('使用服务端运行步骤和事件更新状态，日志行可展开', () => {
    const cancel = vi.fn();
    render(<RunActivity run={{ id: 'run-1', status: 'waiting_tool', currentAgent: '材料编写智能体' }} steps={[{ id: 'step-1', step_index: 1, title: '编写文档', instruction: '整理正文', status: 'running', agent_snapshot: { name: '材料编写智能体' } }]} events={[{ sequence: 1, run_id: 'run-1', kind: 'tool.queued', payload: { tool: 'local_write', location: 'local' }, created_at: '2026-10-10T01:00:00Z' }]} submitting={false} onCancel={cancel} />);
    expect(screen.getByRole('button', { name: /调用工具中/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /编写文档/ }));
    expect(screen.getByText(/材料编写智能体 · 整理正文/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /准备调用 local_write/ }));
    expect(screen.getByText(/工具：local_write/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '终止生成' }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('成果面板切换文件并隔离 HTML 预览', () => {
    const artifacts: RoomArtifact[] = [
      { id: 'a', name: '报告.html', mimeType: 'text/html', content: '<h1>报告</h1>', sizeBytes: 15, createdAt: '2026-10-10T01:00:00Z' },
      { id: 'b', name: '说明.md', mimeType: 'text/markdown', content: '# 说明', sizeBytes: 6, createdAt: '2026-10-10T01:00:00Z' },
    ];
    const select = vi.fn();
    const collapse = vi.fn();
    const download = vi.fn();
    const close = vi.fn();
    const { rerender } = render(<ArtifactPane artifacts={artifacts} selected={artifacts[0]} loading={false} collapsed={false} onSelect={select} onCollapse={collapse} onClose={close} onDownload={download} />);
    expect(document.querySelector('iframe[title="报告.html"]')).toHaveAttribute('sandbox', '');
    fireEvent.click(screen.getByRole('button', { name: '说明.md' }));
    expect(select).toHaveBeenCalledWith('b');
    rerender(<ArtifactPane artifacts={artifacts} selected={artifacts[1]} loading={false} collapsed={false} onSelect={select} onCollapse={collapse} onClose={close} onDownload={download} />);
    expect(screen.getByRole('heading', { name: '说明' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下载' }));
    expect(download).toHaveBeenCalledWith(artifacts[1]);
    fireEvent.click(screen.getByTitle('收起预览'));
    expect(collapse).toHaveBeenCalledOnce();
  });
});
