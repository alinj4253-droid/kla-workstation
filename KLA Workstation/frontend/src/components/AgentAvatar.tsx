export const AGENT_TONES = ['indigo', 'cyan', 'green', 'violet', 'orange', 'rose', 'teal', 'amber', 'blue'] as const;
export type AgentTone = typeof AGENT_TONES[number];

export function getAgentTone(agentId: string, orderedAgentIds: string[]): AgentTone {
  const ordinal = orderedAgentIds.indexOf(agentId);
  if (ordinal >= 0) return AGENT_TONES[ordinal % AGENT_TONES.length]!;
  const hash = [...agentId].reduce((total, char) => ((total * 31) + char.charCodeAt(0)) >>> 0, 0);
  return AGENT_TONES[hash % AGENT_TONES.length]!;
}

type AgentAvatarProps = {
  label: string;
  tone: AgentTone;
  size?: 'sm' | 'md' | 'lg';
  overlap?: boolean;
};

export function AgentAvatar({ label, tone, size = 'md', overlap = false }: AgentAvatarProps): React.JSX.Element {
  return (
    <span
      className={`agent-avatar agent-avatar--${tone} agent-avatar--${size}${overlap ? ' agent-avatar--overlap' : ''}`}
      aria-label={label}
      title={label}
    >
      {label.slice(0, 2).toUpperCase()}
    </span>
  );
}
