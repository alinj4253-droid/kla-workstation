import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { AgentRunRepository, FileRepository, MessageRepository } from '@kunqing/database';
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

/**
 * A model response is descriptive text, not filesystem authority.  Keep the
 * useful prose but remove inline HTML and path-only artifact claims.  Actual
 * files are accepted exclusively through `additionalPaths`, populated by a
 * successful system tool call and verified by `publishExisting`.
 */
function sanitizeUntrustedArtifactClaims(text: string): string {
  let clean = text.replace(INLINE_HTML_RE, '（HTML 内容未通过系统文件工具保存，未作为成果交付）');
  clean = clean.replace(/<!doctype\s+html[\s\S]*?<\/html>|<html\b[\s\S]*?<\/html>/giu, '（HTML 内容未通过系统文件工具保存，未作为成果交付）');
  clean = clean.replace(/^\s*ARTIFACT:\s*.+$/gimu, '');
  clean = clean.replace(/(?:^|[\s`'"（(])(?:\.\/)?outputs[\\/][^\s`'"<>|:*?]+?\.(?:html?|pdf|md|txt|json|csv|png|jpe?g|webp|gif|docx?|xlsx?|pptx?|zip)(?![\p{L}\p{N}_.-])(?:[，,。；;]\s*(?:可直接查看|请查看|可在此查看))?/gimu, (_match) => '（文本路径声明未作为交付依据）');
  return clean.replace(/\n{3,}/g, '\n\n').trim();
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

    const artifactRows = this.db.prepare(
      `SELECT m.id, m.status, m.created_at AS createdAt, m.content_json AS contentJson,
              ma.file_id as fileId, ma.version_id as versionId
       FROM messages m
       JOIN message_attachments ma ON ma.message_id = m.id
       WHERE m.project_id = ? AND m.kind = 'artifact'
       ORDER BY m.created_at DESC LIMIT 250`,
    ).all(input.projectId) as Array<{
      id: string; status: string; createdAt: string; contentJson: string; fileId: string; versionId: string;
    }>;
    const existingMessage = artifactRows.find((row) => {
      if (input.triggerMessageId) {
        try {
          const content = JSON.parse(row.contentJson) as { triggerMessageId?: unknown; sha256?: unknown };
          return content.triggerMessageId === input.triggerMessageId && content.sha256 === sha256;
        } catch {
          return false;
        }
      }
      return row.fileId === file.id && row.versionId === version.id;
    });
    if (existingMessage) {
      let existingPath = normalized;
      try {
        const content = JSON.parse(existingMessage.contentJson) as { text?: unknown };
        if (typeof content.text === 'string' && content.text) existingPath = content.text;
      } catch { /* keep normalized path */ }
      this.recordArtifactEvent(input, {
        messageId: existingMessage.id,
        fileId: existingMessage.fileId,
        versionId: existingMessage.versionId,
        relativePath: existingPath,
      }, sha256, true);
      return {
        messageId: existingMessage.id,
        fileId: existingMessage.fileId,
        versionId: existingMessage.versionId,
        relativePath: existingPath,
      };
    }

    const contentJson = JSON.stringify({
      schemaVersion: 1,
      text: normalized,
      fileId: file.id,
      versionId: version.id,
      runId: input.runId,
      ...(input.triggerMessageId ? { triggerMessageId: input.triggerMessageId } : {}),
      sha256,
    });
    const message = input.triggerMessageId
      ? (() => {
        const id = createHash('sha256')
          .update(`artifact-message:${input.projectId}:${input.triggerMessageId}:${sha256}`)
          .digest('hex').slice(0, 24);
        const createdAt = new Date().toISOString();
        this.db.prepare(
          `INSERT OR IGNORE INTO messages
             (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at)
           VALUES (?, ?, 'agent', ?, 'artifact', ?, 'sent', ?, ?)`,
        ).run(id, input.projectId, input.agentInstanceId, contentJson, createdAt, createdAt);
        this.db.prepare(
          'INSERT OR IGNORE INTO message_attachments (message_id, file_id, version_id, ordinal) VALUES (?, ?, ?, 0)',
        ).run(id, file.id, version.id);
        return { id, status: 'sent', createdAt };
      })()
      : this.messageRepo.createArtifactMessage(input.projectId, normalized, file.id, version.id, input.agentInstanceId);
    if (!input.triggerMessageId) {
      this.db.prepare('UPDATE messages SET content_json = ? WHERE id = ?').run(contentJson, message.id);
    }
    this.recordArtifactEvent(input, {
      messageId: message.id,
      fileId: file.id,
      versionId: version.id,
      relativePath: normalized,
    }, sha256, false);
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

  private recordArtifactEvent(
    input: { projectId: string; agentInstanceId: string; runId: string; triggerMessageId?: string },
    artifact: { messageId: string; fileId: string; versionId: string; relativePath: string },
    sha256: string,
    reused: boolean,
  ): void {
    try {
      new AgentRunRepository(this.db).addEvent(input.runId, 'run.artifact-published', {
        ...artifact,
        sha256,
        reused,
        ...(input.triggerMessageId ? { triggerMessageId: input.triggerMessageId } : {}),
      });
    } catch {
      // Isolated publisher tests and legacy databases may not contain Run tables.
    }
  }

  async publishFromOutput(input: {
    projectId: string;
    agentInstanceId: string;
    runId: string;
    triggerMessageId?: string;
    text: string;
    additionalPaths?: string[];
  }): Promise<{ text: string; publishedPaths: string[]; failedPaths: string[] }> {
    const prepared = prepareAgentOutput(input.text);
    const publishedPaths: string[] = [];
    const failedPaths: string[] = [];

    // Only paths supplied by the host after a successful file-writing tool
    // call are authoritative.  Never infer a file from ordinary model text.
    const paths = [...new Set(input.additionalPaths ?? [])];
    const trustedPathSet = new Set(paths.map((path) => cleanReferencedPath(path)));
    // Keep an explicit diagnostic for a path mentioned by the model, while
    // ensuring it never reaches publishExisting unless the host supplied it
    // as a trusted path too.
    const untrustedPaths = prepared.referencedPaths
      .map(cleanReferencedPath)
      .filter((path) => path && !trustedPathSet.has(path));
    for (const relativePath of paths) {
      const normalizedPath = cleanReferencedPath(relativePath);
      try {
        const result = await this.publishExisting({ ...input, relativePath });
        publishedPaths.push(result.relativePath);
      } catch {
        if (!failedPaths.includes(normalizedPath)) failedPaths.push(normalizedPath);
      }
    }

    const publishedSet = new Set(publishedPaths);
    const failedSet = new Set(failedPaths);
    // Never leave a model-generated success claim for a path that could not be
    // written and verified. Keep the path visible only as an explicit failure
    // so the coordinator can retry or choose another delivery route.
    const sanitizedLines = sanitizeUntrustedArtifactClaims(input.text).split(/\r?\n/);
    const missingPathNotes = publishedPaths.filter((filePath) => !prepared.text.includes(filePath));
    const failureNotes = [...new Set([...untrustedPaths, ...failedSet])].filter((filePath) => !publishedSet.has(filePath));
    const text = [
      sanitizedLines.join('\n').trim(),
      missingPathNotes.length > 0 ? `已生成成果文件：${missingPathNotes.join('、')}` : '',
      failureNotes.length > 0 ? `成果文件写入或发布失败，未交付：${failureNotes.join('、')}` : '',
    ].filter(Boolean).join('\n\n');
    return { text, publishedPaths, failedPaths: [...new Set([...untrustedPaths, ...failedSet])] };
  }
}
