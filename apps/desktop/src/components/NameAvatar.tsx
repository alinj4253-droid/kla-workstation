function avatarText(name: string): string {
  const clean = Array.from(name.trim().replace(/\s+/g, '')).slice(0, 2).join('');
  return clean || '--';
}

function avatarTone(name: string): number {
  return Array.from(name).reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0) % 6;
}

export function NameAvatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }): React.JSX.Element {
  return <span className={`name-avatar name-avatar--${size} name-avatar--tone-${avatarTone(name)}`} aria-hidden="true">{avatarText(name)}</span>;
}
