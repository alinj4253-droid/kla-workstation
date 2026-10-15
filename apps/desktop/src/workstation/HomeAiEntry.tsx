import { useRef } from 'react';
import { Paperclip, Sparkles } from 'lucide-react';
import { Badge, Panel } from './ui';
import './home-ai-entry.css';

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onAgent: () => void;
  onSkill: () => void;
  onAttachment: () => void;
  onModels: () => void;
};
const prompts = ['总结本周工作', '查询集团制度', '生成项目汇报', '拆解今天的任务'];

export function HomeAiEntry({ value, onChange, onSend, onAgent, onSkill, onAttachment, onModels }: Props): React.JSX.Element {
  const input = useRef<HTMLTextAreaElement>(null);
  return <Panel className="ws-home-ai-card" title="AI 工作入口 · 今天想完成什么？" subtitle="输入任务或问题，与智能体小组开始协作。" action={<Badge tone="green">当前已连接 DeepSeek-V3 与百炼核心模型</Badge>}>
    <div className="ws-home-composer">
      <div className="ws-home-composer-top"><div className="ws-proto-chatbar"><button type="button" onClick={onAgent}>@ 智能体</button><button type="button" onClick={onSkill}>/ 技能</button><button type="button" onClick={onAttachment}><Paperclip size={13} />附件</button></div><small id="ws-home-keyboard-hint" className="ws-home-keyboard-hint">Enter 发送 · Shift + Enter 换行</small></div>
      <textarea ref={input} className="ws-home-prompt" rows={3} aria-label="首页任务输入" aria-describedby="ws-home-keyboard-hint" placeholder="试试：帮我把上周的投资可行性评估整理成一页汇报…" value={value} onChange={event => onChange(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); onSend(); }
      }} />
      <div className="ws-proto-chatfoot"><div className="ws-chip-row">{prompts.map(prompt => <button type="button" key={prompt} onClick={() => { onChange(prompt); input.current?.focus(); }}>{prompt}</button>)}</div><button type="button" className="ws-primary ws-home-send" onClick={onSend}><Sparkles size={16} />发送</button></div>
    </div>
    <small className="ws-proto-note">已就绪：自动根据任务语义匹配最优模型并完成协同 <button type="button" onClick={onModels}>查看模型市场 →</button></small>
  </Panel>;
}
