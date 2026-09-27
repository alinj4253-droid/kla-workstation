import type Database from 'better-sqlite3';
import { SearchRepository, AgentRunRepository } from '@kunqing/database';
import { getEnterpriseProjectRoot, getEnterpriseWorkspaceRoot, getProjectRoot, getProjectTempRunRoot } from './paths';
import { copyFile, readFile, writeFile, mkdir, readdir, stat, lstat, rename, rm } from 'node:fs/promises';
import { basename, extname, join, dirname, relative, resolve, sep } from 'node:path';
import type { Scheduler } from './scheduler';
import { ToolRegistry } from './tool-registry';
import { buildModelProfileSnapshot } from './project-creator';
import { SkillRegistry } from './skill-registry';
import { WorkflowRegistry } from './workflow-registry';
import { formatHybridKnowledgeResult, searchHybridKnowledge } from './hybrid-knowledge-search';
import { refreshKnowledgeBeforeSearch, resolveKnowledgeScopesForGroup } from './knowledge-sync';
import type { ModelGateway } from './model-gateway';
import { formatBochaSearchResults, searchBochaWeb } from './bocha-web-search';
import { AGENT_TASK_TIMEOUT_MS } from './agent-runtime-limits';
import { readStandardizedDocument } from './knowledge-standardized';
import { parseDocument } from '@kunqing/knowledge-core';
import { LocalOcrService } from './local-ocr';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

type ParallelSubtask = { query: string; label?: string };

const TEMP_FILE_NAME_RE = /^(?!\.)(?!.*\.\.)(?!.*[\\/\0\r\n])[\p{L}\p{N}._ -]{1,160}$/u;
const TEMP_TEXT_MAX_BYTES = 50 * 1024 * 1024;

async function atomicReplaceFile(stagedPath: string, destinationPath: string): Promise<void> {
  try {
    await rename(stagedPath, destinationPath);
  } catch (error) {
    // Windows can reject rename when the destination already exists. Remove
    // only the validated file inside the task directory, then retry.
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST' && (error as NodeJS.ErrnoException)?.code !== 'EPERM') throw error;
    await rm(destinationPath, { force: true });
    await rename(stagedPath, destinationPath);
  }
}

function rootRunIdFor(db: Database.Database, runId: string): string {
  const normalized = String(runId ?? '').trim();
  if (!normalized) throw new Error('当前任务缺少系统 Run ID');
  try {
    return new AgentRunRepository(db).getAncestorChain(normalized).at(-1)?.id ?? normalized;
  } catch {
    return normalized;
  }
}

function assertTempFileName(fileName: string): string {
  const normalized = String(fileName ?? '').trim().replaceAll('\\', '/');
  if (!TEMP_FILE_NAME_RE.test(normalized) || normalized.includes('/') || normalized.includes('..')) {
    throw new Error('临时文件名不合法：只能填写单个文件名，不能包含路径或 ..');
  }
  return normalized;
}

