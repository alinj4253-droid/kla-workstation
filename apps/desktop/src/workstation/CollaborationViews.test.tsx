import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactPane, MarkdownMessage, RunActivity, type RoomArtifact } from './CollaborationViews';

describe('群聊呈现', () => {
  afterEach(() => vi.restoreAllMocks());
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

  it('二进制成果使用实际文件预览，并在切换时释放资源', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:ppt-preview');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const artifacts: RoomArtifact[] = [
      { id: 'pdf', name: '方案.pdf', mimeType: 'application/pdf', content: btoa('%PDF-1.7'), contentEncoding: 'base64', sizeBytes: 8, createdAt: '' },
      { id: 'png', name: '预览.png', mimeType: 'image/png', content: btoa('png'), contentEncoding: 'base64', sizeBytes: 3, createdAt: '' },
    ];
    const props = { artifacts, loading: false, collapsed: false, onSelect: vi.fn(), onCollapse: vi.fn(), onClose: vi.fn(), onDownload: vi.fn() };
    const { rerender, unmount } = render(<ArtifactPane {...props} selected={artifacts[0]} />);
    expect(document.querySelector('iframe[title="方案.pdf"]')).toHaveAttribute('src', 'blob:ppt-preview');
    expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
    rerender(<ArtifactPane {...props} selected={artifacts[1]} />);
    expect(revoke).toHaveBeenCalledWith('blob:ppt-preview');
    expect(screen.getByRole('img', { name: '预览.png' })).toHaveAttribute('src', 'blob:ppt-preview');
    unmount();
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('PPTX 引导到相同文稿的真实 PDF，不用 HTML 代替幻灯片（对象存储：%s）', (stored) => {
    const artifacts: RoomArtifact[] = [
      { id: 'ppt', name: '方案.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', content: stored ? '' : btoa('PK'), storageKey: stored ? 'artifacts/ppt/content' : null, contentEncoding: 'base64', sizeBytes: 2, createdAt: '' },
      { id: 'old-pdf', name: '方案.pdf', mimeType: 'application/pdf', content: '', contentEncoding: 'base64', sizeBytes: 2, createdAt: '2026-10-09' },
      { id: 'pdf', name: '方案.pdf', mimeType: 'application/pdf', content: '', contentEncoding: 'base64', sizeBytes: 2, createdAt: '' },
    ];
    const select = vi.fn();
    render(<ArtifactPane artifacts={artifacts} selected={artifacts[0]} loading={false} collapsed={false} onSelect={select} onCollapse={vi.fn()} onClose={vi.fn()} onDownload={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '查看实际渲染的 PDF 预览' }));
    expect(select).toHaveBeenCalledWith('pdf');
    expect(document.querySelector('iframe')).toBeNull();
  });
});
