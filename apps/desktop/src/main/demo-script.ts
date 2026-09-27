import { copyFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BrowserWindow } from 'electron';
import { FileRepository, MessageRepository } from '@kunqing/database';
import { getProjectRoot } from './paths';
import { broadcastEvent } from './event-broadcast';

/**
 * The asset design demo is intentionally a small, persisted state machine.
 * It is keyed by the project id after the name check, so it cannot intercept
 * ordinary chats or alter the normal scheduler/agent loop.
 */
export type AssetDemoPhase =
  | 'idle'
  | 'waiting-selection'
  | 'waiting-optimization-confirmation'
  | 'waiting-3d-confirmation'
  | 'waiting-label-save'
  | 'completed';

type AssetDemoState = {
  phase: AssetDemoPhase;
  /** Unique generation so a re-run can create fresh messages without deleting history. */
  generation?: number;
  lastHandledUserMessageId?: string;
  startedAt?: string;
  updatedAt?: string;
  labelCardPath?: string;
  labelCardSentAt?: number;
};

type DemoAgent = { id: string; name: string };
type DemoMention = { target: { scope: 'instance' | 'user'; id: string }; label: string; start: number; end: number };

const DEMO_GROUP_NAME = '标品资产设计与入库';
const DEMO_DIR = 'E:/codex_program/鲲擎智能体集成工作站/演示材料';
const DEMO_AGENTS: Array<{ key: string; name: string }> = [
  { key: 'orchestrator', name: '统筹规划智能体' },
  { key: 'trend', name: '流行趋势智能体' },
  { key: 'local', name: '本地执行智能体' },
  { key: 'three-d', name: '3D生成智能体' },
  { key: 'asset', name: '资产管理智能体' },
];

const REPORT = '演示材料/流行趋势分析报告.md.txt';
const SOFA_IMAGE = '演示材料/沙发设计效果图.png';
const OPTIMIZED_IMAGE = '演示材料/沙发设计效果图优化方案.png';
const HTML_MODEL = '演示材料/单资产3D漫游.html';
const GLB_MODEL = '演示材料/green armchair 3d model.glb';
const WHITE_IMAGE = '演示材料/白底效果图.jpg';
const LABEL_CARD = '演示材料/沙发资产标签卡.html';
const MATERIAL_OUTPUT_NAMES: Record<string, string> = {
  [REPORT]: '流行趋势分析报告.md',
};
const SCRIPT_DELAY_MS = {
  openingToTrend: 3_000, trendReply: 14_000, trendToLocal: 3_000,
  localAnalysis: 18_000, localOptions: 36_000, selectionToOptimization: 2_000,
  optimizationReply: 23_000, optimizationTo3d: 3_000, threeDGeneration: 68_000,
  threeDHtml: 500, threeDModel: 500, threeDConfirm: 2_000,
  assetTagging: 6_000, assetCard: 23_000, assetCardSent: 500, labelReview: 8_000, finalDelivery: 5_000,
} as const;

