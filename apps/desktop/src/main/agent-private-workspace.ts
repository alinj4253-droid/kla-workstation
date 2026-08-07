import { access, cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { getStudioRoot } from './paths';

const safeSegment = (value: string): string => value.replace(/[^a-z0-9_-]/gi, '_').slice(0, 120) || 'agent';

async function copyDirectoryIfPresent(source: string, target: string): Promise<void> {
  try {
    await access(source);
  } catch {
    return;
  }
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}

async function writeSkillIndex(workspaceRoot: string): Promise<void> {
  const skillsRoot = join(workspaceRoot, 'skills');
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  const lines: string[] = ['# 自身技能索引', '', '先根据当前任务选择最相关的技能，只在需要时读取对应 SKILL.md。', ''];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const markdown = await readFile(join(skillsRoot, entry.name, 'SKILL.md'), 'utf8').catch(() => '');
    const description = markdown.match(/^description:\s*(.+)$/mi)?.[1]?.trim()
      ?? markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
      ?? entry.name;
    lines.push(`- ${entry.name}: ${description}`);
  }
  if (lines.length > 4) await writeFile(join(skillsRoot, 'INDEX.md'), `${lines.join('\n')}\n`, 'utf8');
}

/**
 * 为外部 CLI 智能体准备按 Run 隔离的执行目录。
 * 目录内只复制当前智能体自己的身份/记忆，以及允许协作使用的群聊输入副本。
 */
export async function prepareAgentPrivateWorkspace(input: {
  projectRoot: string;
  agentInstanceId: string;
  runId: string;
  agentName: string;
  definitionId?: string;
  definitionVersion?: string;
  /** 建议传入项目目录之外的系统临时目录，避免 CLI 通过相对路径遍历群聊根目录。 */
  runtimeRoot?: string;
}): Promise<string> {
  const workspaceRoot = join(
    input.runtimeRoot ?? join(input.projectRoot, '.runtime', 'agent-workspaces'),
    safeSegment(input.agentInstanceId),
    safeSegment(input.runId),
  );
  await mkdir(workspaceRoot, { recursive: true });

  await Promise.all([
    copyDirectoryIfPresent(join(input.projectRoot, 'agent-identities', input.agentInstanceId), join(workspaceRoot, 'identity')),
    copyDirectoryIfPresent(join(input.projectRoot, 'agent-memories', input.agentInstanceId), join(workspaceRoot, 'memory')),
    copyDirectoryIfPresent(join(input.projectRoot, 'original-files'), join(workspaceRoot, 'original-files')),
    copyDirectoryIfPresent(join(input.projectRoot, 'knowledge'), join(workspaceRoot, 'knowledge')),
    copyDirectoryIfPresent(join(input.projectRoot, 'graph-visualization'), join(workspaceRoot, 'graph-visualization')),
    ...(input.definitionId ? [
      copyDirectoryIfPresent(
        join(getStudioRoot(), 'agent-definitions', 'built-in', input.definitionId, input.definitionVersion ?? '1.0.0', 'skills'),
        join(workspaceRoot, 'skills'),
      ),
      copyDirectoryIfPresent(
        join(getStudioRoot(), 'agent-definitions', 'custom', input.definitionId, input.definitionVersion ?? '1.0.0', 'skills'),
        join(workspaceRoot, 'skills'),
      ),
    ] : []),
    mkdir(join(workspaceRoot, 'outputs'), { recursive: true }),
  ]);
  await writeSkillIndex(workspaceRoot);

  await writeFile(join(workspaceRoot, 'WORKSPACE.md'), `# ${input.agentName} 私有执行工作区

- \`identity/\`：仅包含当前智能体自己的身份与角色卡。
- \`memory/\`：仅包含当前智能体自己的短期、长期和会话记忆。
- \`skills/\`：仅包含当前智能体定义绑定的技能包，与群聊无关；先读 INDEX.md 选择技能，再按需读对应 SKILL.md。
- \`original-files/\`、\`knowledge/\`、\`graph-visualization/\`：本次任务允许读取的群聊输入副本。
- \`outputs/\`：成果输出目录；需要交付的文件必须写入这里。

禁止尝试访问当前目录之外的其他智能体身份或记忆。
`, 'utf8');

  return workspaceRoot;
}

/** 将隔离工作区中的成果文件同步回群聊 outputs，供成果发布与右侧预览使用。 */
export async function syncAgentPrivateOutputs(workspaceRoot: string, projectRoot: string): Promise<void> {
  await copyDirectoryIfPresent(join(workspaceRoot, 'outputs'), join(projectRoot, 'outputs'));
}

/** 列出本次 Run 实际生成的所有成果，不依赖 CLI 在回复文本中主动声明路径。 */
export async function listAgentPrivateOutputFiles(workspaceRoot: string): Promise<string[]> {
  const outputRoot = join(workspaceRoot, 'outputs');
  const files: Array<{ path: string; mtimeMs: number }> = [];

  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const info = await lstat(absolute);
        files.push({ path: `outputs/${relative(outputRoot, absolute).replaceAll('\\', '/')}`, mtimeMs: info.mtimeMs });
      }
    }
  };

  await walk(outputRoot);
  return files
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path))
    .map((file) => file.path);
}
