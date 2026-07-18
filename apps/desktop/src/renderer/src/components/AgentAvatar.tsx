type AgentAvatarProps = {
  label: string;
  tone: 'indigo' | 'cyan' | 'green' | 'violet' | 'orange';
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
