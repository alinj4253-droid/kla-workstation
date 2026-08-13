import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { FileRepository, MessageRepository } from '@kunqing/database';
import { getProjectRoot } from './paths';

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const INLINE_HTML_RE = /:::artifact\{path=(?:"([^"]+\.html?)"|'([^']+\.html?)')\}\s*\r?\n([\s\S]*?)\r?\n:::/gi;
const EXISTING_OUTPUT_RE = /((?:\.\/)?outputs[\\/][^\s`'"<>|:*?]+?\.(?:html?|pdf|md|txt|json|csv|png|jpe?g|webp|gif|docx?|xlsx?|pptx?|zip))(?![\p{L}\p{N}_.-])/giu;

export interface PreparedAgentOutput {
  text: string;
  inlineHtml: Array<{ relativePath: string; content: string }>;
  referencedPaths: string[];
}

export interface ArtifactMessageEvent {
  type: 'message.created';
  projectId: string;
  runId: string;
  triggerMessageId?: string;
  message: {
    id: string;
    senderType: 'agent';
    senderId: string;
    kind: 'artifact';
    contentJson: string;
    status: string;
    createdAt: string;
  };
}

function cleanReferencedPath(value: string): string {
  return value.trim().replace(/^[`'"\s]+|[`'"\s]+$/g, '').replaceAll('\\', '/');
}

export function prepareAgentOutput(text: string): PreparedAgentOutput {
  const inlineHtml: Array<{ relativePath: string; content: string }> = [];
  const referencedPaths: string[] = [];
  const seen = new Set<string>();

  let cleanText = text.replace(INLINE_HTML_RE, (_whole, doubleQuoted: string | undefined, singleQuoted: string | undefined, content: string) => {
    const relativePath = cleanReferencedPath(doubleQuoted ?? singleQuoted ?? '');
    inlineHtml.push({ relativePath, content });
    if (!seen.has(relativePath)) {
      seen.add(relativePath);
      referencedPaths.push(relativePath);
    }
    return `已生成成果文件：${relativePath}`;
  });

  // 兼容未遵循 artifact 协议、直接输出完整 HTML 的智能体：自动落盘，只在群聊中保留文件说明。
  if (inlineHtml.length === 0) {
    const rawHtml = cleanText.match(/<!doctype\s+html[\s\S]*?<\/html>/i)?.[0]
      ?? cleanText.match(/<html\b[\s\S]*?<\/html>/i)?.[0];
    if (rawHtml) {
      const hash = createHash('sha256').update(rawHtml).digest('hex').slice(0, 10);
      const relativePath = `outputs/generated-${hash}.html`;
      inlineHtml.push({ relativePath, content: rawHtml });
      referencedPaths.push(relativePath);
      seen.add(relativePath);
      cleanText = cleanText.replace(rawHtml, `已生成成果文件：${relativePath}`);
    }
  }

  for (const match of cleanText.matchAll(/^\s*ARTIFACT:\s*(.+?)\s*$/gim)) {
    const relativePath = cleanReferencedPath(match[1] ?? '');
    if (relativePath && !seen.has(relativePath)) {
      seen.add(relativePath);
      referencedPaths.push(relativePath);
    }
  }

  // 外部 CLI 经常只在自然回复中给出已生成文件的相对路径。
  // 只接受 outputs/ 下的常见交付物，后续仍由 normalizeOutputPath 做越界校验。
  for (const match of text.matchAll(EXISTING_OUTPUT_RE)) {
    const relativePath = cleanReferencedPath(match[1] ?? '');
    if (relativePath && !seen.has(relativePath)) {
      seen.add(relativePath);
      referencedPaths.push(relativePath);
    }
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed) as { type?: string; sandboxRelativePath?: string; relativePath?: string };
      if (event.type !== 'artifact.proposed') continue;
      const relativePath = cleanReferencedPath(event.relativePath ?? event.sandboxRelativePath ?? '');
      if (relativePath && !seen.has(relativePath)) {
        seen.add(relativePath);
        referencedPaths.push(relativePath);
      }
    } catch { /* 普通文本行 */ }
  }

  cleanText = cleanText.replace(/^\s*ARTIFACT:\s*.+?\s*$/gim, '').replace(/\n{3,}/g, '\n\n').trim();

  return { text: cleanText, inlineHtml, referencedPaths };
}

function normalizeOutputPath(relativePath: string): string {
  const normalized = cleanReferencedPath(relativePath).replace(/^\.\//, '');
  if (!normalized || isAbsolute(normalized) || normalized.includes('\0')) {
    throw new Error('成果文件路径不合法');
  }
  if (!normalized.startsWith('outputs/') || normalized.split('/').includes('..')) {
    throw new Error('成果文件必须位于 outputs/ 目录');
  }
  return normalized;
}

function resolveArtifactPath(projectId: string, relativePath: string): { normalized: string; absolute: string } {
  const normalized = normalizeOutputPath(relativePath);
  const root = resolve(getProjectRoot(projectId));
  const absolute = resolve(root, normalized);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new Error('成果文件路径超出群聊工作区');
  }
  return { normalized, absolute };
}

function mimeTypeForPath(relativePath: string): string {
  const ext = extname(relativePath).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html', '.htm': 'text/html', '.md': 'text/markdown', '.txt': 'text/plain',
    '.json': 'application/json', '.csv': 'text/csv', '.pdf': 'application/pdf',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}

export class AgentArtifactPublisher {
  private readonly fileRepo: FileRepository;
  private readonly messageRepo: MessageRepository;