/** The approved script is the sole source of every agent-visible sentence. */
const SCRIPT_LINES = {
  trendDispatch: `收到。\n\n@流行趋势智能体\n你定位下现在南洋中古这条线比较流行什么，重点看一下造型、颜色和材质。\n这次整体方向希望年轻，同时保留中古的感觉。`,
  trendAnalysis: `我分析了最近的趋势。\n\n现在南洋中古的产品，其实没有那么强调传统的复杂装饰了，整体会更简洁一些。\n造型上比较流行圆润、低矮的比例，坐感看起来会比较松弛。\n颜色上，焦糖、咖啡、奶油、橄榄绿这几个方向都比较合适。\n材质还是比较适合木头搭配布艺，木作能够把中古的感觉撑起来。\n如果这次想年轻一点，我建议不要把复古元素堆得太满。\n可以把重点放在木作比例、软包形态和整体轮廓上。`,
  localDispatch: `@本地执行智能体\n\n沙发产品的趋势已经分析完成。\n结合刚才的趋势，去我们工作区检索是否有可以沿用的设计语言规则，尽量把积累的设计经验与所需的规则梳理出来，并直接输出图片。`,
  localAnalysis: `我已经找到本地的家具设计语言规则。\n\n本地现有的有几组圆润扶手、低矮比例和木质结构的设计语言，与本次沙发设计的方向比较接近。我会保留这几组设计语言，再结合刚才的趋势往南洋中古方向调整。颜色我会压得年轻一点，不让整体看起来太老。我先出输出4版设计参考图。`,
  localOptions: `4版沙发设计图片已经输出。\n* 第一版中古味会更明显一些，木作比例也比较突出。\n* 第二版用了橄榄绿，整体会年轻、时髦一点。\n* 第三版会更轻一些，奶油暖棕的感觉比较明显。\n* 第四版整体偏深咖，会更沉稳。\n@鲲擎牛来\n你先看一下，这4版中哪一版更接近你的设计需求与方向。`,
  optimizationStart: '收到。我就沿着A继续调整。整体造型不变，我主要把木作、材质和中古细节往前推一点。针对方案A再给你修改1个版本。',
  optimizationWait: '@鲲擎牛来\n方案A的修改已经完成。请确认修改版本是否符合你的需求，如果还有其他修改需求，请直接回复我。',
  localConfirmed: '@统筹智能体\n收到，我将采用第三章视觉方案作为定稿。',
  threeDDispatch: '@3D生成智能体\n把沙发主体提取出来，按照这个方案做3D。最后给我出标准白底渲染图。',
  threeDReceived: '收到。我按照确认的这张图来处理。沙发主体会单独提取出来，结构和材质一起处理。完成以后输出白底渲染效果图。',
  threeDWait: '@鲲擎牛来\n3Dmax文件已经完成打包。我已经输出3D漫游html文件。白底效果图也已经同步输出，请确认当前模型效果是否满足需求。',
  assetDispatch: '@资产管理智能体\n请负责最后达标入库环节。按照我们现在的资产规则，把这款沙发完整打标。名称、品类、风格、造型、材质、颜色、体量和使用场景都整理出来。',
  assetReceived: '收到。我先根据现在确认的图片和3D结果进行识别。这款产品的主体比较明确，是一款单人休闲沙发。\n\n整体风格属于南洋中古方向，木质和布艺是主要材质关系。颜色以橄榄绿为主，木作部分偏深胡桃色。造型上比较明显的是圆润、低矮、弧形扶手和厚软包。功能上主要是休闲、阅读和单人坐。我把这些整理成标准资产标签。',
  assetWait: '@鲲擎牛来\n文件已发送，你看一下是否需要修改。',
  assetComplete: '@统筹智能体\n我已按照你的需求进行修改。\n* 结构特征中，删除“雕塑感”标签；\n* 占地情况中删除“叠放：不可叠放”标签；\n其余标签全部保持不变。我已经重新检查，目前没有发现标签之间的冲突。符合入库要求，已入库。',
  summary: '@鲲擎牛来\n\n本次任务已全部执行结束。\n从趋势分析、调用我们自己的设计积累、AI出图、3D生成，再到最后的资产打标和入库。图片、3D模型、白底渲染图和结构化标签都已经关联。现在这款沙发已经变成一个可以被企业持续调用的数字资产。',
} as const;