function resolveWorkspaceReadPath(projectId: string, relativePath: string): string {
  const normalized = String(relativePath ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
  const allowed = ['original-files/', 'outputs/', 'wiki/', 'knowledge/', 'temp/', 'agent-memories/', 'agent-identities/'];
  if (!normalized || normalized.includes('..') || !allowed.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error('工作区文件路径不合法或不在允许的目录内');
  }
  const root = resolve(getProjectRoot(projectId));
  const target = resolve(root, normalized);
  if (!target.startsWith(`${root}${sep}`)) throw new Error('工作区文件路径超出当前群聊工作区');
  return target;
}

function tempFilePath(db: Database.Database, projectId: string, runId: string, fileName: string): { root: string; fileName: string; path: string } {
  const normalizedName = assertTempFileName(fileName);
  const root = getProjectTempRunRoot(projectId, rootRunIdFor(db, runId));
  return { root, fileName: normalizedName, path: join(root, normalizedName) };
}

async function saveTempFile(db: Database.Database, args: Record<string, unknown>): Promise<string> {
  const projectId = String(args.projectId ?? '').trim();
  const runId = String(args.runId ?? '').trim();
  const content = typeof args.content === 'string' ? args.content : '';
  if (!projectId || !runId) return '临时文件保存失败：缺少当前项目或任务标识';
  if (Buffer.byteLength(content, 'utf8') > TEMP_TEXT_MAX_BYTES) return '临时文件保存失败：文件超过 50 MB';
  try {
    const target = tempFilePath(db, projectId, runId, String(args.fileName ?? ''));
    await mkdir(target.root, { recursive: true });
    const tempPath = `${target.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, content, 'utf8');
    await atomicReplaceFile(tempPath, target.path);
    return `TEMP_SAVED: ${target.fileName}（${Buffer.byteLength(content, 'utf8')} bytes）`;
  } catch (error) {
    return `临时文件保存失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function readTempFile(db: Database.Database, args: Record<string, unknown>): Promise<string> {
  const projectId = String(args.projectId ?? '').trim();
  const runId = String(args.runId ?? '').trim();
  if (!projectId || !runId) return '临时文件读取失败：缺少当前项目或任务标识';
  try {
    const target = tempFilePath(db, projectId, runId, String(args.fileName ?? ''));
    const info = await lstat(target.path);
    if (!info.isFile() || info.isSymbolicLink()) return '临时文件读取失败：目标不是普通文件';
    const content = await readFile(target.path, 'utf8');
    const maxChars = Math.min(Math.max(Number(args.maxChars) || 12000, 1000), 50000);
    const cursor = Math.min(Math.max(Number(args.cursor) || 0, 0), content.length);
    const end = Math.min(cursor + maxChars, content.length);
    return `TEMP_FILE: ${target.fileName}\nCURSOR: ${cursor}\nNEXT_CURSOR: ${end}\nREAD_COMPLETE: ${end >= content.length}\n\n${content.slice(cursor, end)}`;
  } catch (error) {
    return `临时文件读取失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function listTempFiles(db: Database.Database, args: Record<string, unknown>): Promise<string> {
  const projectId = String(args.projectId ?? '').trim();
  const runId = String(args.runId ?? '').trim();
  if (!projectId || !runId) return '临时文件列表读取失败：缺少当前项目或任务标识';
  try {
    const root = getProjectTempRunRoot(projectId, rootRunIdFor(db, runId));
    const entries = await readdir(root, { withFileTypes: true });
    const files = await Promise.all(entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink()).map(async (entry) => {
      const info = await lstat(join(root, entry.name));
      return `${entry.name}\t${info.size} bytes\t${info.mtime.toISOString()}`;
    }));
    return files.length > 0 ? `TEMP_FILES:\n${files.sort().join('\n')}` : 'TEMP_FILES: （当前任务还没有临时文件）';
  } catch (error) {
    return `临时文件列表读取失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function promoteTempFile(db: Database.Database, args: Record<string, unknown>): Promise<string> {
  const projectId = String(args.projectId ?? '').trim();
  const runId = String(args.runId ?? '').trim();
  if (!projectId || !runId) return '临时文件提升失败：缺少当前项目或任务标识';
  try {
    const source = tempFilePath(db, projectId, runId, String(args.fileName ?? ''));
    const sourceInfo = await lstat(source.path);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) return '临时文件提升失败：目标不是普通文件';
    const suppliedOutputName = String(args.outputName ?? '').trim();
    const outputName = suppliedOutputName ? assertTempFileName(suppliedOutputName) : source.fileName;
    const outputRoot = join(getProjectRoot(projectId), 'outputs');
    await mkdir(outputRoot, { recursive: true });
    const destination = join(outputRoot, outputName);
    const tempDestination = `${destination}.tmp-${process.pid}-${Date.now()}`;
    await copyFile(source.path, tempDestination);
    await atomicReplaceFile(tempDestination, destination);
    return `TEMP_PROMOTED: ${source.fileName} -> outputs/${outputName}`;
  } catch (error) {
    return `临时文件提升失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

const tempSaveParameters = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: '当前项目 ID，由系统自动补充' },
    runId: { type: 'string', description: '当前根 Run ID，由系统自动补充' },
    fileName: { type: 'string', description: '单个临时文件名，例如 outline.md 或 draft-v1.html；不要填写路径' },
    content: { type: 'string', description: '要保存的文件内容' },
  },
  required: ['projectId', 'runId', 'fileName', 'content'],
};

const tempReadParameters = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: '当前项目 ID，由系统自动补充' },
    runId: { type: 'string', description: '当前根 Run ID，由系统自动补充' },
    fileName: { type: 'string', description: 'temp:save 返回的单个文件名，不要填写路径' },
    cursor: { type: 'number', description: '字符游标，按 NEXT_CURSOR 继续读取' },
    maxChars: { type: 'number', description: '单次最多读取字符数，默认 12000' },
  },
  required: ['projectId', 'runId', 'fileName'],
};

const tempListParameters = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: '当前项目 ID，由系统自动补充' },
    runId: { type: 'string', description: '当前根 Run ID，由系统自动补充' },
  },
  required: ['projectId', 'runId'],
};

const tempPromoteParameters = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: '当前项目 ID，由系统自动补充' },
    runId: { type: 'string', description: '当前根 Run ID，由系统自动补充' },
    fileName: { type: 'string', description: '已真实保存的临时文件名，不要填写路径' },
    outputName: { type: 'string', description: '可选的成果文件名，不要填写路径；默认沿用临时文件名' },
  },
  required: ['projectId', 'runId', 'fileName'],
};

function isParallelChildRun(runRepo: AgentRunRepository, runId: string): boolean {
  try {
    return runRepo.listEvents(runId).some((event) => event.type === 'parallel.child');
  } catch {
    return false;
  }
}

function readParallelResult(runRepo: AgentRunRepository, runId: string): { text: string; artifacts: string[] } {
  const event = [...runRepo.listEvents(runId)].reverse().find((item) => item.type === 'parallel.result');
  if (!event?.payloadJson) return { text: '', artifacts: [] };
  try {
    const payload = JSON.parse(event.payloadJson) as { text?: unknown; artifacts?: unknown };
    return {
      text: typeof payload.text === 'string' ? payload.text : '',
      artifacts: Array.isArray(payload.artifacts) ? payload.artifacts.filter((item): item is string => typeof item === 'string') : [],
    };
  } catch {
    return { text: '', artifacts: [] };
  }
}

const documentReadParameters = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: '当前群聊 ID，由执行上下文自动补充' },
    document: { type: 'string', description: '明确指向的文件名、工作区相对路径、fileId 或 sourceId' },
    cursor: { type: 'number', description: '字符游标；首次为 0，后续严格使用上次返回的 NEXT_CURSOR' },
    page: { type: 'number', description: '可选的标准化页码；与 cursor 二选一' },
    maxChars: { type: 'number', description: '单次最大正文字符数，默认 6000，范围 1000-10000' },
  },
  required: ['projectId', 'document'],
};

async function executeDocumentRead(db: Database.Database, args: Record<string, unknown>): Promise<string> {
  const { projectId, document, cursor, page, maxChars } = args as {
    projectId: string; document: string; cursor?: number; page?: number; maxChars?: number;
  };
  try {
    const scopes = resolveKnowledgeScopesForGroup(db, projectId).map((scope) => ({
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      workspaceType: scope.workspaceType ?? (scope.scopeType === 'shared' ? 'enterprise' : 'group'),
    }));
    return await readStandardizedDocument({
      db,
      selector: document,
      scopes,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(page !== undefined ? { page } : {}),
      ...(maxChars !== undefined ? { maxChars } : {}),
    });
  } catch (error) {
    return `整文读取失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

type TemplateWorkspace = {
  workspaceType: 'group' | 'enterprise-project' | 'enterprise';
  label: '个人' | '项目' | '企业';
  root: string;
};

type TemplateFile = TemplateWorkspace & {
  relativePath: string;
  absolutePath: string;
  size: number;
  modifiedAt: string;
};

function templateWorkspaces(db: Database.Database, projectId: string): TemplateWorkspace[] {
  return resolveKnowledgeScopesForGroup(db, projectId).map((scope) => {
    if (scope.workspaceType === 'enterprise') {
      return { workspaceType: 'enterprise' as const, label: '企业' as const, root: join(getEnterpriseWorkspaceRoot(), 'templates') };
    }
    if (scope.workspaceType === 'enterprise-project') {
      return { workspaceType: 'enterprise-project' as const, label: '项目' as const, root: join(getEnterpriseProjectRoot(scope.scopeId), 'templates') };
    }
    return { workspaceType: 'group' as const, label: '个人' as const, root: join(getProjectRoot(scope.scopeId), 'templates') };
  });
}

async function collectTemplateFiles(workspace: TemplateWorkspace): Promise<TemplateFile[]> {
  const result: TemplateFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const info = await stat(path);
        result.push({
          ...workspace,
          relativePath: relative(workspace.root, path).replaceAll('\\', '/'),
          absolutePath: path,
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
      }
    }
  };
  await visit(workspace.root);
  return result;
}

async function listAuthorizedTemplates(db: Database.Database, projectId: string): Promise<TemplateFile[]> {
  const files = await Promise.all(templateWorkspaces(db, projectId).map((workspace) => collectTemplateFiles(workspace)));
  return files.flat().sort((left, right) => {
    const order = { group: 0, 'enterprise-project': 1, enterprise: 2 } as const;
    return order[left.workspaceType] - order[right.workspaceType] || right.modifiedAt.localeCompare(left.modifiedAt);
  });
}

const templateListParameters = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: '当前群聊 ID，由执行上下文自动补充' },
    query: { type: 'string', description: '可选关键词，用于按文件名或路径筛选模板' },
    limit: { type: 'number', description: '最多返回条数，默认 30，最大 100' },
  },
  required: ['projectId'],
};

const templateReadParameters = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: '当前群聊 ID，由执行上下文自动补充' },
    template: { type: 'string', description: 'template:list 返回的选择器、模板相对路径或文件名' },
    cursor: { type: 'number', description: '字符游标；首次为 0，后续严格使用上次返回的 NEXT_CURSOR' },
    page: { type: 'number', description: '可选页码；有页码信息的模板可按页读取' },
    maxChars: { type: 'number', description: '单次最大正文字符数，默认 6000，范围 1000-10000' },
  },
  required: ['projectId', 'template'],
};

const templateMaterializeParameters = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: '当前群聊 ID，由执行上下文自动补充' },
    runId: { type: 'string', description: '当前根 Run ID，由执行上下文自动补充' },
    template: { type: 'string', description: 'template:list 返回的选择器、模板相对路径或文件名' },
    content: { type: 'string', description: '要放入模板正文区域的 HTML 片段或纯文本内容' },
    fileName: { type: 'string', description: '临时文件名，例如 draft.html；只填写文件名，不要填写路径' },
  },
  required: ['projectId', 'runId', 'template', 'content', 'fileName'],
};

async function executeTemplateList(db: Database.Database, args: Record<string, unknown>): Promise<string> {
  const { projectId, query, limit } = args as { projectId: string; query?: string; limit?: number };
  const keyword = query?.trim().toLocaleLowerCase() ?? '';
  const maxItems = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const files = (await listAuthorizedTemplates(db, projectId))
    .filter((file) => !keyword || file.relativePath.toLocaleLowerCase().includes(keyword))
    .slice(0, maxItems);
  if (files.length === 0) return keyword ? `未找到名称或路径包含“${query?.trim()}”的可用模板` : '当前个人、关联项目和企业模板区均没有可用模板';
  return files.map((file) => {
    const selector = `${file.workspaceType}:${file.relativePath}`;
    return `- [${file.label}模板] ${file.relativePath}（selector: ${selector}，${file.size} bytes，更新于 ${file.modifiedAt}）`;
  }).join('\n');
}