  constructor(
    private readonly db: Database.Database,
    private readonly emit?: (event: ArtifactMessageEvent) => void,
  ) {
    this.fileRepo = new FileRepository(db);
    this.messageRepo = new MessageRepository(db);
  }

  async writeInlineHtml(projectId: string, relativePath: string, content: string): Promise<string> {
    const { normalized, absolute } = resolveArtifactPath(projectId, relativePath);
    if (!/\.html?$/i.test(normalized)) throw new Error('内联成果当前仅支持 HTML');
    const size = Buffer.byteLength(content, 'utf8');
    if (size > MAX_ARTIFACT_BYTES) throw new Error('HTML 成果文件超过 50 MB');
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
    return normalized;
  }

  async publishExisting(input: {
    projectId: string;
    agentInstanceId: string;
    runId: string;
    triggerMessageId?: string;
    relativePath: string;
    note?: string;
  }): Promise<{ messageId: string; fileId: string; versionId: string; relativePath: string }> {
    const { normalized, absolute } = resolveArtifactPath(input.projectId, input.relativePath);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('成果路径不是可发布的普通文件');
    if (info.size > MAX_ARTIFACT_BYTES) throw new Error('成果文件超过 50 MB');

    const buffer = await readFile(absolute);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    let file = this.fileRepo.getByPath('project', input.projectId, normalized);
    if (!file) {
      file = this.fileRepo.create({
        scopeType: 'project',
        scopeId: input.projectId,
        parentId: dirname(normalized) === '.' ? null : dirname(normalized).replaceAll('\\', '/'),
        type: 'file',
        name: basename(normalized),
        normalizedPath: normalized,
        mimeType: mimeTypeForPath(normalized),
        origin: 'artifact',
      });
    } else if (file.status !== 'ready') {
      this.fileRepo.update(file.id, { status: 'ready', mimeType: mimeTypeForPath(normalized) });
    }

    const current = this.fileRepo.getCurrentVersion(file.id);
    const version = current?.sha256 === sha256
      ? current
      : this.fileRepo.createVersion({
        fileId: file.id,
        storageRelPath: normalized,
        size: info.size,
        sha256,
        createdByType: 'agent',
        createdById: input.agentInstanceId,
        runId: input.runId,
        changeNote: input.note ?? '智能体发送到群聊',
      });

    const existingMessage = this.db.prepare(
      `SELECT m.id, m.status, m.created_at AS createdAt, m.content_json AS contentJson
       FROM messages m
       JOIN message_attachments ma ON ma.message_id = m.id
       WHERE m.project_id = ? AND m.sender_id = ? AND m.kind = 'artifact'
         AND ma.file_id = ? AND ma.version_id = ?
       ORDER BY m.created_at DESC LIMIT 1`,
    ).get(input.projectId, input.agentInstanceId, file.id, version.id) as { id: string; status: string; createdAt: string; contentJson: string } | undefined;
    if (existingMessage) {
      this.emit?.({
        type: 'message.created',
        projectId: input.projectId,
        runId: input.runId,
        ...(input.triggerMessageId ? { triggerMessageId: input.triggerMessageId } : {}),
        message: {
          id: existingMessage.id,
          senderType: 'agent',
          senderId: input.agentInstanceId,
          kind: 'artifact',
          contentJson: existingMessage.contentJson,
          status: existingMessage.status,
          createdAt: existingMessage.createdAt,
        },
      });
      return { messageId: existingMessage.id, fileId: file.id, versionId: version.id, relativePath: normalized };
    }

    const message = this.messageRepo.createArtifactMessage(input.projectId, normalized, file.id, version.id, input.agentInstanceId);
    const contentJson = JSON.stringify({ schemaVersion: 1, text: normalized, fileId: file.id, versionId: version.id });
    this.emit?.({
      type: 'message.created',
      projectId: input.projectId,
      runId: input.runId,
      ...(input.triggerMessageId ? { triggerMessageId: input.triggerMessageId } : {}),
      message: {
        id: message.id,
        senderType: 'agent',
        senderId: input.agentInstanceId,
        kind: 'artifact',
        contentJson,
        status: message.status,
        createdAt: message.createdAt,
      },
    });

    return { messageId: message.id, fileId: file.id, versionId: version.id, relativePath: normalized };
  }

  async publishFromOutput(input: {
    projectId: string;
    agentInstanceId: string;
    runId: string;
    triggerMessageId?: string;
    text: string;
    additionalPaths?: string[];
  }): Promise<{ text: string; publishedPaths: string[] }> {
    const prepared = prepareAgentOutput(input.text);
    const publishedPaths: string[] = [];

    for (const artifact of prepared.inlineHtml) {
      try {
        await this.writeInlineHtml(input.projectId, artifact.relativePath, artifact.content);
      } catch { /* 无效成果不会阻断智能体文本回复 */ }
    }

    const paths = [...new Set([...prepared.referencedPaths, ...(input.additionalPaths ?? [])])];
    for (const relativePath of paths) {
      try {
        const result = await this.publishExisting({ ...input, relativePath });
        publishedPaths.push(result.relativePath);
      } catch { /* 文件不存在或越界时忽略，文本回复仍正常提交 */ }
    }

    const missingPathNotes = publishedPaths.filter((filePath) => !prepared.text.includes(filePath));
    const text = missingPathNotes.length > 0
      ? [prepared.text, `已生成成果文件：${missingPathNotes.join('、')}`].filter(Boolean).join('\n\n')
      : prepared.text;
    return { text, publishedPaths };
  }
}
