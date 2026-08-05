import type { SpawnSpec } from '../external-agent-adapter';

export type SpawnInvocation = {
  executable: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

/**
 * 判断该调用是否需要在 Windows 上经 cmd.exe 解析。
 * 裸命令名（如 `opencode`，可能解析为 PATH 上的 .cmd shim）与
 * .cmd/.bat 脚本都必须交给 cmd；.exe/.com 可由 CreateProcess 直接启动。
 */
export function shouldUseCmdShim(executable: string, shell: boolean, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && shell && !/\.(?:exe|com)$/i.test(executable);
}

/**
 * 将 SpawnSpec 转换为安全的 spawn 调用。永不启用 shell: true；
 * Windows 上需要 cmd 解析的命令改用 cmd.exe /d /s /c，并对每个参数
 * 做双引号包裹 + 引号翻倍，使 & | < > ^ 等元字符与内嵌引号/换行仅作为
 * 文本传递，避免命令注入与参数损坏。
 */
export function buildSpawnInvocation(spec: Pick<SpawnSpec, 'executable' | 'args' | 'shell'>): SpawnInvocation {
  if (shouldUseCmdShim(spec.executable, spec.shell)) {
    const comspec = process.env.ComSpec ?? 'cmd.exe';
    const quoted = [spec.executable, ...spec.args].map((p) => `"${p.replace(/"/g, '""')}"`).join(' ');
    return { executable: comspec, args: ['/d', '/s', '/c', `"${quoted}"`], windowsVerbatimArguments: true };
  }
  return { executable: spec.executable, args: spec.args };
}