async function executeTemplateRead(db: Database.Database, args: Record<string, unknown>): Promise<string> {
  const { projectId, template, cursor, page, maxChars } = args as {
    projectId: string; template: string; cursor?: number; page?: number; maxChars?: number;
  };
  const selector = String(template ?? '').trim().replaceAll('\\', '/');
  if (!selector) return '模板读取失败: 模板选择器不能为空';
  const files = await listAuthorizedTemplates(db, projectId);
  const qualified = selector.match(/^(group|enterprise-project|enterprise):(.*)$/u);
  const selectorPath = (qualified?.[2] ?? selector).replace(/^templates\//u, '');
  const matches = files.filter((file) => {
    if (qualified && file.workspaceType !== qualified[1]) return false;
    return file.relativePath.toLocaleLowerCase() === selectorPath.toLocaleLowerCase()
      || basename(file.relativePath).toLocaleLowerCase() === selectorPath.toLocaleLowerCase();
  });
  const target = matches[0];
  if (!target) return `模板读取失败: 未在当前授权的个人、项目或企业模板区找到“${selector}”；请先调用 template:list`;
  if (target.size > 100 * 1024 * 1024) return '模板读取失败: 文件超过 100 MB 上限';
  try {
    const buffer = await readFile(target.absolutePath);
    const extension = extname(target.absolutePath).slice(1).toLocaleLowerCase();
    const parsed = await parseDocument(Uint8Array.from(buffer), extension, basename(target.absolutePath));
    let text = parsed.text.trim();
    if (parsed.metadata.requiresOcr) {
      text = (await new LocalOcrService().extract(target.absolutePath)).trim();
    }
    const pageOffsets = Array.isArray(parsed.metadata.pageOffsets)
      ? parsed.metadata.pageOffsets.filter((value): value is number => typeof value === 'number' && value >= 0)
      : [];
    const chunkSize = Math.min(Math.max(Number(maxChars) || 6000, 1000), 10000);
    const requestedPage = Number.isInteger(page) && Number(page) > 0 ? Number(page) : undefined;
    const start = requestedPage
      ? (pageOffsets[requestedPage - 1] ?? 0)
      : Math.min(Math.max(Number(cursor) || 0, 0), text.length);
    const pageEnd = requestedPage && pageOffsets[requestedPage]
      ? pageOffsets[requestedPage]
      : text.length;
    const end = Math.min(start + chunkSize, pageEnd, text.length);
    const complete = requestedPage ? end >= pageEnd : end >= text.length;
    const rawTemplate = extension === 'html' || extension === 'htm' ? buffer.toString('utf8') : '';
    const markers = rawTemplate.match(/KLA:CONTENT|data-kla-content|\{\{KLA_CONTENT\}\}/giu) ?? [];
    const assets = rawTemplate.match(/(?:src|href|url\()\s*["']?([^"')\s]+)["']?/giu) ?? [];
    return [
      `TEMPLATE: ${basename(target.relativePath)}`,
      `WORKSPACE: ${target.label}`,
      `PATH: templates/${target.relativePath}`,
      `TEMPLATE_FORMAT: ${extension || 'unknown'}`,
      `TEMPLATE_SHELL: ${rawTemplate ? '原始 HTML 外壳可复用（保留 CSS、页眉、页脚、背景和资源）' : '非 HTML 模板，按解析后的正文和格式要求复用'}`,
      `CONTENT_MARKERS: ${markers.length > 0 ? [...new Set(markers)].join('、') : '未声明（materialize 将按正文区域保守替换）'}`,
      `ASSET_REFERENCES: ${rawTemplate ? assets.length : 0}`,
      `CURSOR: ${start}`,
      `NEXT_CURSOR: ${end}`,
      `READ_COMPLETE: ${complete}`,
      requestedPage ? `PAGE: ${requestedPage}` : '',
      '',
      text.slice(start, end),
    ].filter((line) => line !== '').join('\n');
  } catch (error) {
    return `模板读取失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function templateAssetMime(path: string): string {
  const extension = extname(path).toLocaleLowerCase();
  const types: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.css': 'text/css',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  };
  return types[extension] ?? 'application/octet-stream';
}

function normalizeTemplateContent(content: string): string {
  const trimmed = content.trim();
  const body = trimmed.match(/<body\b[^>]*>([\s\S]*?)<\/body>/iu)?.[1]?.trim();
  if (body) return body;
  if (/<[a-z][\s\S]*>/iu.test(trimmed)) return trimmed;
  return trimmed
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .split(/\r?\n/)
    .map((line) => line.trim() ? `<p>${line}</p>` : '')
    .join('\n');
}

function replaceTemplateBody(rawHtml: string, content: string): string {
  const fragment = normalizeTemplateContent(content);
  const markerPatterns = [
    /(<!--\s*KLA:CONTENT\s*-->)[\s\S]*?(<!--\s*\/KLA:CONTENT\s*-->)/iu,
    /(<(?:main|section|article|div)\b[^>]*data-kla-content[^>]*>)[\s\S]*?(<\/\s*(?:main|section|article|div)\s*>)/iu,
    /(\{\{KLA_CONTENT\}\})/iu,
  ];
  for (const pattern of markerPatterns) {
    if (pattern.test(rawHtml)) {
      return rawHtml.replace(pattern, (_whole, open: string, close?: string) => close ? `${open}\n${fragment}\n${close}` : fragment);
    }
  }
  // The supplied brand template uses a .body region inside .doc-paper. This
  // preserves the page shell, header, footer, background and style guide page.
  const bodyOpening = rawHtml.match(/<([a-z0-9]+)\b[^>]*class=["'][^"']*\bbody\b[^"']*["'][^>]*>/iu);
  if (bodyOpening?.index !== undefined) {
    const tag = bodyOpening[1]!;
    const openingEnd = bodyOpening.index + bodyOpening[0].length;
    const tagPattern = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'giu');
    const tail = rawHtml.slice(openingEnd);
    tagPattern.lastIndex = 0;
    let depth = 1;
    let closingStart = -1;
    let closingEnd = -1;
    for (const match of tail.matchAll(tagPattern)) {
      const token = match[0];
      const tokenStart = openingEnd + (match.index ?? 0);
      if (/^<\//u.test(token)) {
        depth -= 1;
        if (depth === 0) {
          closingStart = tokenStart;
          closingEnd = tokenStart + token.length;
          break;
        }
      } else if (!/\/\s*>$/u.test(token)) {
        depth += 1;
      }
    }
    if (closingStart >= 0) {
      return `${rawHtml.slice(0, openingEnd)}\n${fragment}\n${rawHtml.slice(closingStart, closingEnd)}${rawHtml.slice(closingEnd)}`;
    }
  }
  const mainRegion = rawHtml.match(/(<main\b[^>]*>)[\s\S]*?(<\/main\s*>)/iu);
  if (mainRegion?.index !== undefined) {
    return `${rawHtml.slice(0, mainRegion.index)}${mainRegion[1]}\n${fragment}\n${mainRegion[2]}${rawHtml.slice(mainRegion.index + mainRegion[0].length)}`;
  }
  const closingBody = rawHtml.search(/<\/body\s*>/iu);
  if (closingBody >= 0) return `${rawHtml.slice(0, closingBody)}${fragment}\n${rawHtml.slice(closingBody)}`;
  return `${rawHtml}\n${fragment}`;
}

async function inlineTemplateAssets(html: string, templateDirectory: string): Promise<string> {
  let result = html;
  const references = new Set<string>();
  // Drafts are stored outside the template directory. Inline local assets
  // referenced by HTML or CSS so the copied document keeps its visual shell.
  for (const match of result.matchAll(/(?:\bsrc\s*=\s*["']|\bhref\s*=\s*["']|\burl\(\s*["']?)([^"')\s]+)["']?\)?/giu)) {
    const reference = match[1]?.trim();
    if (reference && !/^(?:data:|https?:|#|\/\/)/iu.test(reference)) references.add(reference);
  }
  const root = resolve(templateDirectory);
  for (const reference of references) {
    try {
      const absolute = resolve(root, reference);
      if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) continue;
      const bytes = await readFile(absolute);
      const dataUri = `data:${templateAssetMime(absolute)};base64,${bytes.toString('base64')}`;
      result = result.replaceAll(reference, dataUri);
    } catch {
      // Missing optional assets do not invalidate the template; keep the
      // original reference so the user can repair it in the template folder.
    }
  }
  return result;
}

async function executeTemplateMaterialize(db: Database.Database, args: Record<string, unknown>): Promise<string> {
  const { projectId, runId, template, content, fileName } = args as {
    projectId: string; runId: string; template: string; content: string; fileName: string;
  };
  if (!projectId || !runId) return '模板套用失败：缺少当前项目或任务标识';
  let tempTarget: { root: string; fileName: string; path: string };
  try {
    tempTarget = tempFilePath(db, projectId, runId, String(fileName ?? ''));
  } catch (error) {
    return `模板套用失败：${error instanceof Error ? error.message : String(error)}`;
  }
  if (!/\.html?$/iu.test(tempTarget.fileName)) return '模板套用失败：临时文件名必须为 HTML 文件';
  const selector = String(template ?? '').trim().replaceAll('\\', '/');
  const qualified = selector.match(/^(group|enterprise-project|enterprise):(.*)$/u);
  const selectorPath = (qualified?.[2] ?? selector).replace(/^templates\//u, '');
  const files = await listAuthorizedTemplates(db, projectId);
  const templateFile = files.find((file) => {
    if (qualified && file.workspaceType !== qualified[1]) return false;
    return file.relativePath.toLocaleLowerCase() === selectorPath.toLocaleLowerCase()
      || basename(file.relativePath).toLocaleLowerCase() === selectorPath.toLocaleLowerCase();
  });
  if (!templateFile) return `模板套用失败：未在当前授权模板区找到“${selector}”，请先调用 template:list`;
  if (!/\.html?$/iu.test(templateFile.absolutePath)) return '模板套用失败：当前仅支持 HTML 模板的原始外壳复用';
  try {
    const raw = await readFile(templateFile.absolutePath, 'utf8');
    const renderedBody = replaceTemplateBody(raw, String(content ?? ''));
    const rendered = await inlineTemplateAssets(
      renderedBody.includes('KLA:TEMPLATE_MATERIALIZED')
        ? renderedBody
        : `<!-- KLA:TEMPLATE_MATERIALIZED: ${templateFile.relativePath} -->\n${renderedBody}`,
      dirname(templateFile.absolutePath),
    );
    await mkdir(tempTarget.root, { recursive: true });
    const tempPath = `${tempTarget.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, rendered, 'utf8');
    await atomicReplaceFile(tempPath, tempTarget.path);
    return `TEMP_SAVED: ${tempTarget.fileName}（${Buffer.byteLength(rendered, 'utf8')} bytes；模板已套用，保留原始 CSS、页眉、页脚、背景和可用资源）`;
  } catch (error) {
    return `模板套用失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

export function createProjectTools(db: Database.Database, scheduler?: Scheduler, gateway: ModelGateway | null = null): ToolDefinition[] {
  const sRepo = new SearchRepository(db);
  const runRepo = new AgentRunRepository(db);

  return [
    {
      name: 'temp:save',
      description: '把当前任务的中间产物真实保存到个人工作区“临时/<根RunID>/”中。只填写文件名，不要填写路径；未调用本工具不会生成文件。',
      parameters: tempSaveParameters,
      execute: (args) => saveTempFile(db, args),
    },
    {
      name: 'temp:read',
      description: '读取当前任务个人工作区临时目录中的真实中间文件，按游标分段返回。临时文件不参与知识化和普通知识检索。',
      parameters: tempReadParameters,
      execute: (args) => readTempFile(db, args),
    },
    {
      name: 'temp:list',
      description: '列出当前任务个人工作区临时目录中已经真实存在的中间文件。',
      parameters: tempListParameters,
      execute: (args) => listTempFiles(db, args),
    },
    {
      name: 'temp:promote',
      description: '由统筹智能体或具备内部闭环权限的本地执行智能体在确认临时文件真实存在且可交付后，将它复制到个人工作区 outputs/；只填写文件名，不填写路径。',
      parameters: tempPromoteParameters,
      execute: (args) => promoteTempFile(db, args),
    },
    {
      name: 'knowledge:process',
      description: '检查当前群聊个人、已关联项目和企业工作区的原始文件变化，只对新增、变更或待处理来源执行增量知识化；未变化文件会直接跳过。',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '当前群聊 ID，由执行上下文自动补充' },
        },
        required: ['projectId'],
      },
      async execute(args) {
        const { projectId } = args as { projectId: string };
        if (!gateway) return '知识化失败：尚未配置可用于知识处理的模型。';
        try {
          const result = await refreshKnowledgeBeforeSearch(db, gateway, projectId);
          if (result.changedFileIds.length === 0 && result.deletedFileIds.length === 0) {
            return 'KNOWLEDGE_UP_TO_DATE: 授权工作区没有新增、变更或待处理的原始文件，已跳过重复知识化。';
          }
          return [
            'KNOWLEDGE_PROCESSED',
            `新增或变更：${result.changedFileIds.length}`,
            `停用来源：${result.deletedFileIds.length}`,
            `失败：${result.failedFileIds.length}`,
            result.failedFileIds.length > 0 ? `失败文件 ID：${result.failedFileIds.join('、')}` : '',
          ].filter(Boolean).join('\n');
        } catch (err) {
          return `知识化失败：${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'knowledge:search',
      description: '检索当前群聊个人、已关联项目和企业知识，融合全文、向量、图谱与 Wiki 并返回带层级和来源的证据',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          projectId: { type: 'string', description: '项目 ID' },
          limit: { type: 'number', description: '最大返回条数，默认 5' },
        },
        required: ['query', 'projectId'],
      },
      async execute(args) {
        const { query, projectId, limit } = args as { query: string; projectId: string; limit?: number };
        try {
          await refreshKnowledgeBeforeSearch(db, gateway, projectId);
          return formatHybridKnowledgeResult(searchHybridKnowledge(db, query, projectId, limit ?? 5));
        } catch (err) {
          return `搜索错误: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'knowledge:readDocument',
      description: '按文件读取标准化完整正文。用于明确指定文件、依据某文件、制度文件原文、全文审阅或逐条比较；按 NEXT_CURSOR 连续读取直到 READ_COMPLETE: true，不能只读首段。',
      parameters: documentReadParameters,
      execute: (args) => executeDocumentRead(db, args),
    },
    {
      name: 'template:list',
      description: '列出当前群聊个人、已关联项目和企业模板区中的可用模板；写作或验收前先发现模板，不要猜测模板路径。',
      parameters: templateListParameters,
      execute: (args) => executeTemplateList(db, args),
    },
    {
      name: 'template:read',
      description: '读取模板正文与格式要求，支持 TXT、MD、HTML、DOCX、PDF、XLSX 和 OCR 图片；长模板按 NEXT_CURSOR 连续读取到 READ_COMPLETE: true。',
      parameters: templateReadParameters,
      execute: (args) => executeTemplateRead(db, args),
    },
    {
      name: 'template:materialize',
      description: '将材料正文嵌入实际 HTML 模板正文区域，保留模板 CSS、logo、页眉、页脚、背景和可用资源，并以文件名写入当前 Run 的个人工作区临时目录。',
      parameters: templateMaterializeParameters,
      execute: (args) => executeTemplateMaterialize(db, args),
    },
    {
      name: 'web:search',
      description: 'Use Bocha web search to find public web sources and return concise results with source links.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search question or topic' },
          count: { type: 'number', description: 'Number of results, default 5, maximum 20' },
          freshness: { type: 'string', description: 'noLimit, day, week, month, or year' },
          summary: { type: 'boolean', description: 'Request page summaries, default true' },
          include: { type: 'string', description: 'Optional comma-separated sites or domains to include' },
          exclude: { type: 'string', description: 'Optional comma-separated sites or domains to exclude' },
        },
        required: ['query'],
      },
      async execute(args) {
        const input = args as { query: string; count?: number; freshness?: 'noLimit' | 'day' | 'week' | 'month' | 'year'; summary?: boolean; include?: string; exclude?: string };
        try {
          return formatBochaSearchResults(await searchBochaWeb(db, input));
        } catch (err) {
          return `Web search failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'workspace:readFile',
      description: '读取工作区文件内容',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          relativePath: { type: 'string', description: '文件相对路径' },
        },
        required: ['projectId', 'relativePath'],
      },
      async execute(args) {
        const { projectId, relativePath } = args as { projectId: string; relativePath: string };
        try {
          const filePath = resolveWorkspaceReadPath(projectId, relativePath);
          const info = await lstat(filePath);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('目标不是普通文件');
          const content = await readFile(filePath, 'utf8');
          return content.slice(0, 10000);
        } catch (err) {
          return `读取失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'project:search',
      description: '跨项目全文搜索，返回匹配的消息和文件',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          limit: { type: 'number', description: '最大返回条数，默认 5' },
        },
        required: ['query'],
      },
      async execute(args) {
        const { query, limit } = args as { query: string; limit?: number };
        try {
          const results = sRepo.search(query, limit ?? 5);
          if (results.length === 0) return '未找到匹配结果';
          return results.map((r) => `[${r.kind}] ${r.title}: ${r.snippet.slice(0, 500)}`).join('\n\n');
        } catch (err) {
          return `搜索错误: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'knowledge:listGraph',
      description: '列出知识图谱中的所有节点',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          graphId: { type: 'string', description: '图谱 ID（可选，留空则列出所有图谱）' },
        },
        required: ['projectId'],
      },
      async execute(args) {
        const { projectId, graphId } = args as { projectId: string; graphId?: string };
        try {
          if (graphId) {
            const nodes = db.prepare(
              'SELECT id, canonical_name as title, node_type as type FROM knowledge_nodes WHERE project_id = ? AND graph_id = ? ORDER BY canonical_name',
            ).all(projectId, graphId) as Array<{ id: string; title: string; type: string }>;
            if (nodes.length === 0) return '该图谱中无节点';
            return nodes.map((n) => `- ${n.title} (${n.type})`).join('\n');
          }
          const graphs = db.prepare(
            'SELECT id, name, description FROM knowledge_graphs WHERE project_id = ? ORDER BY name',
          ).all(projectId) as Array<{ id: string; name: string; description: string | null }>;
          if (graphs.length === 0) return '该项目无知识图谱';
          return graphs.map((g) => `图谱: ${g.name}${g.description ? ` - ${g.description}` : ''}`).join('\n');
        } catch (err) {
          return `查询错误: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    // ---- Team MCP 工具 ----
    {
      name: 'list_project_agents',
      description: '列出当前项目中的所有可委派智能体成员',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
        },
        required: ['projectId'],
      },
      async execute(args) {
        const { projectId } = args as { projectId: string };
        try {
          const agents = db.prepare(
            `SELECT pai.id, ap.name, pai.role, ap.definition_id as definitionId
             FROM project_agent_instances pai
             JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
             WHERE pai.project_id = ? AND ap.enabled = 1 ORDER BY pai.ordinal`,
          ).all(projectId) as Array<{ id: string; name: string; role: string; definitionId: string }>;
          if (agents.length === 0) return '该项目无可用的智能体';
          return agents.map((a) => `- @${a.name}（instanceId: ${a.id}，${a.role}，${a.definitionId}）`).join('\n');
        } catch (err) {
          return `查询错误: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'delegate_tasks',
      description: '向子智能体委派任务，等待结果返回',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          agentInstanceId: { type: 'string', description: '目标智能体实例 ID' },
          instruction: { type: 'string', description: '委派指令' },
          parentRunId: { type: 'string', description: '当前 Run ID' },
        },
        required: ['projectId', 'agentInstanceId', 'instruction', 'parentRunId'],
      },
      async execute(args) {
        const { projectId, agentInstanceId, instruction, parentRunId } = args as {
          projectId: string; agentInstanceId: string; instruction: string; parentRunId: string;
        };

        try {
          // 安全限制 1: 目标智能体必须已启用（AC-SET-03）
          const targetProfile = db.prepare(
            `SELECT ap.enabled FROM project_agent_instances pai
             JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
             WHERE pai.id = ?`,
          ).get(agentInstanceId) as { enabled: number } | undefined;
          if (!targetProfile) {
            return `智能体实例 ${agentInstanceId} 不存在`;
          }
          if (!targetProfile.enabled) {
            const msg = `智能体实例 ${agentInstanceId} 已被禁用，无法委派任务`;
            runRepo.addEvent(parentRunId, 'delegate.rejected', { reason: 'agent_disabled', agentInstanceId });
            return msg;
          }

          // 安全限制 2: 委派深度最多 2 层
          const ancestorChain = runRepo.getAncestorChain(parentRunId);
          const depth = ancestorChain.length;
          if (depth >= 2) {
            const msg = `委派深度 ${depth} 已达到上限 2 层，已禁止继续向下委派`;
            runRepo.addEvent(parentRunId, 'delegate.rejected', { reason: 'max_depth', depth, agentInstanceId });
            return msg;
          }

          // 安全限制 3: 禁止循环委派（目标智能体已在祖先链中）
          const ancestorInstanceIds = new Set(ancestorChain.map((r) => r.agentInstanceId));
          if (ancestorInstanceIds.has(agentInstanceId)) {
            const msg = `循环委派检测: 智能体 ${agentInstanceId} 已在当前 Run 的祖先链中，已禁止`;
            runRepo.addEvent(parentRunId, 'delegate.rejected', { reason: 'cycle_detected', agentInstanceId });
            return msg;
          }

          // 安全限制 4: 每条 triggerMessage 最多 20 个 Run
          const triggerMessageId = ancestorChain.length > 0 ? ancestorChain[ancestorChain.length - 1]!.triggerMessageId : null;
          if (triggerMessageId) {
            const runCount = runRepo.countRunsByTrigger(triggerMessageId);
            if (runCount >= 20) {
              const msg = `消息 ${triggerMessageId} 已产生 ${runCount} 个 Run，达到上限 20，禁止继续委派`;
              runRepo.addEvent(parentRunId, 'delegate.rejected', { reason: 'max_runs_per_message', count: runCount, triggerMessageId });
              return msg;
            }
          }

          const subRun = runRepo.create({
            projectId,
            agentInstanceId,
            requestedByType: 'agent',
            requestedById: ancestorChain[0]?.agentInstanceId ?? parentRunId,
            instruction,
            parentRunId,
            ...(triggerMessageId ? { triggerMessageId } : {}),
            modelProfileSnapshotJson: buildModelProfileSnapshot(db, agentInstanceId),
          });
          runRepo.addEvent(parentRunId, 'delegate', {
            subRunId: subRun.id,
            agentInstanceId,
            instruction: instruction.slice(0, 200),
          });

          if (scheduler) {
            scheduler.enqueue({
              runId: subRun.id,
              projectId,
              agentInstanceId,
              instruction,
              triggerMessageId: triggerMessageId ?? '',
            });
            return `任务已委派给智能体 ${agentInstanceId}，子 Run ID: ${subRun.id}（深度 ${depth + 1}）`;
          }
          return `子 Run 已创建 (${subRun.id})，但调度器未连接，需手动触发`;
        } catch (err) {
          return `委派失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'publish_artifact',
      description: '将生成的成果文件发布到工作区',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          relativePath: { type: 'string', description: '文件相对路径（如 outputs/report.md）' },
          content: { type: 'string', description: '文件内容' },
          note: { type: 'string', description: '成果说明（可选）' },
        },
        required: ['projectId', 'relativePath', 'content'],
      },
      async execute(args) {
        const { projectId, relativePath, content, note } = args as {
          projectId: string; relativePath: string; content: string; note?: string;
        };
        try {
          const normalized = String(relativePath ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
          if (!normalized.startsWith('outputs/') || normalized.includes('..')) {
            return '发布失败: 成果文件必须位于 outputs/ 目录';
          }
          const projectRoot = getProjectRoot(projectId);
          const filePath = join(projectRoot, normalized);
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, content, 'utf8');
          const result = `成果已发布到 ${normalized}${note ? ` (说明: ${note})` : ''}`;
          return result;
        } catch (err) {
          return `发布失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}

/** 将项目工具注册到 ToolRegistry，附加权限元数据 */
export function registerProjectTools(registry: ToolRegistry, db: Database.Database, scheduler?: Scheduler, gateway: ModelGateway | null = null): void {
  const sRepo = new SearchRepository(db);
  const runRepo = new AgentRunRepository(db);

  registry.registerAll([
    {
      name: 'temp:save',
      description: '把当前任务的中间产物真实保存到个人工作区“临时/<根RunID>/”中。只填写文件名，不要填写路径；未调用本工具不会生成文件。',
      parameters: tempSaveParameters,
      requiredCapabilities: ['write:temp'],
      maxContentLength: 1000,
      execute: (args) => saveTempFile(db, args),
    },
    {
      name: 'temp:read',
      description: '读取当前任务个人工作区临时目录中的真实中间文件，按游标分段返回。临时文件不参与知识化和普通知识检索。',
      parameters: tempReadParameters,
      requiredCapabilities: ['read:temp'],
      maxContentLength: 52000,
      execute: (args) => readTempFile(db, args),
    },
    {
      name: 'temp:list',
      description: '列出当前任务个人工作区临时目录中已经真实存在的中间文件。',
      parameters: tempListParameters,
      requiredCapabilities: ['read:temp'],
      maxContentLength: 12000,
      execute: (args) => listTempFiles(db, args),
    },
    {
      name: 'temp:promote',
      description: '由统筹智能体或具备内部闭环权限的本地执行智能体在确认临时文件真实存在且可交付后，将它复制到个人工作区 outputs/；只填写临时文件名，不填写路径。',
      parameters: tempPromoteParameters,
      requiredCapabilities: ['promote:reviewed-output'],
      maxContentLength: 2000,
      execute: (args) => promoteTempFile(db, args),
    },
    {
      name: 'agent:spawn_parallel',
      description: '按当前智能体自己的职责，把彼此独立的子任务交给同角色分身并行处理；等待全部分身返回后再继续当前任务。统筹智能体不可使用，分身不可继续创建分身。',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '当前项目 ID' },
          parentRunId: { type: 'string', description: '当前主 Run ID' },
          tasks: {
            type: 'array',
            description: '彼此独立且都属于当前职责范围的子任务，最多 6 项',
            items: {
              type: 'object',
              properties: {
                query: { type: 'string', description: '给分身的自然语言任务' },
                label: { type: 'string', description: '可选的简短任务标签' },
              },
              required: ['query'],
            },
          },
        },
        required: ['projectId', 'parentRunId', 'tasks'],
      },
      requiredCapabilities: ['spawn:parallel'],
      async execute(args) {
        const input = args as { projectId: string; parentRunId: string; tasks: ParallelSubtask[] };
        const parent = runRepo.getById(input.parentRunId);
        if (parent.projectId !== input.projectId) return '分身任务必须属于当前群聊项目。';
        if (isParallelChildRun(runRepo, parent.id)) return '当前任务已经是分身，不能继续创建分身。';
        if (!scheduler) return '分身调度器尚未连接，当前任务请由主智能体直接完成。';

        const tasks = Array.isArray(input.tasks)
          ? input.tasks
            .filter((task): task is ParallelSubtask => Boolean(task) && typeof task.query === 'string' && task.query.trim().length > 0)
            .map((task) => ({ query: task.query.trim(), label: typeof task.label === 'string' ? task.label.trim() : '' }))
            .slice(0, 6)
          : [];
        if (tasks.length < 2) return '只有一个子任务时不需要创建分身，请直接完成当前任务。';

        const childRunIds: string[] = [];
        for (const task of tasks) {
          const child = runRepo.create({
            projectId: parent.projectId,
            agentInstanceId: parent.agentInstanceId,
            requestedByType: 'agent',
            requestedById: parent.agentInstanceId,
            instruction: task.query,
            parentRunId: parent.id,
            ...(parent.triggerMessageId ? { triggerMessageId: parent.triggerMessageId } : {}),
            modelProfileSnapshotJson: buildModelProfileSnapshot(db, parent.agentInstanceId),
          });
          runRepo.addEvent(child.id, 'parallel.child', {
            parentRunId: parent.id,
            label: task.label || undefined,
            query: task.query.slice(0, 500),
          });
          childRunIds.push(child.id);
          scheduler.enqueue({
            runId: child.id,
            projectId: parent.projectId,
            agentInstanceId: parent.agentInstanceId,
            instruction: task.query,
            triggerMessageId: parent.triggerMessageId ?? '',
            parallel: true,
          });
        }
        runRepo.addEvent(parent.id, 'parallel.spawned', { childRunIds, taskCount: childRunIds.length });

        const pending = new Set(childRunIds);
        const results: string[] = [];
        const deadline = Date.now() + AGENT_TASK_TIMEOUT_MS;
        while (pending.size > 0 && Date.now() < deadline) {
          const currentParent = runRepo.getById(parent.id);
          if (['cancelled', 'interrupted', 'failed'].includes(currentParent.status)) {
            for (const childRunId of pending) scheduler.cancelRun(childRunId);
            return '主任务已停止，分身任务也已停止。';
          }
          for (const childRunId of [...pending]) {
            const child = runRepo.getById(childRunId);
            if (child.status === 'completed') {
              const result = readParallelResult(runRepo, childRunId);
              const label = [...runRepo.listEvents(childRunId)].find((event) => event.type === 'parallel.child')?.payloadJson;
              let taskLabel = '';
              try { taskLabel = typeof label === 'string' ? String((JSON.parse(label) as { label?: unknown }).label ?? '') : ''; } catch { /* ignore */ }
              results.push(`${taskLabel || '分身任务'}：${result.text || '已完成，但没有文本结果。'}${result.artifacts.length ? `\n成果文件：${result.artifacts.join('、')}` : ''}`);
              pending.delete(childRunId);
            } else if (['failed', 'cancelled', 'interrupted'].includes(child.status)) {
              results.push(`分身任务未完成：${child.errorMessage ?? child.status}`);
              pending.delete(childRunId);
            }
          }
          if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (pending.size > 0) results.push(`仍有 ${pending.size} 个分身任务在执行，主智能体可根据已返回结果继续判断。`);
        return results.join('\n\n');
      },
    },
    {
      name: 'web:search',
      description: 'Use Bocha web search to find public web sources and return concise results with source links.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search question or topic' },
          count: { type: 'number', description: 'Number of results, default 5, maximum 20' },
          freshness: { type: 'string', description: 'noLimit, day, week, month, or year' },
          summary: { type: 'boolean', description: 'Request page summaries, default true' },
          include: { type: 'string', description: 'Optional comma-separated sites or domains to include' },
          exclude: { type: 'string', description: 'Optional comma-separated sites or domains to exclude' },
        },
        required: ['query'],
      },
      requiredCapabilities: ['network:search'],
      maxContentLength: 12_000,
      async execute(args) {
        const input = args as { query: string; count?: number; freshness?: 'noLimit' | 'day' | 'week' | 'month' | 'year'; summary?: boolean; include?: string; exclude?: string };
        try {
          return formatBochaSearchResults(await searchBochaWeb(db, input));
        } catch (err) {
          return `Web search failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'skill:search',
      description: '按当前任务从本次 Run 的自身技能快照中检索最匹配的技能。',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '当前 Run ID，由系统自动补充' },
          query: { type: 'string', description: '当前要解决的问题或能力需求' },
          limit: { type: 'number', description: '最多返回技能数，默认 3' },
        },
        required: ['runId', 'query'],
      },
      requiredCapabilities: ['read:skill'],
      maxContentLength: 6_000,
      async execute(args) {
        const { runId, query, limit } = args as { runId: string; query: string; limit?: number };
        const matches = new SkillRegistry(db).searchForRun(runId, query, limit ?? 3);
        if (matches.length === 0) return '当前智能体没有匹配的已绑定技能';
        return matches.map((skill) => `- ${skill.id}@${skill.version}：${skill.description}（所需工具：${skill.requiredTools.join('、') || '无'}）`).join('\n');
      },
    },
    {
      name: 'skill:load',
      description: '按需读取当前智能体定义已绑定的技能说明。只能读取自己的技能池。',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '当前 Run ID，由系统自动补充' },
          skillId: { type: 'string', description: '技能 ID' },
          version: { type: 'string', description: '技能版本，可选' },
        },
        required: ['runId', 'skillId'],
      },
      requiredCapabilities: ['read:skill'],
      maxContentLength: 20_000,
      async execute(args) {
        const { runId, skillId, version } = args as { runId: string; skillId: string; version?: string };
        const content = new SkillRegistry(db).loadForRun(runId, skillId, version);
        return content ?? `技能 ${skillId}${version ? `@${version}` : ''} 未绑定到当前智能体`;
      },
    },
    {
      name: 'workflow:load',
      description: '按需读取当前统筹智能体定义已绑定的业务协同工作流。',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '当前 Run ID，由系统自动补充' },
          workflowId: { type: 'string', description: '工作流 ID' },
          version: { type: 'string', description: '工作流版本，可选' },
        },
        required: ['runId', 'workflowId'],
      },
      requiredCapabilities: ['read:workflow'],
      maxContentLength: 30_000,
      async execute(args) {
        const { runId, workflowId, version } = args as { runId: string; workflowId: string; version?: string };
        const owner = db.prepare(
          `SELECT pai.definition_id as definitionId, pai.definition_version as definitionVersion
           FROM agent_runs ar JOIN project_agent_instances pai ON pai.id = ar.agent_instance_id
           WHERE ar.id = ?`,
        ).get(runId) as { definitionId: string | null; definitionVersion: string | null } | undefined;
        if (!owner?.definitionId) return '无法确认当前智能体定义，工作流读取被拒绝';
        return new WorkflowRegistry(db).loadForDefinition(owner.definitionId, owner.definitionVersion ?? '1.0.0', workflowId, version)
          ?? `工作流 ${workflowId}${version ? `@${version}` : ''} 未绑定到当前智能体`;
      },
    },
    {
      name: 'knowledge:process',
      description: '检查当前群聊个人、已关联项目和企业工作区的原始文件变化，只对新增、变更或待处理来源执行增量知识化；未变化文件会直接跳过。',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '当前群聊 ID，由执行上下文自动补充' },
        },
        required: ['projectId'],
      },
      requiredCapabilities: ['read:file', 'write:knowledge'],
      maxContentLength: 4_000,
      async execute(args) {
        const { projectId } = args as { projectId: string };
        if (!gateway) return '知识化失败：尚未配置可用于知识处理的模型。';
        try {
          const result = await refreshKnowledgeBeforeSearch(db, gateway, projectId);
          if (result.changedFileIds.length === 0 && result.deletedFileIds.length === 0) {
            return 'KNOWLEDGE_UP_TO_DATE: 授权工作区没有新增、变更或待处理的原始文件，已跳过重复知识化。';
          }
          return [
            'KNOWLEDGE_PROCESSED',
            `新增或变更：${result.changedFileIds.length}`,
            `停用来源：${result.deletedFileIds.length}`,
            `失败：${result.failedFileIds.length}`,
            result.failedFileIds.length > 0 ? `失败文件 ID：${result.failedFileIds.join('、')}` : '',
          ].filter(Boolean).join('\n');
        } catch (err) {
          return `知识化失败：${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'knowledge:search',
      description: '检索当前群聊个人、已关联项目和企业知识，融合全文、向量、图谱与 Wiki 并返回带层级和来源的证据',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          projectId: { type: 'string', description: '当前群聊 ID，由执行上下文自动补充' },
          limit: { type: 'number', description: '最大返回条数，默认 5' },
        },
        required: ['query', 'projectId'],
      },
      requiredCapabilities: ['read:knowledge'],
      maxContentLength: 10000,
      async execute(args) {
        const { query, projectId, limit } = args as { query: string; projectId: string; limit?: number };
        try {
          await refreshKnowledgeBeforeSearch(db, gateway, projectId);
          return formatHybridKnowledgeResult(searchHybridKnowledge(db, query, projectId, limit ?? 5));
        } catch (err) {
          return `搜索错误: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'knowledge:readDocument',
      description: '按文件读取标准化完整正文。用于明确指定文件、依据某文件、制度文件原文、全文审阅或逐条比较；按 NEXT_CURSOR 连续读取直到 READ_COMPLETE: true，不能只读首段。',
      parameters: documentReadParameters,
      requiredCapabilities: ['read:document'],
      maxContentLength: 12_000,
      execute: (args) => executeDocumentRead(db, args),
    },
    {
      name: 'template:list',
      description: '列出当前群聊个人、已关联项目和企业模板区中的可用模板；写作或验收前先发现模板，不要猜测模板路径。',
      parameters: templateListParameters,
      requiredCapabilities: ['read:template'],
      maxContentLength: 12_000,
      execute: (args) => executeTemplateList(db, args),
    },
    {
      name: 'template:read',
      description: '读取模板正文与格式要求，支持 TXT、MD、HTML、DOCX、PDF、XLSX 和 OCR 图片；长模板按 NEXT_CURSOR 连续读取到 READ_COMPLETE: true。',
      parameters: templateReadParameters,
      requiredCapabilities: ['read:template'],
      maxContentLength: 12_000,
      execute: (args) => executeTemplateRead(db, args),
    },
    {
      name: 'template:materialize',
      description: '将材料正文嵌入实际 HTML 模板正文区域，保留模板 CSS、logo、页眉、页脚、背景和可用资源，并以文件名写入当前 Run 的个人工作区临时目录。',
      parameters: templateMaterializeParameters,
      requiredCapabilities: ['read:template', 'write:temp'],
      maxContentLength: 50_000,
      execute: (args) => executeTemplateMaterialize(db, args),
    },
    {
      name: 'workspace:readFile',
      description: '读取工作区文件内容',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          relativePath: { type: 'string', description: '文件相对路径' },
        },
        required: ['projectId', 'relativePath'],
      },
      requiredCapabilities: ['read:file'],
      allowedPathPrefixes: ['original-files/', 'outputs/', 'wiki/', 'knowledge/', 'temp/', 'agent-memories/', 'agent-identities/'],
      maxContentLength: 50000,
      async execute(args) {
        const { projectId, relativePath } = args as { projectId: string; relativePath: string };
        try {
          const filePath = resolveWorkspaceReadPath(projectId, relativePath);
          const info = await lstat(filePath);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('目标不是普通文件');
          const content = await readFile(filePath, 'utf8');
          return content.slice(0, 10000);
        } catch (err) {
          return `读取失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'project:search',
      description: '跨项目全文搜索，返回匹配的消息和文件',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          limit: { type: 'number', description: '最大返回条数，默认 5' },
        },
        required: ['query'],
      },
      requiredCapabilities: ['read:message', 'read:file'],
      maxContentLength: 10000,
      async execute(args) {
        const { query, limit } = args as { query: string; limit?: number };
        try {
          const results = sRepo.search(query, limit ?? 5);
          if (results.length === 0) return '未找到匹配结果';
          return results.map((r) => `[${r.kind}] ${r.title}: ${r.snippet.slice(0, 500)}`).join('\n\n');
        } catch (err) {
          return `搜索错误: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'knowledge:listGraph',
      description: '列出知识图谱中的所有节点',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          graphId: { type: 'string', description: '图谱 ID（可选，留空则列出所有图谱）' },
        },
        required: ['projectId'],
      },
      requiredCapabilities: ['read:knowledge'],
      async execute(args) {
        const { projectId, graphId } = args as { projectId: string; graphId?: string };
        try {
          if (graphId) {
            const nodes = db.prepare(
              'SELECT id, canonical_name as title, node_type as type FROM knowledge_nodes WHERE project_id = ? AND graph_id = ? ORDER BY canonical_name',
            ).all(projectId, graphId) as Array<{ id: string; title: string; type: string }>;
            if (nodes.length === 0) return '该图谱中无节点';
            return nodes.map((n) => `- ${n.title} (${n.type})`).join('\n');
          }
          const graphs = db.prepare(
            'SELECT id, name, description FROM knowledge_graphs WHERE project_id = ? ORDER BY name',
          ).all(projectId) as Array<{ id: string; name: string; description: string | null }>;
          if (graphs.length === 0) return '该项目无知识图谱';
          return graphs.map((g) => `图谱: ${g.name}${g.description ? ` - ${g.description}` : ''}`).join('\n');
        } catch (err) {
          return `查询错误: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'list_project_agents',
      description: '列出当前项目中的所有可委派智能体成员',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
        },
        required: ['projectId'],
      },
      requiredCapabilities: ['read:message'],
      async execute(args) {
        const { projectId } = args as { projectId: string };
        try {
          const agents = db.prepare(
            `SELECT pai.id, ap.name, pai.role, ap.definition_id as definitionId
             FROM project_agent_instances pai
             JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
             WHERE pai.project_id = ? AND ap.enabled = 1 ORDER BY pai.ordinal`,
          ).all(projectId) as Array<{ id: string; name: string; role: string; definitionId: string }>;
          if (agents.length === 0) return '该项目无可用的智能体';
          return agents.map((a) => `- @${a.name}（instanceId: ${a.id}，${a.role}，${a.definitionId}）`).join('\n');
        } catch (err) {
          return `查询错误: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'delegate_tasks',
      description: '向子智能体委派任务，等待结果返回',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          agentInstanceId: { type: 'string', description: '目标智能体实例 ID' },
          instruction: { type: 'string', description: '委派指令' },
          parentRunId: { type: 'string', description: '当前 Run ID' },
        },
        required: ['projectId', 'agentInstanceId', 'instruction', 'parentRunId'],
      },
      // 仅统筹智能体可以使用兼容委派工具；专业智能体必须通过正式依赖消息协作。
      requiredCapabilities: ['read:workflow'],
      async execute(args) {
        const { projectId, agentInstanceId, instruction, parentRunId } = args as {
          projectId: string; agentInstanceId: string; instruction: string; parentRunId: string;
        };

        try {
          // 安全限制 1: 目标智能体必须已启用（AC-SET-03）
          const targetProfile = db.prepare(
            `SELECT ap.enabled FROM project_agent_instances pai
             JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
             WHERE pai.id = ?`,
          ).get(agentInstanceId) as { enabled: number } | undefined;
          if (!targetProfile) {
            return `智能体实例 ${agentInstanceId} 不存在`;
          }
          if (!targetProfile.enabled) {
            const msg = `智能体实例 ${agentInstanceId} 已被禁用，无法委派任务`;
            runRepo.addEvent(parentRunId, 'delegate.rejected', { reason: 'agent_disabled', agentInstanceId });
            return msg;
          }

          // 安全限制 2: 委派深度最多 2 层
          const ancestorChain = runRepo.getAncestorChain(parentRunId);
          const depth = ancestorChain.length;
          if (depth >= 2) {
            const msg = `委派深度 ${depth} 已达到上限 2 层，已禁止继续向下委派`;
            runRepo.addEvent(parentRunId, 'delegate.rejected', { reason: 'max_depth', depth, agentInstanceId });
            return msg;
          }

          // 安全限制 3: 禁止循环委派（目标智能体已在祖先链中）
          const ancestorInstanceIds = new Set(ancestorChain.map((r) => r.agentInstanceId));
          if (ancestorInstanceIds.has(agentInstanceId)) {
            const msg = `循环委派检测: 智能体 ${agentInstanceId} 已在当前 Run 的祖先链中，已禁止`;
            runRepo.addEvent(parentRunId, 'delegate.rejected', { reason: 'cycle_detected', agentInstanceId });
            return msg;
          }

          // 安全限制 4: 每条 triggerMessage 最多 20 个 Run
          const triggerMessageId = ancestorChain.length > 0 ? ancestorChain[ancestorChain.length - 1]!.triggerMessageId : null;
          if (triggerMessageId) {
            const runCount = runRepo.countRunsByTrigger(triggerMessageId);
            if (runCount >= 20) {
              const msg = `消息 ${triggerMessageId} 已产生 ${runCount} 个 Run，达到上限 20，禁止继续委派`;
              runRepo.addEvent(parentRunId, 'delegate.rejected', { reason: 'max_runs_per_message', count: runCount, triggerMessageId });
              return msg;
            }
          }

          const subRun = runRepo.create({
            projectId,
            agentInstanceId,
            requestedByType: 'agent',
            requestedById: ancestorChain[0]?.agentInstanceId ?? parentRunId,
            instruction,
            parentRunId,
            ...(triggerMessageId ? { triggerMessageId } : {}),
            modelProfileSnapshotJson: buildModelProfileSnapshot(db, agentInstanceId),
          });
          runRepo.addEvent(parentRunId, 'delegate', {
            subRunId: subRun.id,
            agentInstanceId,
            instruction: instruction.slice(0, 200),
          });

          if (scheduler) {
            scheduler.enqueue({
              runId: subRun.id,
              projectId,
              agentInstanceId,
              instruction,
              triggerMessageId: triggerMessageId ?? '',
            });
            return `任务已委派给智能体 ${agentInstanceId}，子 Run ID: ${subRun.id}（深度 ${depth + 1}）`;
          }
          return `子 Run 已创建 (${subRun.id})，但调度器未连接，需手动触发`;
        } catch (err) {
          return `委派失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'publish_artifact',
      description: '将生成的成果文件发布到工作区',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          relativePath: { type: 'string', description: '文件相对路径，必须以 outputs/ 开头（如 outputs/plans/report.md）' },
          content: { type: 'string', description: '文件内容' },
          note: { type: 'string', description: '成果说明（可选）' },
        },
        required: ['projectId', 'relativePath', 'content'],
      },
      requiredCapabilities: ['write:output'],
      allowedPathPrefixes: ['outputs/'],
      maxContentLength: 50000,
      async execute(args) {
        const { projectId, relativePath, content, note } = args as {
          projectId: string; relativePath: string; content: string; note?: string;
        };
        try {
          const normalized = String(relativePath ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
          if (!normalized.startsWith('outputs/') || normalized.includes('..')) {
            return '发布失败: 成果文件必须位于 outputs/ 目录';
          }
          const projectRoot = getProjectRoot(projectId);
          const filePath = join(projectRoot, normalized);
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, content, 'utf8');
          const result = `成果已发布到 ${normalized}${note ? ` (说明: ${note})` : ''}`;
          return result;
        } catch (err) {
          return `发布失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ]);
}