const now = (): string => new Date().toISOString();
const idFor = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class AssetDemoScript {
  private readonly messageRepo: MessageRepository;
  private readonly fileRepo: FileRepository;
  private readonly stateTimers = new Map<string, NodeJS.Timeout>();
  private readonly projectLocks = new Map<string, Promise<boolean>>();

  constructor(private readonly db: Database.Database, private readonly windowProvider: () => BrowserWindow | undefined) {
    this.messageRepo = new MessageRepository(db);
    this.fileRepo = new FileRepository(db);
  }

  private isTargetProject(projectId: string): boolean {
    const row = this.db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name?: string } | undefined;
    return row?.name?.trim() === DEMO_GROUP_NAME;
  }

  private readState(projectId: string): AssetDemoState {
    try {
      const row = this.db.prepare('SELECT value_json as valueJson FROM settings WHERE key = ?').get(`asset-demo:${projectId}`) as { valueJson?: string } | undefined;
      if (!row?.valueJson) return { phase: 'idle', generation: 1 };
      const parsed = JSON.parse(row.valueJson) as AssetDemoState;
      return parsed && typeof parsed.phase === 'string'
        ? { ...parsed, generation: typeof parsed.generation === 'number' && Number.isFinite(parsed.generation) ? parsed.generation : 1 }
        : { phase: 'idle', generation: 1 };
    } catch {
      return { phase: 'idle' };
    }
  }

  private writeState(projectId: string, state: AssetDemoState): void {
    const valueJson = JSON.stringify({ ...state, updatedAt: now() });
    const updatedAt = now();
    this.db.prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(`asset-demo:${projectId}`, valueJson, updatedAt);
  }

  private ensureAgents(projectId: string): DemoAgent[] {
    const result: DemoAgent[] = [];
    for (const definition of DEMO_AGENTS) {
      const profileId = `asset-demo-profile-${definition.key}`;
      const instanceId = `asset-demo-instance-${definition.key}-${projectId}`;
      this.db.prepare(
        `INSERT OR IGNORE INTO agent_profiles
         (id, name, definition_id, definition_version, runtime_mode, overrides_json, enabled, delegatable, is_system_default, created_at, updated_at)
         VALUES (?, ?, ?, '1.0.0', 'native-model', '{}', 1, 1, 0, ?, ?)`,
      ).run(profileId, definition.name, `asset-demo.${definition.key}`, now(), now());
      // Demo members are part of the fixed script. Recover visibility if an
      // earlier run or manual test disabled one of their profiles.
      this.db.prepare('UPDATE agent_profiles SET enabled = 1, updated_at = ? WHERE id = ?').run(now(), profileId);
      this.db.prepare(
        `INSERT OR IGNORE INTO project_agent_instances
         (id, project_id, agent_profile_id, definition_id, definition_version, role, runtime_mode, ordinal, created_at)
         VALUES (?, ?, ?, ?, '1.0.0', 'teammate', 'native-model', ?, ?)`,
      ).run(instanceId, projectId, profileId, `asset-demo.${definition.key}`, 100 + result.length, now());
      result.push({ id: instanceId, name: definition.name });
    }
    return result;
  }

  /** Ensure the fixed demo roster exists before the renderer reads members. */
  ensureProjectAgents(projectId: string): boolean {
    if (!this.isTargetProject(projectId)) return false;
    this.ensureAgents(projectId);
    return true;
  }

  private agentId(projectId: string, key: string): string {
    return `asset-demo-instance-${key}-${projectId}`;
  }

  private senderIdForKey(projectId: string, key: string): string {
    const actorByMessageKey: Record<string, string> = {
      'dispatch-trend': 'orchestrator',
      'dispatch-local': 'orchestrator',
      'dispatch-3d': 'orchestrator',
      'dispatch-asset': 'orchestrator',
      'trend-report': 'trend',
      'trend-report-analysis': 'trend',
      'trend-report-caption': 'trend',
      'local-analysis-result': 'local',
      'sofa-option': 'local',
      'sofa-optimized': 'local',
      'optimization-start': 'local',
      'wait-selection': 'local',
      'wait-optimization': 'local',
      'local-confirmation': 'local',
      'three-d-received': 'three-d',
      'three-d-html': 'three-d',
      'three-d-html-caption': 'three-d',
      'three-d-glb': 'three-d',
      'three-d-glb-caption': 'three-d',
      'three-d-white': 'three-d',
      'wait-3d': 'three-d',
      'asset-tagging-received': 'asset',
      'asset-label-card': 'asset',
      'asset-label-card-caption': 'asset',
      'wait-label-save': 'asset',
      'label-reminder': 'asset',
      'asset-final': 'asset',
      summary: 'orchestrator',
    };
    const actor = actorByMessageKey[key] ?? key;
    return this.agentId(projectId, actor);
  }

  private messageId(projectId: string, generation: number, key: string): string {
    return idFor(`asset-demo-message:${projectId}:${generation}:${key}`);
  }

  /**
   * The demo has no real agent_run row by design, but it should still render
   * the same transient execution bubble as ordinary chats. These events are
   * intentionally ephemeral: they only drive the renderer while a scripted
   * delay is in progress and are completed before the scripted result lands.
   */
  private setExecuting(projectId: string, key: string, agentKey: string, stage: string, status: 'running' | 'completed'): void {
    const win = this.windowProvider();
    if (!win || win.isDestroyed()) return;
    const generation = this.readState(projectId).generation ?? 1;
    broadcastEvent(win, {
      type: 'run.status',
      projectId,
      run: {
        id: `asset-demo-run-${generation}-${key}`,
        agentId: this.agentId(projectId, agentKey),
        agentName: DEMO_AGENTS.find((agent) => agent.key === agentKey)?.name ?? '智能体',
        status,
        stage,
        createdAt: now(),
      },
    });
  }

  private async executeDelay(projectId: string, key: string, agentKey: string, stage: string, duration: number): Promise<void> {
    this.setExecuting(projectId, key, agentKey, stage, 'running');
    await sleep(duration);
    this.setExecuting(projectId, key, agentKey, `${stage}已完成`, 'completed');
  }

  /** Persist rich @ metadata so normal mention highlighting also applies to the fixed demo. */
  private mentionsFor(projectId: string, text: string): DemoMention[] {
    const candidates: Array<{ label: string; target: DemoMention['target'] }> = [
      ...DEMO_AGENTS.map((agent) => ({ label: agent.name, target: { scope: 'instance' as const, id: this.agentId(projectId, agent.key) } })),
      { label: '鲲擎牛来', target: { scope: 'user' as const, id: 'local-user' } },
      { label: '用户', target: { scope: 'user' as const, id: 'local-user' } },
    ];
    return candidates.flatMap(({ label, target }) => {
      const token = `@${label}`;
      const start = text.indexOf(token);
      return start < 0 ? [] : [{ target, label, start, end: start + token.length }];
    });
  }

  private emit(projectId: string, key: string, text: string, options: { markdown?: boolean; filePath?: string; sender?: string; generation?: number } = {}): void {
    const senderId = options.sender ?? this.senderIdForKey(projectId, key);
    const generation = options.generation ?? this.readState(projectId).generation ?? 1;
    const messageId = this.messageId(projectId, generation, key);
    const contentJson = JSON.stringify({ schemaVersion: 1, text, mentions: this.mentionsFor(projectId, text), audience: { scope: 'broadcast' }, ...(options.markdown ? { messageType: 'demo' } : {}) });
    const nowIso = now();
    const inserted = this.db.prepare(
      `INSERT OR IGNORE INTO messages
       (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at)
       VALUES (?, ?, 'agent', ?, 'text', ?, 'sent', ?, ?)`,
    ).run(messageId, projectId, senderId, contentJson, nowIso, nowIso);
    if (inserted.changes === 0) return;
    const win = this.windowProvider();
    if (win && !win.isDestroyed()) broadcastEvent(win, { type: 'message.committed', projectId, messageId, senderId, kind: 'text', content: contentJson });
  }

  private async materialize(projectId: string, sourceRelative: string): Promise<{ relativePath: string; fileId: string }> {
    // The demo constants historically used both `foo.ext` and
    // `演示材料/foo.ext`; normalize both forms against the material root.
    const materialRelative = sourceRelative.replace(/^演示材料[\\/]/, '');
    const source = join(DEMO_DIR, materialRelative);
    if (!existsSync(source)) throw new Error(`演示材料不存在：${source}`);
    const projectRoot = getProjectRoot(projectId);
    const targetDir = join(projectRoot, 'outputs', '标品资产设计与入库演示');
    await mkdir(targetDir, { recursive: true });
    const targetName = MATERIAL_OUTPUT_NAMES[sourceRelative] ?? basename(source);
    const target = join(targetDir, targetName);
    await copyFile(source, target);
    const relativePath = `outputs/标品资产设计与入库演示/${targetName}`;
    const bytes = await (await import('node:fs/promises')).readFile(target);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = this.fileRepo.getByPath('project', projectId, relativePath);
    const file = existing ?? this.fileRepo.create({
      scopeType: 'project', scopeId: projectId, parentId: 'outputs/标品资产设计与入库演示', type: 'file',
      name: targetName, normalizedPath: relativePath, mimeType: '', origin: 'artifact',
    });
    const current = file.currentVersionId ? this.fileRepo.getVersion(file.currentVersionId) : null;
    if (!current || current.sha256 !== sha256) {
      this.fileRepo.createVersion({
        fileId: file.id, storageRelPath: relativePath, size: bytes.length, sha256,
        createdByType: 'system', createdById: 'asset-demo', changeNote: 'asset-demo-material',
      });
    }
    this.fileRepo.markReady(file.id);
    return { relativePath, fileId: file.id };
  }

  private async emitImage(projectId: string, key: string, source: string, caption: string): Promise<void> {
    const file = await this.materialize(projectId, source);
    this.emit(projectId, key, `${caption}\n\n![${caption}](app-file://file/${file.fileId})`, { markdown: true });
  }

  private async emitArtifact(projectId: string, key: string, source: string, caption: string): Promise<string> {
    const file = await this.materialize(projectId, source);
    const generation = this.readState(projectId).generation ?? 1;
    const messageId = this.messageId(projectId, generation, key);
    const contentJson = JSON.stringify({ schemaVersion: 1, text: file.relativePath, fileId: file.fileId, mentions: [], audience: { scope: 'broadcast' } });
    const nowIso = now();
    const inserted = this.db.prepare(
      `INSERT OR IGNORE INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at)
       VALUES (?, ?, 'agent', ?, 'artifact', ?, 'sent', ?, ?)`,
    ).run(messageId, projectId, this.senderIdForKey(projectId, key), contentJson, nowIso, nowIso);
    if (inserted.changes > 0) {
      this.db.prepare('INSERT OR IGNORE INTO message_attachments (message_id, file_id, version_id, ordinal) VALUES (?, ?, ?, 0)')
        .run(messageId, file.fileId, this.fileRepo.getById(file.fileId)?.currentVersionId ?? '');
      const win = this.windowProvider();
      if (win && !win.isDestroyed()) broadcastEvent(win, { type: 'message.committed', projectId, messageId, senderId: this.senderIdForKey(projectId, key), kind: 'artifact', content: contentJson });
    }
    if (caption) this.emit(projectId, `${key}-caption`, caption, { sender: this.senderIdForKey(projectId, key), generation });
    return file.relativePath;
  }

  private async startLabelWatcher(projectId: string, state: AssetDemoState): Promise<void> {
    const path = state.labelCardPath;
    const sentAt = state.labelCardSentAt ?? Date.now();
    if (!path) return;
    const existing = this.stateTimers.get(projectId);
    if (existing) clearInterval(existing);
    const timer = setInterval(async () => {
      try {
        const info = await stat(path);
        if (info.mtimeMs <= sentAt) return;
        this.completeLabelSave(projectId);
      } catch { /* The user may still be editing or the preview is closed. */ }
    }, 1_500);
    this.stateTimers.set(projectId, timer);
  }

  private completeLabelSave(projectId: string): boolean {
    const state = this.readState(projectId);
    if (state.phase === 'completed') return false;
    if (state.phase !== 'waiting-label-save') return false;
    const timer = this.stateTimers.get(projectId);
    if (timer) clearInterval(timer);
    this.stateTimers.delete(projectId);
    this.writeState(projectId, { ...state, phase: 'completed' });
    const generation = state.generation ?? 1;
    this.setExecuting(projectId, 'asset-entry', 'asset', '正在完成资产入库', 'running');
    const finishTimer = setTimeout(() => {
      const current = this.readState(projectId);
      if (current.phase !== 'completed' || current.generation !== generation) return;
      this.setExecuting(projectId, 'asset-entry', 'asset', '资产入库已完成', 'completed');
      this.emit(projectId, 'asset-final', SCRIPT_LINES.assetComplete, { generation });
      this.setExecuting(projectId, 'demo-summary', 'orchestrator', '正在汇总本次任务成果', 'running');
      const summaryTimer = setTimeout(() => {
        const finalState = this.readState(projectId);
        if (finalState.phase === 'completed' && finalState.generation === generation) {
          this.setExecuting(projectId, 'demo-summary', 'orchestrator', '任务成果汇总已完成', 'completed');
          this.emit(projectId, 'summary', SCRIPT_LINES.summary, { generation });
        }
      }, SCRIPT_DELAY_MS.finalDelivery);
      this.stateTimers.set(projectId, summaryTimer);
    }, SCRIPT_DELAY_MS.labelReview);
    this.stateTimers.set(projectId, finishTimer);
    return true;
  }

  /** Reset only the demo state. Historical messages remain in SQLite and are hidden by the renderer boundary. */
  reset(projectId: string): { accepted: boolean } {
    if (!this.isTargetProject(projectId)) return { accepted: false };
    const timer = this.stateTimers.get(projectId);
    if (timer) clearInterval(timer);
    this.stateTimers.delete(projectId);
    this.writeState(projectId, { phase: 'idle', generation: Date.now() });
    this.ensureAgents(projectId);
    return { accepted: true };
  }

  /** Resume a persisted label-card wait after the desktop process restarts. */
  async resumePending(): Promise<void> {
    const projects = this.db.prepare('SELECT id FROM projects WHERE name = ? AND status != \'archived\'').all(DEMO_GROUP_NAME) as Array<{ id: string }>;
    for (const project of projects) {
      const state = this.readState(project.id);
      if (state.phase === 'waiting-label-save' && state.labelCardPath) {
        await this.startLabelWatcher(project.id, state);
      }
    }
  }

  /** Mark the user-facing Save action without relying on filesystem mtime. */
  markLabelSaved(projectId: string): { accepted: boolean; completed: boolean } {
    if (!this.isTargetProject(projectId)) return { accepted: false, completed: false };
    const state = this.readState(projectId);
    if (state.phase === 'completed') return { accepted: true, completed: true };
    const completed = this.completeLabelSave(projectId);
    return { accepted: state.phase === 'waiting-label-save', completed };
  }

  private async processUserMessage(projectId: string, text: string, userMessageId?: string): Promise<boolean> {
    if (!this.isTargetProject(projectId)) return false;
    const state = this.readState(projectId);
    if (userMessageId && state.lastHandledUserMessageId === userMessageId) return true;
    this.ensureAgents(projectId);
    const win = this.windowProvider();
    if (win && !win.isDestroyed()) broadcastEvent(win, { type: 'project.agents.changed', projectId });
    if (state.phase === 'idle') {
      const nextState = { ...state, phase: 'waiting-selection' as const, startedAt: now(), ...(userMessageId ? { lastHandledUserMessageId: userMessageId } : {}) };
      await this.executeDelay(projectId, 'trend-dispatch', 'orchestrator', '正在梳理设计需求', SCRIPT_DELAY_MS.openingToTrend);
      this.emit(projectId, 'dispatch-trend', SCRIPT_LINES.trendDispatch);
      await this.executeDelay(projectId, 'trend-analysis', 'trend', '正在分析流行趋势', SCRIPT_DELAY_MS.trendReply);
      this.emit(projectId, 'trend-report-analysis', SCRIPT_LINES.trendAnalysis);
      await this.emitArtifact(projectId, 'trend-report', REPORT, '');
      await this.executeDelay(projectId, 'local-dispatch', 'orchestrator', '正在安排设计方案任务', SCRIPT_DELAY_MS.trendToLocal);
      this.emit(projectId, 'dispatch-local', SCRIPT_LINES.localDispatch);
      await this.executeDelay(projectId, 'local-analysis', 'local', '正在结合企业设计积累生成方案', SCRIPT_DELAY_MS.localAnalysis);
      this.emit(projectId, 'local-analysis-result', SCRIPT_LINES.localAnalysis);
      await this.executeDelay(projectId, 'local-options', 'local', '正在完善设计方案说明', SCRIPT_DELAY_MS.localOptions);
      await this.emitImage(projectId, 'sofa-option', SOFA_IMAGE, '');
      await this.executeDelay(projectId, 'local-options-caption', 'local', '正在整理方案说明', 5_000);
      this.emit(projectId, 'wait-selection', SCRIPT_LINES.localOptions);
      this.writeState(projectId, nextState);
      return true;
    }
    if (state.phase === 'waiting-selection') {
      const nextState = { ...state, phase: 'waiting-optimization-confirmation' as const, ...(userMessageId ? { lastHandledUserMessageId: userMessageId } : {}) };
      await this.executeDelay(projectId, 'optimization-start', 'local', '正在理解修改要求', SCRIPT_DELAY_MS.selectionToOptimization);
      this.emit(projectId, 'optimization-start', SCRIPT_LINES.optimizationStart);
      await this.executeDelay(projectId, 'optimization', 'local', '正在生成优化方案', SCRIPT_DELAY_MS.optimizationReply);
      await this.emitImage(projectId, 'sofa-optimized', OPTIMIZED_IMAGE, '');
      await this.executeDelay(projectId, 'optimization-caption', 'local', '正在整理修改说明', 3_000);
      this.emit(projectId, 'wait-optimization', SCRIPT_LINES.optimizationWait);
      this.writeState(projectId, nextState);
      return true;
    }
    if (state.phase === 'waiting-optimization-confirmation') {
      const nextState = { ...state, phase: 'waiting-3d-confirmation' as const, ...(userMessageId ? { lastHandledUserMessageId: userMessageId } : {}) };
      await this.executeDelay(projectId, 'local-confirmation', 'local', '正在确认最终视觉方案', 2_000);
      this.emit(projectId, 'local-confirmation', SCRIPT_LINES.localConfirmed);
      await this.executeDelay(projectId, 'three-d-dispatch', 'orchestrator', '正在安排 3D 生成任务', SCRIPT_DELAY_MS.optimizationTo3d);
      this.emit(projectId, 'dispatch-3d', SCRIPT_LINES.threeDDispatch);
      await this.executeDelay(projectId, 'three-d-received', 'three-d', '正在解析确认方案', 2_000);
      this.emit(projectId, 'three-d-received', SCRIPT_LINES.threeDReceived);
      await this.executeDelay(projectId, 'three-d-generation', 'three-d', '正在生成 3D 资产', SCRIPT_DELAY_MS.threeDGeneration);
      await this.emitArtifact(projectId, 'three-d-html', HTML_MODEL, '');
      await this.executeDelay(projectId, 'three-d-glb-delay', 'three-d', '正在导出 3D 模型文件', SCRIPT_DELAY_MS.threeDHtml);
      await this.emitArtifact(projectId, 'three-d-glb', GLB_MODEL, '');
      await this.executeDelay(projectId, 'three-d-white-delay', 'three-d', '正在输出白底效果图', SCRIPT_DELAY_MS.threeDModel);
      await this.emitImage(projectId, 'three-d-white', WHITE_IMAGE, '');
      await this.executeDelay(projectId, 'three-d-confirmation', 'three-d', '正在整理 3D 交付结果', SCRIPT_DELAY_MS.threeDConfirm);
      this.emit(projectId, 'wait-3d', SCRIPT_LINES.threeDWait);
      this.writeState(projectId, nextState);
      return true;
    }
    if (state.phase === 'waiting-3d-confirmation') {
      // Materialize exactly once. The copy mtime is the watcher baseline;
      // copying a second time here would look like a user edit.
      await this.executeDelay(projectId, 'asset-dispatch', 'orchestrator', '正在安排资产入库任务', 3_000);
      this.emit(projectId, 'dispatch-asset', SCRIPT_LINES.assetDispatch);
      await this.executeDelay(projectId, 'asset-tagging', 'asset', '正在识别资产信息', SCRIPT_DELAY_MS.assetTagging);
      this.emit(projectId, 'asset-tagging-received', SCRIPT_LINES.assetReceived);
      await this.executeDelay(projectId, 'asset-card', 'asset', '正在生成资产标签卡', SCRIPT_DELAY_MS.assetCard);
      const relativePath = await this.emitArtifact(projectId, 'asset-label-card', LABEL_CARD, '');
      const labelCardPath = join(getProjectRoot(projectId), relativePath);
      const labelCardInfo = await stat(labelCardPath);
      const nextState: AssetDemoState = { ...state, phase: 'waiting-label-save', labelCardPath, labelCardSentAt: labelCardInfo.mtimeMs };
      await this.executeDelay(projectId, 'asset-card-sent', 'asset', '正在发送资产标签卡', SCRIPT_DELAY_MS.assetCardSent);
      this.emit(projectId, 'wait-label-save', SCRIPT_LINES.assetWait);
      this.writeState(projectId, { ...nextState, ...(userMessageId ? { lastHandledUserMessageId: userMessageId } : {}) });
      await this.startLabelWatcher(projectId, nextState);
      return true;
    }
    if (state.phase === 'waiting-label-save') {
      // A user reply is treated as a harmless reminder; the actual transition
      // is driven by the saved file mtime so an unrelated chat message cannot
      // prematurely complete the demo.
      this.emit(projectId, 'label-reminder', '请先保存右侧的沙发资产标签卡，保存完成后我会继续入库。', { ...(typeof state.generation === 'number' ? { generation: state.generation } : {}) });
      if (userMessageId) this.writeState(projectId, { ...state, lastHandledUserMessageId: userMessageId });
      return true;
    }
    return state.phase === 'completed';
  }

  /**
   * One active demo transition per project. A duplicated UI submit while a stage
   * is still emitting is acknowledged but cannot advance the next stage early.
   */
  async handleUserMessage(projectId: string, text: string, userMessageId?: string): Promise<boolean> {
    if (this.projectLocks.has(projectId)) return true;
    const task = this.processUserMessage(projectId, text, userMessageId);
    this.projectLocks.set(projectId, task);
    try {
      return await task;
    } finally {
      if (this.projectLocks.get(projectId) === task) this.projectLocks.delete(projectId);
    }
  }
}
