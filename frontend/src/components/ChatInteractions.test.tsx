import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownMessage } from './MarkdownMessage';
import { VirtualMessageList, type RunningAgentBubble } from './VirtualMessageList';
import { getAgentTone } from './AgentAvatar';

const createdAt = '2026-08-16T08:00:00.000Z';

describe('chat message interactions', () => {
  it('routes a web link to the host preview instead of navigating the page', async () => {
    const onOpenLink = vi.fn();
    render(<MarkdownMessage content="[查看网页](https://example.com/report)" onOpenLink={onOpenLink} />);

    await userEvent.click(screen.getByRole('link', { name: '查看网页' }));

    expect(onOpenLink).toHaveBeenCalledWith('https://example.com/report');
  });

  it('opens the reply action from the message context menu', async () => {
    const onReplyMessage = vi.fn();
    const message = {
      id: 'question-1',
      senderType: 'agent',
      senderId: 'researcher-1',
      kind: 'text',
      contentJson: JSON.stringify({ text: '请告诉我所在城市' }),
      status: 'sent',
      createdAt,
    };
    render(<VirtualMessageList
      messages={[message]}
      projectAgents={[{ id: 'researcher-1', agentName: '资料调研智能体' }]}
      hasMore={false}
      loading={false}
      projectId="project-1"
      onLoadMore={() => {}}
      onRetryRun={() => {}}
      onReplyMessage={onReplyMessage}
    />);

    fireEvent.contextMenu(screen.getByText('请告诉我所在城市'));
    await userEvent.click(screen.getByRole('menuitem', { name: '回复消息' }));

    expect(onReplyMessage).toHaveBeenCalledWith(message);
  });

  it('renders the referenced message above a quoted reply', () => {
    render(<VirtualMessageList
      messages={[
        {
          id: 'question-1',
          senderType: 'agent',
          senderId: 'researcher-1',
          kind: 'text',
          contentJson: JSON.stringify({ text: '请告诉我所在城市' }),
          status: 'sent',
          createdAt,
        },
        {
          id: 'answer-1',
          senderType: 'user',
          senderId: 'local-user',
          kind: 'text',
          contentJson: JSON.stringify({ text: '我在上海' }),
          status: 'sent',
          replyToId: 'question-1',
          createdAt,
        },
      ]}
      projectAgents={[{ id: 'researcher-1', agentName: '资料调研智能体' }]}
      hasMore={false}
      loading={false}
      projectId="project-1"
      onLoadMore={() => {}}
      onRetryRun={() => {}}
      userProfile={{ nickname: '林岚' }}
    />);

    expect(screen.getAllByText('请告诉我所在城市')).toHaveLength(2);
    expect(screen.getByText('我在上海')).toBeInTheDocument();
  });

  it('truncates a long referenced message and preserves its full text as a tooltip', () => {
    const quotedText = `第一段内容\n${'这是一段很长的引用消息'.repeat(40)}`;
    const { container } = render(<VirtualMessageList
      messages={[
        {
          id: 'question-long', senderType: 'agent', senderId: 'researcher-1', kind: 'text',
          contentJson: JSON.stringify({ text: quotedText }), status: 'sent', createdAt,
        },
        {
          id: 'answer-long', senderType: 'user', senderId: 'local-user', kind: 'text',
          contentJson: JSON.stringify({ text: '收到' }), status: 'sent', replyToId: 'question-long', createdAt,
        },
      ]}
      projectAgents={[{ id: 'researcher-1', agentName: '资料调研智能体' }]}
      hasMore={false}
      loading={false}
      projectId="project-1"
      onLoadMore={() => {}}
      onRetryRun={() => {}}
    />);

    const reference = container.querySelector('.message-reply-reference span');
    expect(reference).toHaveAttribute('title', quotedText);
    expect(reference?.textContent?.length).toBeLessThanOrEqual(180);
    expect(reference?.textContent?.endsWith('…')).toBe(true);
  });

  it('scrolls to the newest user message after sending from message history', async () => {
    const message = {
      id: 'message-1',
      senderType: 'agent',
      senderId: 'researcher-1',
      kind: 'text',
      contentJson: JSON.stringify({ text: '历史消息' }),
      status: 'sent',
      createdAt,
    };
    const props = {
      messages: [message],
      projectAgents: [{ id: 'researcher-1', agentName: '资料调研智能体' }],
      hasMore: false,
      loading: false,
      projectId: 'project-1',
      onLoadMore: () => {},
      onRetryRun: () => {},
    };
    const { container, rerender } = render(<VirtualMessageList {...props} scrollToBottomSignal={null} />);
    const stream = container.querySelector('.message-stream') as HTMLDivElement;
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 1_200 });
    Object.defineProperty(stream, 'clientHeight', { configurable: true, value: 400 });
    stream.scrollTop = 120;

    rerender(<VirtualMessageList {...props} scrollToBottomSignal="user-message-2" />);

    await waitFor(() => expect(stream.scrollTop).toBe(1_200));
  });

  it('renders mixed image, video, audio and text Markdown', () => {
    const { container } = render(<MarkdownMessage content={[
      '现场资料如下：',
      '',
      '![现场图片](data:image/png;base64,AA==)',
      '',
      'https://cdn.example.com/chart.png?token=abc',
      '',
      '[播放视频](app-file:///outputs/demo.mp4)',
      '',
      '[播放音频](app-file:///outputs/demo.mp3)',
    ].join('\n')} />);

    expect(screen.getByText('现场资料如下：')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '现场图片' })).toBeInTheDocument();
    expect(container.querySelector('img[src="https://cdn.example.com/chart.png?token=abc"]')).toBeInTheDocument();
    expect(container.querySelector('video')).toHaveAttribute('src', 'app-file:///outputs/demo.mp4');
    expect(container.querySelector('audio')).toHaveAttribute('src', 'app-file:///outputs/demo.mp3');
  });

  it('shows a running-agent bubble with animated hint while an agent is executing', () => {
    const agent: RunningAgentBubble = { id: 'researcher-1', name: '资料调研智能体', tone: getAgentTone('researcher-1', ['researcher-1']), streamingText: '' };
    const { container } = render(<VirtualMessageList
      messages={[{
        id: 'question-1', senderType: 'user', senderId: 'local-user', kind: 'text',
        contentJson: JSON.stringify({ text: '帮我调研市场信息' }), status: 'sent', createdAt,
      }]}
      projectAgents={[{ id: 'researcher-1', agentName: '资料调研智能体' }]}
      hasMore={false}
      loading={false}
      projectId="project-1"
      onLoadMore={() => {}}
      onRetryRun={() => {}}
      runningAgents={[agent]}
    />);

    expect(screen.getByRole('status', { name: '资料调研智能体 正在执行任务' })).toBeInTheDocument();
    expect(screen.getByText('资料调研智能体 正在执行任务')).toBeInTheDocument();
    expect(screen.getByText('执行中')).toBeInTheDocument();
    const bubble = container.querySelector('.message-bubble--running');
    expect(bubble).toBeInTheDocument();
    expect(bubble?.querySelectorAll('.agent-running-hint__dots i')).toHaveLength(3);
    expect(bubble?.querySelector('.agent-running-hint__bar')).toBeInTheDocument();
  });

  it('streams agent output inside the running bubble without duplicating the sending placeholder', () => {
    const agent: RunningAgentBubble = {
      id: 'researcher-1',
      name: '资料调研智能体',
      tone: getAgentTone('researcher-1', ['researcher-1']),
      streamingText: '已完成市场调研，正在整理',
    };
    const { container } = render(<VirtualMessageList
      messages={[
        {
          id: 'question-1', senderType: 'user', senderId: 'local-user', kind: 'text',
          contentJson: JSON.stringify({ text: '帮我调研市场信息' }), status: 'sent', createdAt,
        },
        {
          id: 'streaming-1', senderType: 'agent', senderId: 'researcher-1', kind: 'text',
          contentJson: JSON.stringify({ text: '已完成市场调研，正在整理' }), status: 'sending', createdAt,
        },
      ]}
      projectAgents={[{ id: 'researcher-1', agentName: '资料调研智能体' }]}
      hasMore={false}
      loading={false}
      projectId="project-1"
      onLoadMore={() => {}}
      onRetryRun={() => {}}
      runningAgents={[agent]}
    />);

    // 流式文本只在执行气泡内出现一次（sending 占位被气泡接管，不再单独渲染）。
    expect(screen.getAllByText(/已完成市场调研/)).toHaveLength(1);
    expect(screen.getAllByText(/已完成市场调研/)[0]?.closest('.message-bubble--running')).toBeInTheDocument();
    expect(container.querySelector('.message-streaming-caret')).toBeInTheDocument();
    // 气泡切换为流式输出后不再显示执行动画提示。
    expect(screen.queryByText('资料调研智能体 正在执行任务')).not.toBeInTheDocument();
  });

  it('removes the running bubble once the agent run finishes', () => {
    const { rerender } = render(<VirtualMessageList
      messages={[{
        id: 'answer-1', senderType: 'agent', senderId: 'researcher-1', kind: 'text',
        contentJson: JSON.stringify({ text: '调研完成，报告如下' }), status: 'sent', createdAt,
      }]}
      projectAgents={[{ id: 'researcher-1', agentName: '资料调研智能体' }]}
      hasMore={false}
      loading={false}
      projectId="project-1"
      onLoadMore={() => {}}
      onRetryRun={() => {}}
      runningAgents={[{ id: 'researcher-1', name: '资料调研智能体', tone: getAgentTone('researcher-1', ['researcher-1']), streamingText: '' }]}
    />);

    rerender(<VirtualMessageList
      messages={[{
        id: 'answer-1', senderType: 'agent', senderId: 'researcher-1', kind: 'text',
        contentJson: JSON.stringify({ text: '调研完成，报告如下' }), status: 'sent', createdAt,
      }]}
      projectAgents={[{ id: 'researcher-1', agentName: '资料调研智能体' }]}
      hasMore={false}
      loading={false}
      projectId="project-1"
      onLoadMore={() => {}}
      onRetryRun={() => {}}
    />);

    expect(screen.queryByRole('status', { name: '资料调研智能体 正在执行任务' })).not.toBeInTheDocument();
    expect(screen.getByText('调研完成，报告如下')).toBeInTheDocument();
  });
});
