import type Database from 'better-sqlite3';
import { BrowserWindow, WebContentsView, type Rectangle, type WebFrameMain } from 'electron';
import { appendFile, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import type { ModelGateway } from './model-gateway';
import { SkillRegistry } from './skill-registry';
import { getLogger } from './logger';
import { getEnterpriseProjectRoot, getProjectTempRunRoot, getStudioRoot } from './paths';
import { ensureEnterpriseProjectWorkspace } from './enterprise-project-workspace';
import { ensureAgentIdentityFiles } from './agent-identity';
import { formatHybridKnowledgeResult, searchHybridKnowledge } from './hybrid-knowledge-search';

export type OperationPlatformInput = {
  id: string;
  name: string;
  url: string;
  description?: string;
  agentName?: string;
  modelProfileId?: string;
  temperature?: number;
};

export type OperationTraceEvent = {
  type: 'navigate' | 'click' | 'input' | 'select' | 'press' | 'submit' | 'scroll' | 'network-response';
  timestamp: string;
  url: string;
  selectorCandidates?: string[];
  role?: string;
  accessibleName?: string;
  text?: string;
  fieldKey?: string;
  inputType?: string;
  value?: string;
  sensitive?: boolean;
  key?: string;
  scrollX?: number;
  scrollY?: number;
  status?: number;
  mimeType?: string;
  screenshotRelPath?: string;
  locator?: OperationStepLocator;
  framePath?: number[];
  /** URL of the frame that emitted the event. Main-frame events use the page URL. */
  frameUrl?: string;
  /** The original target and composed-path evidence for delegated DOM events. */
  domSource?: OperationStepLocator;
  domPath?: OperationStepLocator[];
  nativeEventTrusted?: boolean;
  domInteraction?: OperationDomInteraction;
};

export type OperationStepLocator = {
  text?: string;
  accessibleName?: string;
  role?: string;
  tag?: string;
  href?: string;
  id?: string;
  name?: string;
  placeholder?: string;
  title?: string;
  testId?: string;
  ancestorText?: string;
};

export type OperationWorkflowStep = {
  id: string;
  title: string;
  purpose?: string;
  when?: string;
  expected?: string;
  action: 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'scroll' | 'wait' | 'extract';
  url?: string;
  /** Execution context captured during recording. This may be cross-origin. */
  frameUrl?: string;
  selectorCandidates?: string[];
  locator?: OperationStepLocator;
  recordingScreenshotRelPath?: string;
  value?: string;
  key?: string;
  x?: number;
  y?: number;
  timeoutMs: number;
  /** One business action may contain several delegated DOM events. */
  domInteraction?: OperationDomInteraction;
  /** Runtime binding to the business node that selected this DOM action. */
  businessStepId?: string;
  /** Page/vision decision node without a recorded DOM side effect. */
  stateOnly?: boolean;
  /** Original DOM evidence represented by a runtime-collapsed action. */
  recordedStepIndexes?: number[];
};

export type OperationDomInteraction = {
  id: string;
  eventTypes: string[];
  source?: OperationStepLocator;
  effective?: OperationStepLocator;
  propagated?: OperationStepLocator[];
  feedbackTypes?: string[];
  feedbackUrls?: string[];
};

export type OperationInputProperty = {
  type: 'string';
  description: string;
  sensitive?: boolean;
  defaultValue?: string;
  source?: 'skill-description' | 'recording' | 'user';
};

export type OperationBusinessStep = {
  id?: string;
  title?: string;
  purpose?: string;
  /**
   * References normalized executable DOM steps. A visual/page-state decision
   * may intentionally have no DOM step of its own.
   */
  domStepIndexes?: number[];
  dependsOn?: string[];
  when?: string;
  kind?: 'state-check' | 'navigation' | 'input' | 'collection' | 'detail' | 'result' | 'other' | string;
  verification?: 'dom' | 'vision' | 'dom-and-vision' | 'page-state' | 'none';
  completionCriteria?: string[];
};

export type OperationWorkflowPlan = {
  goal?: string;
  triggers?: string[];
  preconditions?: string[];
  completionCriteria?: string[];
  decisionRules?: string[];
  fixedFacts?: Record<string, string>;
  /** Business-level workflow. Its length is independent from DOM steps. */
  businessSteps?: OperationBusinessStep[];
  /** Abstract business stages; each stage may contain one or more recorded steps. */
  stages?: Array<{
    id?: string;
    title?: string;
    purpose?: string;
    stepIndexes?: number[];
    dependsOn?: string[];
    /** Optional semantic category. It is advisory; runtime still confirms every step. */
    kind?: 'navigation' | 'input' | 'collection' | 'detail' | 'result' | 'other' | string;
    completionCriteria?: string[];
  }>;
  /** Branches are selected at runtime from the request and page evidence. */
  branches?: Array<{
    id?: string;
    when?: string;
    purpose?: string;
    stepIndexes?: number[];
    targetStepIndex?: number;
    nextStageId?: string;
    /** A branch can explicitly indicate that later recorded steps are unnecessary. */
    terminal?: boolean;
  }>;
};

export type OperationWorkflow = {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  platformId: string;
  ownerAgentId: string;
  allowedDomains: string[];
  inputSchema: { type: 'object'; properties: Record<string, OperationInputProperty>; required: string[] };
  plan?: OperationWorkflowPlan;
  /** DOM steps are an action library; the business plan decides what runs. */
  executionMode?: 'business-driven' | 'legacy-dom';
  steps: OperationWorkflowStep[];
  success: { finalUrl?: string; evidence: string[] };
  fallback: { visionEnabled: boolean; strategy: 'dom-only' | 'dom-then-vision' };
  validation?: {
    status: 'passed';
    checkedAt: string;
    attempts: number;
    summary: string;
    evidence: string[];
  };
  createdAt: string;
};

type BrowserSession = {
  platformId: string;
  host: BrowserWindow;
  view: WebContentsView;
  visible: boolean;
  debuggerReady: boolean;
  currentRecordingId: string | null;
};

type BrowserNavigationState = {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
};

type SkillRow = {
  id: string;
  platformId: string;
  ownerAgentId: string;
  recordingSessionId: string | null;
  name: string;
  description: string;
  version: string;
  status: string;
  packageRelPath: string | null;
  workflowJson: string | null;
  pendingWorkflowJson: string | null;
  pendingSummary: string | null;
  modelProfileId: string | null;
  learningError: string | null;
  learningPhase: 'processing' | 'awaiting-user' | 'ready' | 'failed';
  enabled: number;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  revokedAt: string | null;
};

type LearningAnalysis = {
  summary?: string;
  stepAnnotations?: Array<{
    stepIndex: number;
    title?: string;
    purpose?: string;
    when?: string;
    expected?: string;
    locator?: OperationStepLocator | null;
  }>;
  /** Legacy positional fields. Kept only for older model responses. */
  stepTitles?: string[];
  stepLocators?: Array<OperationStepLocator | null>;
  stepSemantics?: Array<{ purpose?: string; when?: string; expected?: string }>;
  plan?: OperationWorkflowPlan;
  inputDefaults?: Record<string, string>;
  questions?: string[];
  mismatches?: string[];
  ready?: boolean;
  subSkills?: Array<{ name: string; description: string; stepIndexes: number[] }>;
};

type WorkflowSemanticReview = {
  valid?: boolean;
  needsUserInput?: boolean;
  summary?: string;
  issues?: string[];
  repairInstructions?: string[];
  questions?: string[];
  correctedAnalysis?: Partial<LearningAnalysis>;
};

type WorkflowStructuralReview = {
  valid: boolean;
  issues: string[];
  evidence: string[];
};

type LearningResolution = {
  issueId: string;
  question: string;
  mismatch: string | null;
  status: 'pending' | 'resolved' | 'superseded';
  answer: string | null;
  sourcePriority: 'user-description' | 'recording-evidence' | 'user-answer' | null;
  createdAt: string;
  resolvedAt: string | null;
};

type OperationPageSnapshot = {
  url: string;
  title: string;
  text: string;
  links: Array<{ text: string; href: string }>;
  /** Same-origin iframe locations, when the portal keeps modules in frames. */
  frameUrls?: string[];
  interactive?: Array<{ tag: string; text: string; role: string; name: string; value?: string; href?: string }>;
};

type OperationLoopDecision = {
  intent: 'execute' | 'answer' | 'clarify';
  skillId?: string;
  confidence?: number;
  /** The operation agent may hand a complete evidence package to a parent
   * only when its own domain is insufficient. This is intentionally a model
   * decision, not a hard-coded handoff for every page read. */
  needsCollaboration?: boolean;
  collaborationReason?: string;
  collaborationBrief?: string;
  parameters?: Record<string, unknown>;
  businessStepIds?: string[];
  stepIndexes?: number[];
  targetText?: string;
  targetStepIndex?: number;
  reply?: string;
};

type OperationLoopContext = {
  instruction: string;
  platformId: string;
  projectId?: string;
  ownerAgentId: string;
  depth: number;
  /** Root operation run for a single user request. Child skills publish their
   * final business answer back to this run so callers never receive a raw
   * intermediate page snapshot. */
  rootRunId?: string;
  completedSkillIds: string[];
  completedStepIndexes?: Record<string, number[]>;
  authRecoveryAttempts?: number;
  lastSnapshot?: OperationPageSnapshot;
  /** A prerequisite skill can hand control back to the original request. */
  resumeSkillId?: string;
  resumeParameters?: Record<string, unknown>;
};

type OperationStepGateDecision = {
  action: 'execute' | 'skip' | 'clarify' | 'complete';
  confidence?: number;
  targetText?: string;
  targetStepIndex?: number;
  reason?: string;
};

type OperationStepVerification = {
  status: 'confirmed' | 'retry' | 'clarify';
  confidence?: number;
  workflowComplete?: boolean;
  reason?: string;
};

export function operationVerificationIndicatesFailure(reason: string | undefined): boolean {
  if (!reason?.trim()) return false;
  const normalized = reason.replace(/\s+/g, ' ').trim();
  if (/没有异常|无异常|未发现异常|没有失败|未见失败/.test(normalized)) return false;
  return /仍(?:然)?(?:停留|处于)|(?:未|没有|尚未)(?:能|成功)?(?:完成|生效|跳转|进入|打开|找到|显示|改变|达到|触发)|目标.{0,12}(?:未找到|未出现|不匹配)|不符合|执行失败|操作失败|点击失败|错误页面/.test(normalized);
}

export type OperationAgentDecision = {
  intent: 'execute' | 'clarify' | 'answer';
  skillId?: string;
  confidence?: number;
  needsCollaboration?: boolean;
  collaborationReason?: string;
  collaborationBrief?: string;
  parameters?: Record<string, unknown>;
  businessStepIds?: string[];
  stepIndexes?: number[];
  targetText?: string;
  targetStepIndex?: number;
  reply?: string;
};

export type OperationConversationMessage = {
  id: string;
  platformId: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  relatedRunId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

const nowIso = (): string => new Date().toISOString();
const normalizeRelPath = (value: string): string => value.replaceAll('\\', '/');
const safeSegment = (value: string): string => value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || createHash('sha1').update(value).digest('hex').slice(0, 12);
const isMailboxSecretaryPlatform = (platform: { name: string; url: string }): boolean => /邮箱秘书/u.test(platform.name) && /(^|\.)mail\.163\.com\/?/iu.test(platform.url);

function normalizeLearningIssue(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function learningIssueId(question: string, mismatch = ''): string {
  const basis = `${normalizeLearningIssue(question)}|${normalizeLearningIssue(mismatch)}`;
  return createHash('sha1').update(basis).digest('hex').slice(0, 20);
}

function detectLearningSourcePriority(answer: string): LearningResolution['sourcePriority'] {
  const value = answer.replace(/\s+/g, '');
  if (
    /(?:以|按|遵照|依据).{0,10}(?:我|用户|说明|描述|文本|需求|逻辑).{0,8}(?:为准|优先|执行|处理)/.test(value)
    || /(?:我|用户).{0,10}(?:说的|说明|描述|需求|逻辑).{0,8}(?:为准|优先)/.test(value)
  ) return 'user-description';
  if (/(?:以|按|遵照|依据).{0,10}(?:录制|录像|截图|DOM|轨迹|实际操作).{0,8}(?:为准|优先|执行|处理)/i.test(value)) return 'recording-evidence';
  return 'user-answer';
}

function isLearningClarificationResolved(question: string, mismatch: string, resolutions: LearningResolution[]): boolean {
  const resolved = resolutions.filter((item) => item.status === 'resolved');
  const issueId = learningIssueId(question, mismatch);
  if (resolved.some((item) => item.issueId === issueId)) return true;
  const questionKey = normalizeLearningIssue(question);
  const mismatchKey = normalizeLearningIssue(mismatch);
  if (resolved.some((item) => {
    const oldQuestion = normalizeLearningIssue(item.question);
    const oldMismatch = normalizeLearningIssue(item.mismatch ?? '');
    return (questionKey && (questionKey === oldQuestion || questionKey === oldMismatch))
      || (mismatchKey && (mismatchKey === oldQuestion || mismatchKey === oldMismatch));
  })) return true;

  const conflict = `${question}${mismatch}`;
  const mentionsUserMeaning = /用户|说明|描述|文本|需求|逻辑|你说|你的/i.test(conflict);
  const mentionsRecordedEvidence = /录制|录像|截图|画面|DOM|轨迹|页面|实际操作/i.test(conflict);
  if (!mentionsUserMeaning || !mentionsRecordedEvidence) return false;
  return resolved.some((item) => item.sourcePriority === 'user-description' || item.sourcePriority === 'recording-evidence');
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
const safeJson = <T>(value: string | null | undefined, fallback: T): T => {
  try { return JSON.parse(value ?? '') as T; } catch { return fallback; }
};

type OperationInputField = { key: string; label: string; sensitive: boolean };

const inputFieldKey = (event: OperationTraceEvent, index: number): string => safeSegment(event.fieldKey || `field-${index + 1}`);

function cleanFixedValue(value: string): string {
  return value
    .trim()
    .replace(/^["'“”‘’`\s]+|["'“”‘’`\s]+$/g, '')
    .replace(/[。；;，,]+$/g, '')
    .trim();
}

function fieldAliases(field: OperationInputField): string[] {
  const value = `${field.key} ${field.label}`.toLowerCase();
  if (/user(name)?|login|账号|用户名|工号/.test(value)) return ['用户名', '用户账号', '登录账号', '账号', '工号', 'username', 'user name', 'login name', 'login'];
  if (/pass(word)?|pwd|口令|密码/.test(value)) return ['密码', '登录密码', '口令', 'password', 'passwd', 'pwd'];
  if (/验证码|captcha|verification/.test(value)) return ['验证码', '动态码', 'captcha', 'verification code'];
  return [field.label, field.key].filter(Boolean);
}

/** 从技能说明中提取明确写出的固定输入，避免把技能内置账号误判成缺失的用户输入。 */
function extractFixedInputValues(description: string, fields: OperationInputField[]): Record<string, string> {
  const result: Record<string, string> = {};
  const source = description.replace(/[\r\n]+/g, ' ');
  for (const field of fields) {
    const aliases = fieldAliases(field).sort((a, b) => b.length - a.length);
    const alias = aliases.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const pattern = new RegExp(`(?:${alias})\\s*(?:(?:是|为|填写|使用|登录用|账号为|密码为)\\s*[:：=]?|[:：=])\\s*["“”']?([^,，;；。\\n]+)`, 'i');
    const directPattern = new RegExp(`(?:${alias})\\s*["“”']?([A-Za-z0-9_@.\\-]{2,})`, 'i');
    const match = source.match(pattern) ?? source.match(directPattern);
    if (match?.[1]) {
      const value = cleanFixedValue(match[1].replace(/^(?:是|为|和|与|以及|并且)\s*/i, ''));
      if (value && !/^(和|以及|并且|分别)$/i.test(value)) result[field.key] = value;
    }
  }
  // 常见写法：“用户名和密码分别是 A 和 B”。单字段规则无法可靠拆开时补一次成对解析。
  const paired = source.match(/(?:用户名|用户账号|登录账号|账号|username)[^。；;\n]{0,12}(?:密码|password)[^。；;\n]{0,12}(?:分别)?\s*(?:是|为|[:：=])\s*["“”']?([^,，\s]+)\s*(?:和|与|、)\s*["“”']?([^,，。；;\s]+)/i);
  if (paired) {
    const username = fields.find((field) => /user(name)?|login|账号|用户名|工号/i.test(`${field.key} ${field.label}`));
    const password = fields.find((field) => /pass(word)?|pwd|口令|密码/i.test(`${field.key} ${field.label}`));
    if (username && !result[username.key]) result[username.key] = cleanFixedValue(paired[1]!);
    if (password && !result[password.key]) result[password.key] = cleanFixedValue(paired[2]!);
  }
  return result;
}

function normalizeInputDefaults(values: unknown, fields: OperationInputField[]): Record<string, string> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(values)) {
    if (typeof rawValue !== 'string' || !rawValue.trim()) continue;
    const key = rawKey.trim();
    const field = fields.find((candidate) => candidate.key === key)
      ?? fields.find((candidate) => fieldAliases(candidate).some((alias) => alias.toLowerCase() === key.toLowerCase()))
      ?? fields.find((candidate) => `${candidate.key} ${candidate.label}`.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(candidate.key.toLowerCase()));
    if (field) result[field.key] = cleanFixedValue(rawValue);
  }
  return result;
}

/**
 * A recorded skill is a reusable workflow, not an unconditional macro. The
 * planner may select only the steps needed for the current request. The
 * branch selection is decided by the operation agent at runtime. This helper
 * only validates the selected indexes and adds the nearest navigation
 * prerequisite for older skills that do not yet have abstract stages.
 */
const selectWorkflowSteps = (workflow: OperationWorkflow, requested: unknown, instruction = ''): OperationWorkflow => {
  const requestedIndexes = Array.isArray(requested)
    ? Array.from(new Set(requested.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 1 && item <= workflow.steps.length))).sort((a, b) => a - b)
    : [];
  let indexes = requestedIndexes;
  if (isAuthenticationWorkflow(workflow) && (requestedIndexes.length > 0 || /登录|登陆|认证|sign\s*in|log\s*in|扫码/i.test(instruction))) {
    indexes = authenticationStepIndexes(workflow);
  }
  if (indexes.length === 0 || indexes.length === workflow.steps.length) return workflow;
  const selected = indexes.map((index) => workflow.steps[index - 1]).filter((step): step is OperationWorkflowStep => !!step);
  if (!selected.length) return workflow;
  const firstIndex = indexes[0]! - 1;
  const prerequisite = workflow.steps.slice(0, firstIndex).reverse().find((step) => step.action === 'navigate');
  const steps = prerequisite && selected[0]?.id !== prerequisite.id ? [prerequisite, ...selected] : selected;
  return { ...workflow, steps };
};

const recordedStepNumber = (step: OperationWorkflowStep): number | null => {
  const match = /^step-(\d+)$/.exec(step.id);
  return match ? Number(match[1]) : null;
};

const representedStepNumbers = (step: OperationWorkflowStep): number[] => {
  const explicit = step.recordedStepIndexes?.filter((value) => Number.isInteger(value) && value > 0) ?? [];
  if (explicit.length > 0) return Array.from(new Set(explicit)).sort((left, right) => left - right);
  const recorded = recordedStepNumber(step);
  return recorded === null ? [] : [recorded];
};

function operationStepSemanticLabels(step: OperationWorkflowStep): string[] {
  return Array.from(new Set([
    step.title,
    step.locator?.text,
    step.locator?.accessibleName,
    step.locator?.ancestorText,
    step.domInteraction?.source?.text,
    step.domInteraction?.source?.accessibleName,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.replace(/^[^“"']*[“"']|[”"'][^“"']*$/g, '').replace(/\s+/g, ' ').trim().toLowerCase())));
}

function stepsRepresentSameGesture(previous: OperationWorkflowStep, current: OperationWorkflowStep): boolean {
  if (!['click', 'press'].includes(previous.action) || !['click', 'press'].includes(current.action)) return false;
  if (previous.domInteraction?.id && previous.domInteraction.id === current.domInteraction?.id) return true;
  const previousLabels = operationStepSemanticLabels(previous);
  const currentLabels = operationStepSemanticLabels(current);
  const sameMeaning = previousLabels.some((left) => currentLabels.some((right) => left === right || left.includes(right) || right.includes(left)));
  if (!sameMeaning) return false;
  const interaction = current.domInteraction ?? previous.domInteraction;
  const delegatedFeedback = interaction?.eventTypes.some((type) => ['submit', 'navigate'].includes(type))
    || interaction?.feedbackTypes?.some((type) => ['submit', 'navigate'].includes(type));
  const genericTarget = [previous.locator, current.locator].some((locator) => ['div', 'span', 'form'].includes(`${locator?.tag ?? locator?.role ?? ''}`.toLowerCase()));
  return Boolean(delegatedFeedback || genericTarget);
}

function isNativeActionTarget(locator: OperationStepLocator | undefined): boolean {
  if (!locator) return false;
  const tag = `${locator.tag ?? ''}`.toLowerCase();
  const role = `${locator.role ?? ''}`.toLowerCase();
  return /^(button|a|input|select|textarea|option|summary)$/.test(tag)
    || /^(button|link|textbox|combobox|menuitem|option)$/.test(role);
}

function interactionActionTarget(step: OperationWorkflowStep): OperationStepLocator | undefined {
  const interaction = step.domInteraction;
  const candidates = [interaction?.effective, interaction?.source, ...(interaction?.propagated ?? []), step.locator].filter((item): item is OperationStepLocator => !!item);
  return candidates
    .filter(isNativeActionTarget)
    .sort((left, right) => interactionTargetScore(right) - interactionTargetScore(left))[0]
    ?? candidates[0];
}

function promoteInteractionTarget(step: OperationWorkflowStep): OperationWorkflowStep {
  if (step.action !== 'click' || !step.domInteraction) return step;
  const target = interactionActionTarget(step);
  if (!target || target === step.locator) return step;
  return {
    ...step,
    locator: target,
    selectorCandidates: Array.from(new Set([
      ...selectorCandidatesForLocator(target),
      ...step.selectorCandidates ?? [],
    ])).slice(0, 10),
  };
}

function mergeRuntimeGesture(previous: OperationWorkflowStep, current: OperationWorkflowStep): OperationWorkflowStep {
  const previousInteractionWeight = (previous.domInteraction?.eventTypes.length ?? 0) + (previous.domInteraction?.feedbackTypes?.length ?? 0);
  const currentInteractionWeight = (current.domInteraction?.eventTypes.length ?? 0) + (current.domInteraction?.feedbackTypes?.length ?? 0);
  const preferred = currentInteractionWeight >= previousInteractionWeight ? current : previous;
  const fallback = preferred === current ? previous : current;
  const merged: OperationWorkflowStep = {
    ...fallback,
    ...preferred,
    selectorCandidates: Array.from(new Set([
      ...selectorCandidatesForLocator(preferred.domInteraction?.effective),
      ...selectorCandidatesForLocator(preferred.domInteraction?.source),
      ...(preferred.selectorCandidates ?? []),
      ...(fallback.selectorCandidates ?? []),
    ])).slice(0, 10),
    ...(preferred.domInteraction ?? fallback.domInteraction ? { domInteraction: preferred.domInteraction ?? fallback.domInteraction } : {}),
    recordedStepIndexes: Array.from(new Set([
      ...representedStepNumbers(previous),
      ...representedStepNumbers(current),
    ])).sort((left, right) => left - right),
  };
  return promoteInteractionTarget(merged);
}

function collapseBusinessNodeRuntimeSteps(steps: OperationWorkflowStep[]): OperationWorkflowStep[] {
  const result: OperationWorkflowStep[] = [];
  for (const step of steps) {
    const previous = result.at(-1);
    if (previous && stepsRepresentSameGesture(previous, step)) result[result.length - 1] = mergeRuntimeGesture(previous, step);
    else result.push(step);
  }
  return result;
}

/**
 * Compile the executable sequence from business nodes. `workflow.steps` is a
 * DOM action library captured during recording; it is never an unconditional
 * macro once a business plan exists.
 */
export function buildBusinessExecutionWorkflow(
  workflow: OperationWorkflow,
  requestedBusinessStepIds?: unknown,
  requestedDomStepIndexes?: unknown,
  instruction = '',
): OperationWorkflow {
  const businessSteps = workflow.plan?.businessSteps ?? [];
  if (businessSteps.length === 0 || workflow.executionMode === 'legacy-dom') {
    return selectWorkflowSteps(workflow, requestedDomStepIndexes, instruction);
  }

  const validIds = new Set(businessSteps.map((item) => item.id).filter((id): id is string => Boolean(id)));
  const requestedIds = Array.isArray(requestedBusinessStepIds)
    ? requestedBusinessStepIds.filter((id): id is string => typeof id === 'string' && validIds.has(id))
    : [];
  const requestedIndexes = Array.isArray(requestedDomStepIndexes)
    ? new Set(requestedDomStepIndexes.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))
    : new Set<number>();
  const hasExplicitSelection = requestedIds.length > 0 || requestedIndexes.size > 0;

  // Branching retrieval skills must never fall back to replaying the entire
  // recording when the planner omitted businessStepIds.  The recording often
  // contains an example-row click and a detail page; replaying that path for a
  // list/count question both selects the wrong row and may fail because no
  // dynamic target was supplied.  Use the collection branch as a safe
  // preflight instead. The result loop can then select a detail branch with a
  // real target after it has inspected the current list.
  const collectionBranch = !hasExplicitSelection && !isAuthenticationWorkflow(workflow) && operationInstructionNeedsResult(instruction)
    ? workflow.plan?.branches?.find((branch) => branch.id === 'collection-result')
      ?? workflow.plan?.branches?.find((branch) => !branch.targetStepIndex && /列表|集合|清单|collection|list/i.test(`${branch.when ?? ''} ${branch.purpose ?? ''}`))
    : undefined;
  const branchStepIndexes = new Set((collectionBranch?.stepIndexes ?? [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0));

  const includeAll = isAuthenticationWorkflow(workflow)
    || (!collectionBranch && !hasExplicitSelection);
  const includedIds = new Set<string>();
  if (includeAll) {
    validIds.forEach((id) => includedIds.add(id));
  } else if (requestedIds.length > 0) {
    requestedIds.forEach((id) => includedIds.add(id));
  } else if (collectionBranch && branchStepIndexes.size > 0) {
    // First collect nodes represented entirely by the selected branch. A
    // terminal cleanup node such as "返回首页" is intentionally excluded when
    // its dependency belongs to the detail branch.
    const branchCandidates = businessSteps.filter((node) => {
      if (!node.id) return false;
      const indexes = node.domStepIndexes ?? [];
      if (indexes.length === 0) return node.kind === 'collection' || node.kind === 'result';
      return indexes.every((index) => branchStepIndexes.has(index));
    });
    const candidateIds = new Set(branchCandidates.map((node) => node.id).filter((id): id is string => Boolean(id)));
    for (const node of branchCandidates) {
      if (node.id && (node.dependsOn ?? []).every((dependency) => candidateIds.has(dependency))) includedIds.add(node.id);
    }
  } else {
    for (const node of businessSteps) {
      if ((node.domStepIndexes ?? []).some((index) => requestedIndexes.has(index)) && node.id) includedIds.add(node.id);
    }
  }

  // A selected business node brings only its explicit business dependencies,
  // never the nearest raw DOM/navigation event by position.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of businessSteps) {
      if (!node.id || !includedIds.has(node.id)) continue;
      for (const dependency of node.dependsOn ?? []) {
        if (validIds.has(dependency) && !includedIds.has(dependency)) {
          includedIds.add(dependency);
          changed = true;
        }
      }
    }
  }

  const selectedBusinessSteps = businessSteps.filter((node) => node.id && includedIds.has(node.id));
  const selectedSteps: OperationWorkflowStep[] = [];
  const usedDomIndexes = new Set<number>();
  for (const node of selectedBusinessSteps) {
    const nodeId = node.id!;
    const domIndexes = node.domStepIndexes ?? [];
    if (domIndexes.length === 0) {
      selectedSteps.push({
        id: `business-state:${safeSegment(nodeId)}`,
        title: node.title || '确认页面状态',
        ...(node.purpose ? { purpose: node.purpose } : {}),
        ...(node.when ? { when: node.when } : {}),
        ...((node.completionCriteria ?? []).length ? { expected: node.completionCriteria!.join('；') } : {}),
        action: 'wait',
        timeoutMs: 0,
        businessStepId: nodeId,
        stateOnly: true,
      });
      continue;
    }
    const nodeSteps = domIndexes.flatMap((domIndex) => {
      if (usedDomIndexes.has(domIndex)) return [];
      const recorded = workflow.steps[domIndex - 1];
      if (!recorded) return [];
      usedDomIndexes.add(domIndex);
      return [{ ...promoteInteractionTarget(recorded), businessStepId: nodeId }];
    });
    for (const executable of collapseBusinessNodeRuntimeSteps(nodeSteps)) {
      selectedSteps.push(executable);
    }
  }

  // A number of learned plans attach the first recorded navigation to a
  // cleanup/return-home node. When the collection preflight includes that
  // navigation evidence, retain it as a prerequisite without pulling the
  // cleanup node (and its detail dependencies) into the execution.
  if (collectionBranch && branchStepIndexes.has(1)) {
    const first = workflow.steps[0];
    if (first?.action === 'navigate' && !selectedSteps.some((step) => representedStepNumbers(step).includes(1))) {
      selectedSteps.unshift({ ...first });
    }
  }

  return {
    ...workflow,
    executionMode: 'business-driven',
    steps: selectedSteps,
    plan: { ...workflow.plan, businessSteps: selectedBusinessSteps },
  };
}
const redactUrl = (value: string): string => {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|password|passwd|pwd|key|auth|session|code/i.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    url.hash = '';
    return url.toString();
  } catch { return value; }
};

const substituteInputs = (value: string | undefined, input: Record<string, unknown>): string | undefined => value?.replace(/\{\{input\.([a-zA-Z0-9_-]+)\}\}/g, (_match, key: string) => {
  const replacement = input[key];
  if (replacement === undefined || replacement === null) throw new Error(`缺少技能输入：${key}`);
  return String(replacement);
});

function mergeWorkflowDefaults(workflow: OperationWorkflow | null | undefined, parameters: Record<string, unknown> | undefined): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(parameters ?? {}) };
  const inferred = workflow ? extractFixedInputValues(
    workflow.description,
    Object.entries(workflow.inputSchema.properties).map(([key, property]) => ({ key, label: property.description, sensitive: property.sensitive === true })),
  ) : {};
  for (const [key, property] of Object.entries(workflow?.inputSchema.properties ?? {})) {
    const defaultValue = property.defaultValue ?? inferred[key];
    const fixedBySkill = property.source === 'skill-description' || inferred[key] !== undefined;
    if (defaultValue !== undefined && (fixedBySkill || merged[key] === undefined || merged[key] === null || String(merged[key]).trim() === '')) {
      merged[key] = defaultValue;
    }
  }
  return merged;
}

function workflowHasDefault(workflow: OperationWorkflow | null | undefined, key: string, property: OperationInputProperty): boolean {
  if (property.defaultValue !== undefined) return true;
  if (!workflow) return false;
  const inferred = extractFixedInputValues(workflow.description, [{ key, label: property.description, sensitive: property.sensitive === true }]);
  return inferred[key] !== undefined;
}

function redactWorkflowForDisplay(workflow: OperationWorkflow | null): OperationWorkflow | null {
  if (!workflow) return null;
  const properties = Object.fromEntries(Object.entries(workflow.inputSchema.properties).map(([key, property]) => {
    const { defaultValue: _defaultValue, ...safeProperty } = property;
    return [key, safeProperty];
  }));
  const plan = workflow.plan
    ? { ...workflow.plan, ...(workflow.plan.fixedFacts ? { fixedFacts: Object.fromEntries(Object.keys(workflow.plan.fixedFacts).map((key) => [key, '[已保存]'])) } : {}) }
    : undefined;
  return { ...workflow, inputSchema: { ...workflow.inputSchema, properties }, ...(plan ? { plan } : {}) };
}

function questionCoveredByDefaults(question: string, fields: OperationInputField[], defaults: Record<string, string>): boolean {
  const normalized = question.toLowerCase();
  return fields.some((field) => Boolean(defaults[field.key]) && fieldAliases(field).some((alias) => normalized.includes(alias.toLowerCase())));
}

type WorkflowStage = NonNullable<OperationWorkflowPlan['stages']>[number];

function stepCompletionCriterion(step: OperationWorkflowStep): string {
  if (step.expected?.trim()) return step.expected.trim();
  const target = step.locator?.accessibleName || step.locator?.text || step.locator?.title || step.locator?.name || step.title;
  switch (step.action) {
    case 'navigate': return `页面已进入${step.url ? `目标地址 ${step.url}` : '目标页面'}`;
    case 'fill': return `字段“${target}”已经填写`;
    case 'select': return `已在“${target}”中选择目标选项`;
    case 'scroll': return '目标内容区域已经进入可视范围';
    case 'press': return `已完成“${target}”对应的键盘操作`;
    case 'wait': return '页面已经达到等待条件';
    case 'extract': return '已经读取目标结果';
    default: return `页面已经完成“${target}”对应的操作响应`;
  }
}

/** Keep one user gesture separate from the delegated DOM events it produced. */
function domInteractionSummary(interaction: OperationDomInteraction | undefined): string {
  if (!interaction) return '';
  const label = (locator?: OperationStepLocator): string => locator?.accessibleName || locator?.text || locator?.id || locator?.name || locator?.tag || '';
  const source = label(interaction.source) || '原始 DOM 目标';
  const effective = label(interaction.effective) || '可执行控件';
  const propagated = interaction.propagated?.map(label).filter(Boolean) ?? [];
  const feedback = interaction.feedbackTypes?.filter(Boolean) ?? [];
  const feedbackUrls = interaction.feedbackUrls?.filter(Boolean) ?? [];
  const details = [`用户行为：${source}`, `执行控件：${effective}`];
  if (propagated.length > 0) details.push(`穿透链：${propagated.join(' -> ')}`);
  if (feedback.length > 0) details.push(`页面反馈：${feedback.join('、')}`);
  if (feedbackUrls.length > 0) details.push(`反馈页面：${feedbackUrls.join(' -> ')}`);
  return details.join('；');
}

function stageTitleForKind(kind: WorkflowStage['kind']): string {
  const titles: Record<string, string> = {
    navigation: '进入目标页面',
    input: '准备查询条件',
    collection: '定位集合结果',
    detail: '查看目标条目',
    result: '读取并整理结果',
    other: '完成页面操作',
  };
  return titles[kind ?? 'other'] ?? '完成页面操作';
}

function stageKindForSteps(steps: OperationWorkflowStep[]): WorkflowStage['kind'] {
  const actions = new Set(steps.map((step) => step.action));
  if (actions.has('extract')) return 'result';
  if (actions.has('fill') || actions.has('select')) return 'input';
  if (actions.has('scroll')) return 'collection';
  if (actions.has('navigate')) return 'navigation';
  if (steps.some((step) => /详情|明细|单据|记录/.test(`${step.title} ${step.purpose ?? ''}`))) return 'detail';
  if (actions.has('click') || actions.has('press')) return 'navigation';
  return 'other';
}

/**
 * Build a useful abstract plan for legacy recordings. This is deliberately
 * based on semantic actions and page transitions rather than on a fixed
 * business chain; a model-provided plan always takes precedence.
 */
function inferWorkflowStages(steps: OperationWorkflowStep[]): NonNullable<OperationWorkflowPlan['stages']> {
  if (steps.length === 0) return [];
  const groups: OperationWorkflowStep[][] = [];
  let current: OperationWorkflowStep[] = [];
  let previousUrl: string | undefined;
  for (const step of steps) {
    const urlChanged = step.action === 'navigate' || (step.url && previousUrl && step.url !== previousUrl);
    if (urlChanged && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(step);
    if (step.url) previousUrl = step.url;
    const feedbackUrl = step.domInteraction?.feedbackUrls?.at(-1);
    if (feedbackUrl) {
      groups.push(current);
      current = [];
      previousUrl = feedbackUrl;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups.map((group, groupIndex) => {
    const kind = stageKindForSteps(group);
    const title = stageTitleForKind(kind);
    return {
      id: `stage-${String(groupIndex + 1).padStart(3, '0')}`,
      title,
      purpose: group.map((step) => step.purpose || step.title).filter(Boolean).join('；') || '完成当前业务阶段',
      stepIndexes: group.map((step) => steps.indexOf(step) + 1),
      ...(kind ? { kind } : {}),
      ...(groupIndex > 0 ? { dependsOn: [`stage-${String(groupIndex).padStart(3, '0')}`] } : {}),
      completionCriteria: group.map(stepCompletionCriterion).filter(Boolean).slice(-3),
    };
  });
}

function normalizeStageCompletionCriteria(stage: WorkflowStage, steps: OperationWorkflowStep[]): WorkflowStage {
  const indexes = stage.stepIndexes ?? [];
  const supplied = (stage.completionCriteria ?? []).filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  const derived = indexes.map((index) => steps[index - 1]).filter((step): step is OperationWorkflowStep => !!step).map(stepCompletionCriterion);
  return {
    ...stage,
    completionCriteria: Array.from(new Set([...supplied, ...derived])).slice(-3),
  };
}

/**
 * Models occasionally describe the first part of a trace but omit trailing
 * actions from `stages`. Those actions are still real evidence and must stay
 * executable, so append small inferred stages instead of rejecting the skill.
 */
function completeWorkflowStageCoverage(stages: NonNullable<OperationWorkflowPlan['stages']>, steps: OperationWorkflowStep[]): NonNullable<OperationWorkflowPlan['stages']> {
  const usableStages = stages.filter((stage) => (stage.stepIndexes?.length ?? 0) > 0);
  const covered = new Set(usableStages.flatMap((stage) => stage.stepIndexes ?? []));
  const missing = steps.map((_step, index) => index + 1).filter((index) => !covered.has(index));
  if (missing.length === 0) return usableStages.map((stage) => normalizeStageCompletionCriteria(stage, steps));

  const additions: NonNullable<OperationWorkflowPlan['stages']> = [];
  let run: number[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const runSteps = run.map((index) => steps[index - 1]).filter((step): step is OperationWorkflowStep => !!step);
    const kind = stageKindForSteps(runSteps);
    const id = `stage-auto-${String(run[0]).padStart(3, '0')}`;
    const predecessorId = additions.at(-1)?.id || usableStages.at(-1)?.id;
    additions.push({
      id,
      title: stageTitleForKind(kind),
      purpose: runSteps.map((step) => step.purpose || step.title).filter(Boolean).join('；') || '补齐录制轨迹中的连续操作',
      stepIndexes: [...run],
      ...(predecessorId ? { dependsOn: [predecessorId] } : {}),
      completionCriteria: runSteps.map(stepCompletionCriterion).slice(-3),
      ...(kind ? { kind } : {}),
    });
    run = [];
  };
  for (const index of missing) {
    if (run.length > 0 && index !== run.at(-1)! + 1) flush();
    run.push(index);
  }
  flush();
  return [...usableStages.map((stage) => normalizeStageCompletionCriteria(stage, steps)), ...additions];
}

function normalizePlanIndexes(indexes: unknown, stepCount: number): number[] | undefined {
  if (!Array.isArray(indexes)) return undefined;
  const result = Array.from(new Set(indexes.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 1 && value <= stepCount))).sort((a, b) => a - b);
  return result.length > 0 ? result : undefined;
}

function normalizeBusinessSteps(
  supplied: OperationBusinessStep[] | undefined,
  executionStages: NonNullable<OperationWorkflowPlan['stages']>,
  steps: OperationWorkflowStep[],
): OperationBusinessStep[] {
  const normalize = (item: OperationBusinessStep, index: number): OperationBusinessStep => {
    const domStepIndexes = normalizePlanIndexes(item.domStepIndexes, steps.length);
    const completionCriteria = Array.isArray(item.completionCriteria)
      ? item.completionCriteria.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()).slice(0, 6)
      : [];
    const derived = (domStepIndexes ?? []).map((stepIndex) => steps[stepIndex - 1]).filter((step): step is OperationWorkflowStep => !!step).map(stepCompletionCriterion);
    const requestedVerification = item.verification;
    const verification: NonNullable<OperationBusinessStep['verification']> = requestedVerification && ['dom', 'vision', 'dom-and-vision', 'page-state', 'none'].includes(requestedVerification)
      ? requestedVerification
      : domStepIndexes?.length
        ? 'dom'
        : 'page-state';
    const title = item.title?.trim() || `业务节点 ${index + 1}`;
    const dependsOn = Array.isArray(item.dependsOn)
      ? item.dependsOn.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim())
      : undefined;
    return {
      id: item.id?.trim() || `business-step-${String(index + 1).padStart(3, '0')}`,
      title,
      purpose: item.purpose?.trim() || '确认当前业务节点已经完成',
      ...(domStepIndexes ? { domStepIndexes } : {}),
      ...(dependsOn?.length ? { dependsOn } : {}),
      ...(item.when?.trim() ? { when: item.when.trim() } : {}),
      ...(item.kind ? { kind: item.kind } : {}),
      verification,
      completionCriteria: Array.from(new Set([...completionCriteria, ...derived])).slice(-6).length > 0
        ? Array.from(new Set([...completionCriteria, ...derived])).slice(-6)
        : [`页面状态能够证明“${title}”已经完成`],
    };
  };

  const source = Array.isArray(supplied) && supplied.length > 0
    ? supplied
    : executionStages.map((stage) => ({
      ...(stage.id ? { id: stage.id } : {}),
      ...(stage.title ? { title: stage.title } : {}),
      ...(stage.purpose ? { purpose: stage.purpose } : {}),
      ...(stage.stepIndexes?.length ? { domStepIndexes: stage.stepIndexes } : {}),
      ...(stage.dependsOn?.length ? { dependsOn: stage.dependsOn } : {}),
      ...(stage.kind ? { kind: stage.kind } : {}),
      verification: 'dom' as const,
      ...(stage.completionCriteria?.length ? { completionCriteria: stage.completionCriteria } : {}),
    }));
  // A model-supplied business plan is authoritative. Recording events that
  // are not referenced by it remain evidence; they are not silently appended
  // back into the executable workflow just to obtain full DOM coverage.
  return source.map(normalize);
}

function dynamicTargetBusinessStepScore(
  businessStep: OperationBusinessStep,
  targetStep: OperationWorkflowStep,
  allBusinessSteps: OperationBusinessStep[],
  targetStepIndex: number,
): number {
  const text = `${businessStep.id ?? ''} ${businessStep.title ?? ''} ${businessStep.purpose ?? ''} ${businessStep.when ?? ''}`.toLowerCase();
  const action = targetStep.action;
  let score = 0;
  if (businessStep.domStepIndexes?.includes(targetStepIndex)) score += 3;
  if (action === 'click' || action === 'press') {
    if (businessStep.kind === 'navigation') score += 10;
    // A branch target is normally represented by a dedicated detail/target
    // node. Prefer that semantic node over an earlier navigation node that
    // happens to contain the same recorded DOM index (a common artefact of
    // older learned workflows).
    if (businessStep.kind === 'detail') score += 14;
    if (businessStep.kind === 'collection') score -= 6;
    if (/点击|选择|打开|进入|定位|匹配|目标|条目|记录|详情|click|select|open|target|item|row|record|detail/.test(text)) score += 8;
  } else if (action === 'fill' || action === 'select') {
    if (businessStep.kind === 'input') score += 10;
    if (/填写|输入|选择|条件|筛选|fill|input|select|filter/.test(text)) score += 8;
  }
  if (businessStep.kind === 'state-check') score -= 8;
  if (/确认|判断|读取|获取|汇总|统计|校验|verify|check|read|collect|summary/.test(text)
    && !/点击|选择|打开|进入|定位|匹配|target|click|select|open/.test(text)) score -= 4;
  const feedsLaterAction = allBusinessSteps.some((candidate) => (
    candidate.dependsOn?.includes(businessStep.id ?? '')
    && (candidate.domStepIndexes ?? []).some((index) => index > targetStepIndex)
  ));
  if (feedsLaterAction) score += 6;
  return score;
}

/**
 * A recorded row click is an action template, not a fixed business record.
 * Models sometimes create the correct dynamic business node and branch target,
 * but forget to connect them. Repair that structural omission for both newly
 * learned and already-active skills.
 */
function bindDynamicTargetActions(
  businessSteps: OperationBusinessStep[],
  branches: NonNullable<OperationWorkflowPlan['branches']>,
  steps: OperationWorkflowStep[],
): OperationBusinessStep[] {
  const result = businessSteps.map((step) => ({ ...step, ...(step.domStepIndexes ? { domStepIndexes: [...step.domStepIndexes] } : {}) }));
  const targets = Array.from(new Set(branches
    .map((branch) => branch.targetStepIndex)
    .filter((index): index is number => Number.isInteger(index) && Number(index) >= 1 && Number(index) <= steps.length)));
  for (const targetStepIndex of targets) {
    const targetStep = steps[targetStepIndex - 1];
    if (!targetStep || !['click', 'press', 'fill', 'select'].includes(targetStep.action)) continue;
    const candidates = result
      .map((businessStep, index) => ({ index, score: dynamicTargetBusinessStepScore(businessStep, targetStep, result, targetStepIndex) }))
      .filter((candidate) => Number.isFinite(candidate.score))
      .sort((left, right) => right.score - left.score);
    const selected = candidates[0];
    if (!selected || selected.score < 6) continue;
    for (const [index, candidate] of result.entries()) {
      if (index === selected.index || !candidate.domStepIndexes?.includes(targetStepIndex)) continue;
      const remaining = candidate.domStepIndexes.filter((stepIndex) => stepIndex !== targetStepIndex);
      if (remaining.length > 0) candidate.domStepIndexes = remaining;
      else delete candidate.domStepIndexes;
    }
    const businessStep = result[selected.index]!;
    businessStep.domStepIndexes = Array.from(new Set([...(businessStep.domStepIndexes ?? []), targetStepIndex])).sort((left, right) => left - right);
    businessStep.verification = targetStep.action === 'click' || targetStep.action === 'press' ? 'dom-and-vision' : 'dom';
    businessStep.completionCriteria = Array.from(new Set([
      ...(businessStep.completionCriteria ?? []),
      stepCompletionCriterion(targetStep),
    ])).slice(-6);
  }
  return result;
}

function ensureAuthenticationBusinessChecks(
  businessSteps: OperationBusinessStep[],
  plan: OperationWorkflowPlan | undefined,
  steps: OperationWorkflowStep[],
  description: string,
): OperationBusinessStep[] {
  const text = [description, plan?.goal, ...(plan?.triggers ?? []), ...steps.flatMap((step) => [step.title, step.purpose])].filter(Boolean).join(' ').toLowerCase();
  const authentication = /登录|登陆|认证|sign\s*in|log\s*in|sso/.test(text)
    && steps.some((step) => (
      step.action === 'fill'
        && /用户名|账号|工号|密码|口令|username|password|passwd|pwd/.test(`${step.title} ${step.locator?.text ?? ''} ${step.locator?.accessibleName ?? ''}`.toLowerCase())
    ) || (
      ['click', 'press', 'navigate'].includes(step.action)
        && /登录|登陆|认证|sign\s*in|log\s*in|submit/.test(`${step.title} ${step.locator?.text ?? ''} ${step.locator?.accessibleName ?? ''}`.toLowerCase())
    ));
  if (!authentication) return businessSteps;

  const result = [...businessSteps];
  const hasInitialStateCheck = result.some((item) => !(item.domStepIndexes?.length) && /登录状态|会话状态|是否.*登录|已经登录|已登录/.test(`${item.title ?? ''} ${item.purpose ?? ''}`));
  if (!hasInitialStateCheck) {
    result.unshift({
      id: 'auth-state-check',
      title: '确认当前登录状态',
      purpose: '已登录时直接结束认证流程；未登录或无法确认时进入登录页',
      kind: 'state-check',
      verification: 'page-state',
      completionCriteria: ['当前页面能够确认已进入平台，或能够确认需要登录'],
    });
  }
  const hasFinalVerification = result.some((item) => /登录成功|认证成功|进入.*首页|平台首页/.test(`${item.title ?? ''} ${item.purpose ?? ''} ${(item.completionCriteria ?? []).join(' ')}`));
  if (!hasFinalVerification) {
    const predecessor = result.at(-1)?.id;
    result.push({
      id: 'auth-result-check',
      title: '确认登录成功',
      purpose: '确认页面已经离开登录入口并进入登录后的平台页面',
      ...(predecessor ? { dependsOn: [predecessor] } : {}),
      kind: 'state-check',
      verification: 'dom-and-vision',
      completionCriteria: ['当前 URL 和页面内容均能够证明已进入登录后的平台页面'],
    });
  }
  return result;
}

function inferWorkflowBranches(description: string, steps: OperationWorkflowStep[]): NonNullable<OperationWorkflowPlan['branches']> {
  const text = description.toLowerCase();
  const hasCollectionSemantics = /列表|清单|表单|汇总|统计|数量|最近|查询|检索|记录|list|table|form|search|count/.test(text);
  const hasDetailSemantics = /详情|明细|具体|某条|单条|展开|detail|item/.test(text);
  if (!hasCollectionSemantics && !hasDetailSemantics) return [];
  const semanticDetailIndex = steps.findIndex((step) => /详情|明细|具体|进入.*记录|查看.*记录|detail/.test(`${step.title} ${step.purpose ?? ''} ${step.expected ?? ''}`.toLowerCase()));
  const navigationDetailIndex = steps.findIndex((step, index) => step.action === 'click'
    && (steps[index + 1]?.action === 'navigate' || (step.domInteraction?.feedbackUrls?.length ?? 0) > 0)
    && index > 1);
  const detailIndex = semanticDetailIndex >= 0 ? semanticDetailIndex : navigationDetailIndex;
  const targetStepIndex = detailIndex >= 0 ? detailIndex + 1 : undefined;
  return [
    {
      id: 'collection-result',
      when: '用户要列表、表单、数量、统计或汇总时，只执行能够得到集合结果的最小路径。',
      purpose: '停留在集合结果页面读取和整理内容，不因录制时的示例点击进入详情。',
      ...(targetStepIndex ? { stepIndexes: steps.slice(0, targetStepIndex - 1).map((_step, index) => index + 1) } : {}),
    },
    {
      id: 'item-detail',
      when: '用户明确指定某条记录或要求详情时，先在当前集合中动态匹配目标，再进入并确认详情页面。',
      purpose: '仅在目标条目和详情页面都得到证据后读取详情。',
      ...(targetStepIndex ? { targetStepIndex } : {}),
      ...(targetStepIndex ? { stepIndexes: steps.slice(0, targetStepIndex).map((_step, index) => index + 1) } : {}),
    },
  ];
}

function normalizeWorkflowPlan(
  plan: OperationWorkflowPlan | undefined,
  steps: OperationWorkflowStep[],
  description: string,
  finalUrl?: string,
): OperationWorkflowPlan {
  const fallbackStages = inferWorkflowStages(steps);
  const stagesFromBusinessSteps = Array.isArray(plan?.businessSteps)
    ? plan.businessSteps.filter((item) => Array.isArray(item.domStepIndexes) && item.domStepIndexes.length > 0).map((item) => ({
      ...(item.id ? { id: item.id } : {}),
      ...(item.title ? { title: item.title } : {}),
      ...(item.purpose ? { purpose: item.purpose } : {}),
      ...(item.domStepIndexes?.length ? { stepIndexes: item.domStepIndexes } : {}),
      ...(item.dependsOn?.length ? { dependsOn: item.dependsOn } : {}),
      ...(item.kind ? { kind: item.kind } : {}),
      ...(item.completionCriteria?.length ? { completionCriteria: item.completionCriteria } : {}),
    }))
    : [];
  const rawStages = Array.isArray(plan?.stages) && plan.stages.length > 0
    ? plan.stages
    : stagesFromBusinessSteps;
  const suppliedStages = rawStages.length > 0
    ? rawStages.map((stage, index) => {
      const stepIndexes = normalizePlanIndexes(stage.stepIndexes, steps.length) ?? fallbackStages[index]?.stepIndexes;
      const dependsOn = Array.isArray(stage.dependsOn) ? stage.dependsOn.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : undefined;
      const completionCriteria = Array.isArray(stage.completionCriteria) ? stage.completionCriteria.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 6) : undefined;
      return {
        ...stage,
        id: stage.id?.trim() || `stage-${String(index + 1).padStart(3, '0')}`,
        title: stage.title?.trim() || `业务阶段 ${index + 1}`,
        purpose: stage.purpose?.trim() || '完成当前业务阶段',
        ...(stepIndexes ? { stepIndexes } : {}),
        ...(dependsOn ? { dependsOn } : {}),
        ...(completionCriteria ? { completionCriteria } : {}),
      };
    })
    : fallbackStages;
  const completedStages = completeWorkflowStageCoverage(suppliedStages, steps);
  const normalizedBusinessSteps = ensureAuthenticationBusinessChecks(
    normalizeBusinessSteps(plan?.businessSteps, completedStages, steps),
    plan,
    steps,
    description,
  );
  const stageIds = new Set(completedStages.map((stage) => stage.id));
  const inferredBranches = inferWorkflowBranches(description, steps);
  const normalizedSuppliedBranches = Array.isArray(plan?.branches) && plan!.branches!.length > 0
    ? plan!.branches!.map((branch, index) => ({
      ...branch,
      id: branch.id?.trim() || `branch-${String(index + 1).padStart(3, '0')}`,
      when: branch.when?.trim() || '根据用户目标和当前页面证据选择',
      purpose: branch.purpose?.trim() || '选择满足当前目标的最小执行路径',
      ...(normalizePlanIndexes(branch.stepIndexes, steps.length) ? { stepIndexes: normalizePlanIndexes(branch.stepIndexes, steps.length)! } : {}),
      ...(Number.isInteger(branch.targetStepIndex) && Number(branch.targetStepIndex) >= 1 && Number(branch.targetStepIndex) <= steps.length ? { targetStepIndex: Number(branch.targetStepIndex) } : {}),
      ...(branch.nextStageId && stageIds.has(branch.nextStageId) ? { nextStageId: branch.nextStageId } : {}),
    }))
    : [];
  const suppliedBranches = normalizedSuppliedBranches.length === 0
    ? inferredBranches
    : normalizedSuppliedBranches.length === 1
      && !normalizedSuppliedBranches.some((branch) => branch.targetStepIndex || branch.stepIndexes?.length)
      && inferredBranches.length > 0
      ? [...normalizedSuppliedBranches, ...inferredBranches]
      : normalizedSuppliedBranches;
  const businessSteps = bindDynamicTargetActions(normalizedBusinessSteps, suppliedBranches, steps);
  const suppliedCompletionCriteria = plan?.completionCriteria
    ?.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .slice(0, 12) ?? [];
  const hasResultBearingNode = businessSteps.some((item) => ['collection', 'detail', 'result'].includes(item.kind ?? ''));
  const cleanupOnlyCompletion = suppliedCompletionCriteria.length > 0 && suppliedCompletionCriteria.every((criterion) => (
    /(?:页面)?达到结果位置\s*[:：]|返回(?:到)?(?:门户)?首页|回到(?:门户)?首页|恢复(?:到)?初始页面/.test(criterion)
  ));
  const completionCriteria = hasResultBearingNode && cleanupOnlyCompletion
    ? ['已取得足以回答当前用户需求的列表、统计或详情证据']
    : suppliedCompletionCriteria.length > 0
      ? suppliedCompletionCriteria
      : finalUrl
        ? [`页面达到结果位置：${finalUrl}`]
        : ['页面出现能够回答用户请求的结果'];
  const fixedFacts = plan?.fixedFacts && typeof plan.fixedFacts === 'object'
    ? Object.fromEntries(Object.entries(plan.fixedFacts).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0).map(([key, value]) => [key, value.trim()]))
    : undefined;
  return {
    goal: plan?.goal?.trim() || description || '按用户目标完成网页操作',
    triggers: plan?.triggers?.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 12) || [`用户提出与技能“${description || '当前技能'}”相关的请求`],
    preconditions: plan?.preconditions?.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 12) || ['平台页面可访问，且当前会话具备必要权限'],
    completionCriteria,
    decisionRules: plan?.decisionRules?.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 16) || ['每个节点执行前后都结合当前页面证据确认；只走满足用户目标的最小路径。'],
    ...(fixedFacts && Object.keys(fixedFacts).length > 0 ? { fixedFacts } : {}),
    businessSteps,
    stages: completedStages,
    branches: suppliedBranches,
  };
}

function hydrateWorkflowPlan(workflow: OperationWorkflow | null | undefined): OperationWorkflow | null {
  if (!workflow) return null;
  return {
    ...workflow,
    executionMode: workflow.executionMode ?? 'business-driven',
    plan: normalizeWorkflowPlan(workflow.plan, workflow.steps, workflow.description, workflow.success.finalUrl),
  };
}

function isLegacyRecordingFallback(workflow: OperationWorkflow | null | undefined): boolean {
  if (!workflow?.validation) return false;
  const text = [workflow.validation.summary, ...workflow.validation.evidence].join(' ');
  return /语义复核未能取得一致|按真实录制动作生成基础工作流|保留录制工作流/.test(text);
}

function inferDynamicTargetStepIndex(workflow: OperationWorkflow | null | undefined, instruction: string): number | undefined {
  if (!workflow || !instruction.trim()) return undefined;
  const branchTarget = workflow.plan?.branches?.find((branch) => Number.isInteger(branch.targetStepIndex) && Number(branch.targetStepIndex) > 0)?.targetStepIndex;
  if (branchTarget) return branchTarget;
  const requestedDetail = /详情|明细|具体|某条|单条|展开|字段|内容|主体|印章|金额|detail|item|field|content/i.test(instruction);
  if (!requestedDetail) return undefined;
  const index = workflow.steps.findIndex((step) => step.action === 'click' && /记录|条目|流程|详情|明细|查看|打开|row|item|detail/i.test(`${step.title} ${step.purpose ?? ''} ${step.locator?.text ?? ''}`));
  return index >= 0 ? index + 1 : undefined;
}

const stepTitle = (event: OperationTraceEvent, index: number): string => {
  const target = event.accessibleName || event.text || event.locator?.text || event.fieldKey || '';
  if (event.type === 'navigate') return `打开 ${new URL(event.url).hostname}`;
  if (event.type === 'click') return target ? `点击“${target.slice(0, 40)}”` : `执行第 ${index + 1} 次点击`;
  if (event.type === 'input') return target ? `填写“${target.slice(0, 40)}”` : `填写第 ${index + 1} 个字段`;
  if (event.type === 'select') return target ? `选择“${target.slice(0, 40)}”` : `选择第 ${index + 1} 个选项`;
  if (event.type === 'press') return `按下 ${event.key ?? 'Enter'}`;
  if (event.type === 'submit') return '提交当前表单';
  return '调整页面位置';
};

type OperationStepAnnotation = {
  stepIndex: number;
  title?: string;
  purpose?: string;
  when?: string;
  expected?: string;
  locator?: OperationStepLocator | null;
};

function stepTitleMatchesRecordedAction(event: OperationTraceEvent, title: string): boolean {
  const value = title.trim().toLowerCase();
  if (!value) return false;
  const target = traceEventSemantic(event);
  const targetIsUser = /用户名|用户账号|登录账号|账号|工号|username|user name|login name/.test(target);
  const targetIsPassword = /密码|口令|password|passwd|pwd/.test(target);
  const titleIsUser = /用户名|用户账号|登录账号|账号|工号|username|user name|login name/.test(value);
  const titleIsPassword = /密码|口令|password|passwd|pwd/.test(value);
  if ((targetIsUser && titleIsPassword) || (targetIsPassword && titleIsUser)) return false;

  const saysFill = /填写|填入|输入|录入|选择|fill|input|type|select/.test(value);
  const saysClick = /点击|按下|提交|确认|触发|click|press|submit/.test(value);
  const saysNavigate = /打开|进入|跳转|前往|navigate|open|go to/.test(value);
  if (event.type === 'input' || event.type === 'select') return !saysClick || saysFill;
  if (event.type === 'click' || event.type === 'press' || event.type === 'submit') return !saysFill || saysClick;
  if (event.type === 'navigate') return !saysFill && !saysClick || saysNavigate;
  return true;
}

const locatorFromTraceEvent = (event: OperationTraceEvent): OperationStepLocator | undefined => {
  const locator = event.locator ?? {};
  const value = {
    ...(locator.text || event.text ? { text: locator.text || event.text } : {}),
    ...(locator.accessibleName || event.accessibleName ? { accessibleName: locator.accessibleName || event.accessibleName } : {}),
    ...(locator.role || event.role ? { role: locator.role || event.role } : {}),
    ...(locator.tag ? { tag: locator.tag } : {}),
    ...(locator.href ? { href: locator.href } : {}),
    ...(locator.id ? { id: locator.id } : {}),
    ...(locator.name ? { name: locator.name } : {}),
    ...(locator.placeholder ? { placeholder: locator.placeholder } : {}),
    ...(locator.title ? { title: locator.title } : {}),
    ...(locator.testId ? { testId: locator.testId } : {}),
    ...(locator.ancestorText ? { ancestorText: locator.ancestorText } : {}),
  } satisfies OperationStepLocator;
  return Object.keys(value).length > 0 ? value : undefined;
};

function compactTraceEvents(events: OperationTraceEvent[]): OperationTraceEvent[] {
  const actionable = events.filter((event) => event.type !== 'network-response');
  return actionable.filter((event, index, values) => {
    const previous = values[index - 1];
    if (!previous) return true;
    if (event.type === 'submit' && previous.type === 'press' && previous.key === 'Enter') return false;
    const sameTarget = JSON.stringify({
      selectorCandidates: event.selectorCandidates,
      accessibleName: event.accessibleName,
      text: event.text,
      fieldKey: event.fieldKey,
      locator: event.locator,
    }) === JSON.stringify({
      selectorCandidates: previous.selectorCandidates,
      accessibleName: previous.accessibleName,
      text: previous.text,
      fieldKey: previous.fieldKey,
      locator: previous.locator,
    });
    if (event.type === previous.type && event.url === previous.url && sameTarget) {
      return event.type !== 'click' && event.type !== 'submit';
    }
    return true;
  });
}

function traceEventSemanticLabels(event: OperationTraceEvent): string[] {
  return Array.from(new Set([
    event.accessibleName,
    event.text,
    event.locator?.text,
    event.locator?.accessibleName,
    event.locator?.ancestorText,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.replace(/\s+/g, ' ').trim().toLowerCase())));
}

function traceEventSemantic(event: OperationTraceEvent): string {
  return traceEventSemanticLabels(event).join(' ');
}

function traceEventsReferToSameInteraction(previous: OperationTraceEvent, current: OperationTraceEvent): boolean {
  if (previous.url !== current.url) return false;
  const previousSemantics = traceEventSemanticLabels(previous);
  const currentSemantics = traceEventSemanticLabels(current);
  const sameSemantic = previousSemantics.some((left) => currentSemantics.some((right) => (
    left === right || left.includes(right) || right.includes(left)
  )));
  const previousPath = previous.domPath ?? [];
  const currentPath = current.domPath ?? [];
  const pathOverlap = previousPath.some((left) => currentPath.some((right) => {
    const leftText = `${left.text ?? ''} ${left.accessibleName ?? ''}`.trim().toLowerCase();
    const rightText = `${right.text ?? ''} ${right.accessibleName ?? ''}`.trim().toLowerCase();
    return Boolean(leftText && rightText && (leftText === rightText || leftText.includes(rightText) || rightText.includes(leftText)));
  }));
  return sameSemantic || pathOverlap || current.type === 'submit' || previous.type === 'submit';
}

function delegatedDomEvent(previous: OperationTraceEvent, current: OperationTraceEvent): boolean {
  return current.nativeEventTrusted === false
    || previous.nativeEventTrusted === false
    || current.type === 'submit'
    || current.type === 'press';
}

function interactionTargetScore(locator: OperationStepLocator | undefined): number {
  const tag = `${locator?.tag ?? ''}`.toLowerCase();
  const role = `${locator?.role ?? ''}`.toLowerCase();
  const nativeControl = /^(button|a|input|select|textarea|option|summary)$/.test(tag) || /^(button|link|textbox|combobox|menuitem|option)$/.test(role);
  const form = tag === 'form' || role === 'form';
  return (nativeControl ? 40 : form ? 10 : 0)
    + (locator?.id ? 5 : 0)
    + (locator?.name ? 3 : 0)
    + (locator?.testId ? 5 : 0)
    + (locator?.href ? 2 : 0);
}

function selectorCandidatesForLocator(locator: OperationStepLocator | undefined): string[] {
  if (!locator) return [];
  const attribute = (name: string, value: string): string => `[${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
  const tag = locator.tag && /^[a-z][a-z0-9-]*$/i.test(locator.tag) ? locator.tag.toLowerCase() : '';
  return Array.from(new Set([
    locator.testId ? attribute('data-testid', locator.testId) : '',
    locator.id ? attribute('id', locator.id) : '',
    locator.name ? `${tag || ''}${attribute('name', locator.name)}` : '',
    locator.href ? `${tag || 'a'}${attribute('href', locator.href)}` : '',
  ].filter(Boolean)));
}

/**
 * A single user gesture can produce a delegated click, a component click and
 * a submit/route event. Keep one executable action, but retain the full DOM
 * evidence so the model and executor know why those events are equivalent.
 */
function collapseDelegatedDomInteractions(events: OperationTraceEvent[]): OperationTraceEvent[] {
  const result: OperationTraceEvent[] = [];
  let interactionCounter = 0;
  for (const event of events) {
    const previous = result.at(-1);
    if (!previous) {
      result.push(event);
      continue;
    }
    const timeDelta = Math.abs(Date.parse(event.timestamp) - Date.parse(previous.timestamp));
    const navigationFeedback = event.type === 'navigate'
      && ['click', 'press', 'submit'].includes(previous.type)
      && timeDelta <= 10_000;
    if (navigationFeedback) {
      const existing = previous.domInteraction;
      const source = existing?.source || previous.domSource || previous.locator;
      const effective = existing?.effective || previous.locator || source;
      result[result.length - 1] = {
        ...previous,
        domInteraction: {
          id: existing?.id || `interaction-${String(++interactionCounter).padStart(4, '0')}`,
          eventTypes: Array.from(new Set([...(existing?.eventTypes ?? [previous.type]), event.type])),
          ...(source ? { source } : {}),
          ...(effective ? { effective } : {}),
          ...(existing?.propagated?.length ? { propagated: existing.propagated } : {}),
          feedbackTypes: Array.from(new Set([...(existing?.feedbackTypes ?? []), 'navigate'])),
          feedbackUrls: Array.from(new Set([...(existing?.feedbackUrls ?? []), event.url])),
        },
      };
      continue;
    }
    const chainEvent = ['click', 'press', 'submit'].includes(event.type) && ['click', 'press', 'submit'].includes(previous.type);
    const withinWindow = timeDelta <= 1_500;
    const previousTag = `${previous.locator?.tag ?? previous.role ?? ''}`.toLowerCase();
    const currentTag = `${event.locator?.tag ?? event.role ?? ''}`.toLowerCase();
    const likelyDelegated = delegatedDomEvent(previous, event) || (event.type === 'click' && previous.type === 'click' && previousTag !== currentTag);
    if (!chainEvent || !withinWindow || !traceEventsReferToSameInteraction(previous, event) || !likelyDelegated) {
      result.push(event);
      continue;
    }

    const existing = previous.domInteraction;
    const groupId = existing?.id || `interaction-${String(++interactionCounter).padStart(4, '0')}`;
    const grouped = [previous, event];
    const allTargets = grouped.flatMap((candidate) => [candidate.domSource, candidate.locator, ...(candidate.domPath ?? [])].filter((item): item is OperationStepLocator => !!item));
    const uniqueTargets = Array.from(new Map(allTargets.map((target) => [JSON.stringify(target), target])).values());
    const source = existing?.source || previous.domSource || previous.locator;
    const effective = [existing?.effective, ...uniqueTargets]
      .filter((target): target is OperationStepLocator => !!target)
      .sort((left, right) => interactionTargetScore(right) - interactionTargetScore(left))[0] || source;
    const executable = grouped
      .filter((candidate) => candidate.type === 'click' || candidate.type === 'press')
      .sort((left, right) => interactionTargetScore(right.locator) - interactionTargetScore(left.locator))[0] ?? previous;
    const feedbackTypes = Array.from(new Set([
      ...(existing?.feedbackTypes ?? []),
      ...(event.type !== executable.type ? [event.type] : []),
    ]));
    const interaction: OperationDomInteraction = {
      id: groupId,
      eventTypes: Array.from(new Set([...(existing?.eventTypes ?? [previous.type]), event.type])),
      ...(source ? { source } : {}),
      ...(effective ? { effective } : {}),
      ...(uniqueTargets.length > 1 ? { propagated: uniqueTargets } : {}),
      ...(feedbackTypes.length > 0 ? { feedbackTypes } : {}),
      ...(existing?.feedbackUrls?.length ? { feedbackUrls: existing.feedbackUrls } : {}),
    };
    const mergedSelectors = Array.from(new Set([
      ...selectorCandidatesForLocator(effective),
      ...grouped.flatMap((candidate) => candidate.selectorCandidates ?? []),
    ])).slice(0, 8);
    const screenshotRelPath = previous.screenshotRelPath || event.screenshotRelPath;
    const merged: OperationTraceEvent = {
      ...executable,
      ...(effective ? { locator: effective } : {}),
      ...(mergedSelectors.length ? { selectorCandidates: mergedSelectors } : {}),
      ...(screenshotRelPath ? { screenshotRelPath } : {}),
      ...(source && JSON.stringify(source) !== JSON.stringify(effective) ? { domSource: source } : {}),
      ...(uniqueTargets.length > 1 ? { domPath: uniqueTargets } : {}),
      nativeEventTrusted: previous.nativeEventTrusted !== false && event.nativeEventTrusted !== false,
      domInteraction: interaction,
    };
    result[result.length - 1] = merged;
  }
  return result;
}

const authenticationText = (workflow: OperationWorkflow): string => [
  workflow.name,
  workflow.description,
  workflow.plan?.goal,
  ...(workflow.plan?.triggers ?? []),
  ...(workflow.plan?.preconditions ?? []),
  ...(workflow.plan?.completionCriteria ?? []),
  ...(workflow.plan?.decisionRules ?? []),
  ...workflow.steps.flatMap((step) => [step.title, step.purpose, step.when, step.expected, step.locator?.text, step.locator?.accessibleName]),
].filter(Boolean).join(' ').toLowerCase();

/** A login page is valid input context, never a valid final answer. */
function isAuthenticationWorkflow(workflow: OperationWorkflow | null | undefined): boolean {
  if (!workflow) return false;
  const text = authenticationText(workflow);
  if (!/登录|登陆|认证|sign\s*in|log\s*in|sso|扫码/.test(text)) return false;
  const hasCredentialInput = workflow.steps.some((step) => step.action === 'fill' && /用户名|账号|工号|username|login|密码|口令|password|passwd|pwd/.test(`${step.title} ${step.purpose ?? ''} ${step.locator?.text ?? ''} ${step.locator?.accessibleName ?? ''}`.toLowerCase()))
    || Object.entries(workflow.inputSchema.properties).some(([key, property]) => /用户名|账号|工号|username|login|密码|口令|password|passwd|pwd/.test(`${key} ${property.description}`.toLowerCase()));
  const hasAuthenticationAction = workflow.steps.some((step) => /提交|登录|登陆|认证|扫码|sign\s*in|log\s*in|submit/.test(`${step.title} ${step.purpose ?? ''} ${step.locator?.text ?? ''} ${step.locator?.accessibleName ?? ''}`.toLowerCase()) && ['click', 'press', 'navigate', 'wait'].includes(step.action));
  return hasCredentialInput || hasAuthenticationAction;
}

function isAuthenticationPage(snapshot: OperationPageSnapshot): boolean {
  const url = snapshot.url.toLowerCase();
  if (/(^|[/?._-])(login|signin|sign-in|auth|sso|qrcode)([/?._-]|$)/.test(url)) return true;
  const text = `${snapshot.title} ${snapshot.text}`.toLowerCase();
  return /用户名|用户账号|username/.test(text) && /密码|password|口令/.test(text) && /登录|登陆|sign\s*in|log\s*in/.test(text);
}

function operationInstructionNeedsResult(instruction: string): boolean {
  return /查询|查找|获取|读取|检索|统计|数量|多少|列表|清单|表单|记录|详情|明细|内容|最近|查询|search|list|table|record|detail|count/i.test(instruction);
}

function isResultBearingBusinessStep(step: OperationBusinessStep | undefined): boolean {
  return Boolean(step && ['collection', 'detail', 'result'].includes(step.kind ?? ''));
}

/** Select a result-bearing business node for an incomplete retrieval request. */
function nextResultBusinessStepId(
  workflow: OperationWorkflow | null | undefined,
  instruction: string,
  completedIndexes: number[],
): string | undefined {
  if (!workflow?.plan?.businessSteps?.length || !operationInstructionNeedsResult(instruction)) return undefined;
  const completed = new Set(completedIndexes);
  const wantsDetail = /详情|明细|具体|某条|单条|展开|detail|record/i.test(instruction);
  // Detail requests often need a model-selected target row. Let the planner
  // provide that target instead of synthesizing a click without targetText.
  if (wantsDetail) return undefined;
  const candidates = workflow.plan.businessSteps
    .filter((step) => step.id && isResultBearingBusinessStep(step))
    .filter((step) => (step.domStepIndexes ?? []).length === 0 || (step.domStepIndexes ?? []).some((index) => !completed.has(index)))
    .sort((left, right) => {
      const leftDetail = left.kind === 'detail' ? 1 : 0;
      const rightDetail = right.kind === 'detail' ? 1 : 0;
      if (wantsDetail && leftDetail !== rightDetail) return rightDetail - leftDetail;
      if (!wantsDetail && leftDetail !== rightDetail) return leftDetail - rightDetail;
      return (left.domStepIndexes?.[0] ?? Number.MAX_SAFE_INTEGER) - (right.domStepIndexes?.[0] ?? Number.MAX_SAFE_INTEGER);
    });
  return candidates[0]?.id;
}

function snapshotMatchesFeedbackUrl(snapshot: OperationPageSnapshot, expectedUrls: string[]): boolean {
  const actualUrls = [snapshot.url, ...(snapshot.frameUrls ?? [])].filter(Boolean);
  return expectedUrls.some((expectedValue) => {
    try {
      const expected = new URL(expectedValue);
      return actualUrls.some((actualValue) => {
        try {
          const actual = new URL(actualValue);
          return expected.origin === actual.origin && expected.pathname === actual.pathname;
        } catch { return false; }
      });
    } catch {
      return actualUrls.some((actualValue) => actualValue === expectedValue);
    }
  });
}

function authenticationStepIndexes(workflow: OperationWorkflow): number[] {
  // Keep a recorded authentication skill together so a planner cannot stop
  // after only opening the login page.
  return workflow.steps.map(recordedStepNumber).filter((index): index is number => index !== null);
}

function isExplicitAuthenticationRequest(instruction: string): boolean {
  const normalized = instruction.trim().toLowerCase();
  if (/(登录|登陆)\s*(状态|页|页面|方式|流程|按钮|信息|内容)/.test(normalized)) return false;
  if (/(什么是|是什么|如何|怎么|有哪些|能否|可以吗|说明|解释)/.test(normalized)) return false;
  return /登录|登陆|扫码登录|sign\s*in|log\s*in/i.test(normalized)
    && (/请|帮我|让(?:我|他|它)?|我要|需要|执行|进行|完成|直接|现在|自动/.test(normalized)
      || /^(登录|登陆|扫码登录|sign\s*in|log\s*in)(?:一下|下)?(?:系统|平台|账号|账户|网页|网站|[a-z0-9_-]+)?[。.!！]?$/i.test(normalized));
}

function businessStepForRuntimeStep(workflow: OperationWorkflow, step: OperationWorkflowStep): OperationBusinessStep | undefined {
  const represented = representedStepNumbers(step);
  return workflow.plan?.businessSteps?.find((item) => (
    step.businessStepId ? item.id === step.businessStepId : (item.domStepIndexes ?? []).some((index) => represented.includes(index))
  ));
}

export function operationStepConfirmationPolicy(
  workflow: OperationWorkflow,
  step: OperationWorkflowStep,
  index: number,
): { before: boolean; after: boolean; reason: string } {
  const businessStep = businessStepForRuntimeStep(workflow, step);
  const represented = representedStepNumbers(step);
  const branchNode = (workflow.plan?.branches ?? []).some((branch) => (branch.stepIndexes ?? []).some((stepIndex) => represented.includes(stepIndex)));
  const businessText = `${businessStep?.title ?? ''} ${businessStep?.purpose ?? ''} ${(businessStep?.completionCriteria ?? []).join(' ')}`.toLowerCase();
  const stepText = `${step.title} ${step.purpose ?? ''} ${step.expected ?? ''} ${step.locator?.text ?? ''} ${step.locator?.accessibleName ?? ''}`.toLowerCase();
  const interactionTypes = [
    ...(step.domInteraction?.eventTypes ?? []),
    ...(step.domInteraction?.feedbackTypes ?? []),
  ];
  const submitOrNavigationFeedback = interactionTypes.some((type) => ['submit', 'navigate'].includes(type));
  const authentication = isAuthenticationWorkflow(workflow);
  const initialAuthenticationCheck = authentication && step.stateOnly === true
    && /(?:确认|检查|判断|检测)?(?:当前)?(?:登录|登陆|认证|会话)状态|是否.*(?:登录|登陆|认证)/.test(businessText || stepText);
  const authenticationResult = authentication && (
    submitOrNavigationFeedback
    || /提交登录|点击登录|登录成功|认证成功|进入.*首页/.test(`${businessText} ${stepText}`)
  );

  if (initialAuthenticationCheck) return { before: false, after: false, reason: 'authentication-state-local' };
  if (authentication) {
    return {
      before: false,
      after: authenticationResult || step.stateOnly === true,
      reason: authenticationResult || step.stateOnly ? 'authentication-result' : 'authentication-dom-local',
    };
  }

  const modelVerification = ['vision', 'dom-and-vision', 'page-state'].includes(businessStep?.verification ?? '');
  const resultNode = ['state-check', 'collection', 'detail', 'result'].includes(`${businessStep?.kind ?? ''}`);
  const terminalStep = index === workflow.steps.length - 1;
  return {
    before: branchNode,
    after: step.stateOnly === true || branchNode || modelVerification || resultNode || submitOrNavigationFeedback || terminalStep,
    reason: branchNode ? 'runtime-branch' : resultNode || modelVerification ? 'business-result' : submitOrNavigationFeedback ? 'page-transition' : terminalStep ? 'workflow-result' : 'dom-local',
  };
}

export function buildWorkflowFromTrace(input: {
  skillId: string;
  platformId: string;
  ownerAgentId: string;
  name: string;
  description: string;
  events: OperationTraceEvent[];
  visionEnabled: boolean;
  stepAnnotations?: OperationStepAnnotation[];
  /** Legacy positional fields are accepted only when they match the normalized trace length. */
  stepTitles?: string[];
  stepLocators?: Array<OperationStepLocator | null>;
  stepSemantics?: Array<{ purpose?: string; when?: string; expected?: string }>;
  plan?: OperationWorkflowPlan;
  inputDefaults?: Record<string, string>;
}): OperationWorkflow {
  const compact = collapseDelegatedDomInteractions(compactTraceEvents(input.events));
  const annotations = new Map((input.stepAnnotations ?? [])
    .filter((item) => Number.isInteger(item.stepIndex) && item.stepIndex >= 1 && item.stepIndex <= compact.length)
    .map((item) => [item.stepIndex, item]));
  const alignedLegacyTitles = input.stepTitles?.length === compact.length ? input.stepTitles : undefined;
  const alignedLegacySemantics = input.stepSemantics?.length === compact.length ? input.stepSemantics : undefined;
  const alignedLegacyLocators = input.stepLocators?.length === compact.length ? input.stepLocators : undefined;
  const properties: OperationWorkflow['inputSchema']['properties'] = {};
  const required: string[] = [];
  const steps: OperationWorkflowStep[] = compact.map((event, index) => {
    const id = `step-${String(index + 1).padStart(3, '0')}`;
    const annotation = annotations.get(index + 1);
    const proposedTitle = annotation?.title?.trim() || alignedLegacyTitles?.[index]?.trim();
    const title = proposedTitle && stepTitleMatchesRecordedAction(event, proposedTitle) ? proposedTitle : stepTitle(event, index);
    const legacySemantic = alignedLegacySemantics?.[index];
    const semantic = annotation
      ? { purpose: annotation.purpose, when: annotation.when, expected: annotation.expected }
      : legacySemantic;
    const base = {
      id,
      title,
      timeoutMs: 30_000,
      ...(semantic?.purpose?.trim() ? { purpose: semantic.purpose.trim() } : {}),
      ...(semantic?.when?.trim() ? { when: semantic.when.trim() } : {}),
      ...(semantic?.expected?.trim() ? { expected: semantic.expected.trim() } : {}),
    };
    const traceLocator = locatorFromTraceEvent(event);
    const modelLocator = annotation?.locator ?? alignedLegacyLocators?.[index] ?? undefined;
    const locator = traceLocator || modelLocator
      ? { ...(modelLocator ?? {}), ...(traceLocator ?? {}) }
      : undefined;
    const traceMeta = {
      ...(locator ? { locator } : {}),
      ...(event.screenshotRelPath ? { recordingScreenshotRelPath: event.screenshotRelPath } : {}),
      ...(event.domInteraction ? { domInteraction: event.domInteraction } : {}),
      ...(event.frameUrl && event.type !== 'navigate' ? { frameUrl: event.frameUrl } : {}),
    };
    if (event.type === 'navigate') return { ...base, action: 'navigate' as const, url: event.url };
    if (event.type === 'input') {
      const fieldKey = inputFieldKey(event, index);
      const description = event.accessibleName || event.fieldKey || `步骤 ${index + 1} 的输入值`;
      const defaultValue = input.inputDefaults?.[fieldKey];
      properties[fieldKey] = {
        type: 'string', description,
        ...(event.sensitive ? { sensitive: true } : {}),
        ...(defaultValue ? { defaultValue, source: 'skill-description' as const } : {}),
      };
      if (!required.includes(fieldKey)) required.push(fieldKey);
      return { ...base, ...traceMeta, action: 'fill' as const, ...(event.selectorCandidates ? { selectorCandidates: event.selectorCandidates } : {}), value: `{{input.${fieldKey}}}` };
    }
    if (event.type === 'select') return { ...base, ...traceMeta, action: 'select' as const, ...(event.selectorCandidates ? { selectorCandidates: event.selectorCandidates } : {}), ...(event.value !== undefined ? { value: event.value } : {}) };
    if (event.type === 'press') return { ...base, ...traceMeta, action: 'press' as const, ...(event.selectorCandidates ? { selectorCandidates: event.selectorCandidates } : {}), key: event.key ?? 'Enter' };
    if (event.type === 'scroll') return { ...base, action: 'scroll' as const, x: event.scrollX ?? 0, y: event.scrollY ?? 0 };
    return { ...base, ...traceMeta, action: 'click' as const, ...(event.selectorCandidates ? { selectorCandidates: event.selectorCandidates } : {}) };
  });
  const allowedDomains = [...new Set(input.events.flatMap((event) => {
    try { return [new URL(event.url).hostname]; } catch { return []; }
  }))];
  const finalUrl = [...input.events].reverse().find((event) => event.type === 'navigate' && event.url)?.url
    ?? [...compact].reverse().find((event) => event.url)?.url;
  const evidence = input.events.filter((event) => event.type === 'network-response' && (event.status ?? 0) >= 200 && (event.status ?? 0) < 400)
    .slice(-5).map((event) => `${event.status} ${event.url}`);
  const inferredPlan = normalizeWorkflowPlan(input.plan, steps, input.description, finalUrl);
  return {
    schemaVersion: 1,
    id: input.skillId,
    name: input.name,
    description: input.description,
    platformId: input.platformId,
    ownerAgentId: input.ownerAgentId,
    allowedDomains,
    inputSchema: { type: 'object', properties, required },
    plan: inferredPlan,
    executionMode: 'business-driven',
    steps,
    success: { ...(finalUrl ? { finalUrl } : {}), evidence },
    fallback: { visionEnabled: input.visionEnabled, strategy: input.visionEnabled ? 'dom-then-vision' : 'dom-only' },
    createdAt: nowIso(),
  };
}

export function validateOperationWorkflowStructure(workflow: OperationWorkflow): WorkflowStructuralReview {
  const issues: string[] = [];
  const evidence: string[] = [];
  if (workflow.steps.length === 0) issues.push('工作流没有可执行步骤。');
  else evidence.push(`已生成 ${workflow.steps.length} 个可执行步骤。`);

  const completionCriteria = workflow.plan?.completionCriteria?.filter((item) => typeof item === 'string' && item.trim()) ?? [];
  if (completionCriteria.length === 0) issues.push('缺少能够从页面、网络响应或提取结果观察到的最终完成条件。');
  else evidence.push(`已定义 ${completionCriteria.length} 项最终完成条件。`);

  const stages = workflow.plan?.stages ?? [];
  if (workflow.executionMode === 'legacy-dom') {
    if (stages.length === 0) issues.push('尚未把录制动作抽象为业务工作流阶段。');
    const covered = new Set<number>();
    for (const [index, stage] of stages.entries()) {
      const indexes = stage.stepIndexes ?? [];
      if (indexes.length === 0) issues.push(`阶段“${stage.title || index + 1}”没有关联可执行步骤。`);
      indexes.forEach((stepIndex) => covered.add(stepIndex));
      if (!(stage.completionCriteria ?? []).some((item) => typeof item === 'string' && item.trim())) {
        issues.push(`阶段“${stage.title || index + 1}”缺少可观察的完成条件。`);
      }
    }
    const uncovered = workflow.steps.map((_step, index) => index + 1).filter((index) => !covered.has(index));
    if (uncovered.length > 0) issues.push(`步骤 ${uncovered.join('、')} 没有归属任何业务阶段。`);
    else evidence.push(`全部步骤已归入 ${stages.length} 个业务阶段。`);
  } else if (stages.length > 0) {
    evidence.push(`保留 ${stages.length} 个录制阶段作为学习证据，实际执行由业务节点驱动。`);
  }

  const businessSteps = workflow.plan?.businessSteps ?? [];
  if (businessSteps.length === 0) {
    issues.push('尚未生成面向业务目标的工作流节点。');
  } else {
    const coveredDomSteps = new Set<number>();
    const domOwners = new Map<number, string>();
    for (const [index, businessStep] of businessSteps.entries()) {
      const indexes = businessStep.domStepIndexes ?? [];
      for (const stepIndex of indexes) {
        const previousOwner = domOwners.get(stepIndex);
        if (previousOwner && previousOwner !== businessStep.id) issues.push(`DOM 动作 ${stepIndex} 同时映射到多个业务节点。`);
        domOwners.set(stepIndex, businessStep.id || String(index + 1));
        coveredDomSteps.add(stepIndex);
      }
      if (indexes.length === 0 && !['vision', 'page-state', 'dom-and-vision'].includes(businessStep.verification ?? 'none')) {
        issues.push(`业务节点“${businessStep.title || index + 1}”没有 DOM 动作，也没有页面或视觉校验方式。`);
      }
      if (!(businessStep.completionCriteria ?? []).some((item) => typeof item === 'string' && item.trim())) {
        issues.push(`业务节点“${businessStep.title || index + 1}”缺少可观察的完成条件。`);
      }
    }
    const uncovered = workflow.steps.map((_step, index) => index + 1).filter((index) => !coveredDomSteps.has(index));
    if (coveredDomSteps.size === 0 && workflow.steps.length > 0) issues.push('业务工作流没有引用任何可执行的 DOM 动作。');
    else evidence.push(`${businessSteps.length} 个业务节点引用了 ${coveredDomSteps.size} 个必要 DOM 动作。`);
    if (uncovered.length > 0) evidence.push(`${uncovered.length} 个未映射录制事件仅作为学习证据保存，不会默认执行。`);
  }

  const referencedDomSteps = new Set((workflow.plan?.businessSteps ?? []).flatMap((item) => item.domStepIndexes ?? []));
  for (const [index, step] of workflow.steps.entries()) {
    if (workflow.executionMode !== 'legacy-dom' && !referencedDomSteps.has(index + 1)) continue;
    if (step.action === 'navigate' && !step.url) issues.push(`步骤 ${index + 1} 缺少目标地址。`);
    if (['click', 'fill', 'select'].includes(step.action) && !(step.selectorCandidates?.length || step.locator)) {
      issues.push(`步骤 ${index + 1} 缺少 DOM 或语义定位信息。`);
    }
  }

  const branches = workflow.plan?.branches ?? [];
  if (branches.length > 0) {
    evidence.push(`已定义 ${branches.length} 条运行时判断分支。`);
    for (const branch of branches) {
      const targetStepIndex = branch.targetStepIndex;
      if (Number.isInteger(targetStepIndex) && Number(targetStepIndex) > 0 && !referencedDomSteps.has(Number(targetStepIndex))) {
        issues.push(`分支“${branch.id || branch.when || '动态目标'}”的动态目标动作 ${targetStepIndex} 没有映射到业务节点。`);
      } else if (Number.isInteger(targetStepIndex) && Number(targetStepIndex) > 0) {
        const targetStep = workflow.steps[Number(targetStepIndex) - 1];
        const targetOwners = businessSteps.filter((item) => item.domStepIndexes?.includes(Number(targetStepIndex)));
        if (targetStep && !targetOwners.some((item) => dynamicTargetBusinessStepScore(item, targetStep, businessSteps, Number(targetStepIndex)) >= 6)) {
          issues.push(`分支“${branch.id || branch.when || '动态目标'}”的动作 ${targetStepIndex} 没有映射到负责动态定位目标的业务节点。`);
        }
      }
    }
  }
  if (workflow.fallback.visionEnabled) evidence.push('已保留录制截图并允许视觉证据兜底。');
  else evidence.push('当前模型不支持视觉，工作流按 DOM 证据执行。');
  return { valid: issues.length === 0, issues: [...new Set(issues)], evidence };
}

const RECORDER_SCRIPT = String.raw`
(() => {
  if (window.__KLA_RECORDER_INSTALLED__) return;
  window.__KLA_RECORDER_INSTALLED__ = true;
  const emit = (payload, sourceEvent) => {
    try {
      const trusted = sourceEvent && typeof sourceEvent.isTrusted === 'boolean' ? { nativeEventTrusted: sourceEvent.isTrusted } : {};
      window.__KLA_RECORD__(JSON.stringify({
        ...payload,
        ...trusted,
        url: location.href,
        frameUrl: location.href,
        timestamp: new Date().toISOString(),
      }));
    } catch {}
  };
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const escapeCss = (value) => window.CSS && CSS.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const unique = (selector) => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
  const visible = (element) => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const isInteractive = (element) => {
    if (!(element instanceof Element)) return false;
    const tag = element.tagName.toLowerCase();
    return ['a', 'button', 'input', 'textarea', 'select', 'option', 'label', 'summary'].includes(tag)
      || Boolean(element.getAttribute('role'))
      || element.hasAttribute('onclick')
      || element.tabIndex >= 0
      || getComputedStyle(element).cursor === 'pointer';
  };
  const actionableTarget = (target, sourceEvent) => {
    const path = sourceEvent?.composedPath ? sourceEvent.composedPath() : [];
    const candidates = path.length ? path : [target];
    let textCandidate = null;
    for (const item of candidates) {
      if (!(item instanceof Element) || !visible(item)) continue;
      if (isInteractive(item)) return item;
      const text = clean(item.innerText || item.textContent);
      if (!textCandidate && text && text.length <= 96) textCandidate = item;
    }
    return textCandidate || (target instanceof Element ? target : null);
  };
  const selectors = (element) => {
    if (!(element instanceof Element)) return [];
    const result = [];
    const testId = element.getAttribute('data-testid');
    if (testId) result.push('[data-testid="' + String(testId).replace(/"/g, '\\"') + '"]');
    if (element.id) result.push('#' + escapeCss(element.id));
    const name = element.getAttribute('name');
    if (name) result.push(element.tagName.toLowerCase() + '[name="' + String(name).replace(/"/g, '\\"') + '"]');
    const aria = element.getAttribute('aria-label');
    if (aria) result.push('[aria-label="' + String(aria).replace(/"/g, '\\"') + '"]');
    let node = element;
    const path = [];
    while (node && node.nodeType === 1 && path.length < 18) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      path.unshift(part);
      const candidate = path.join(' > ');
      if (unique(candidate)) { result.push(candidate); break; }
      node = parent;
    }
    return Array.from(new Set(result)).slice(0, 6);
  };
  const compactLocator = (element) => {
    if (!(element instanceof Element)) return null;
    const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element : null;
    const label = element.getAttribute('aria-label') || (input && input.labels && input.labels[0] && input.labels[0].innerText) || element.getAttribute('placeholder') || element.getAttribute('title') || '';
    const text = clean(element.innerText || element.textContent);
    const parentText = clean(element.parentElement?.innerText || element.parentElement?.textContent);
    return {
      ...(text ? { text } : {}),
      ...(clean(label) ? { accessibleName: clean(label) } : {}),
      role: element.getAttribute('role') || element.tagName.toLowerCase(),
      tag: element.tagName.toLowerCase(),
      ...(element.id ? { id: element.id } : {}),
      ...(element.getAttribute('name') ? { name: element.getAttribute('name') } : {}),
      ...(element.getAttribute('data-testid') ? { testId: element.getAttribute('data-testid') } : {}),
      ...(element.getAttribute('placeholder') ? { placeholder: element.getAttribute('placeholder') } : {}),
      ...(element.getAttribute('title') ? { title: element.getAttribute('title') } : {}),
      ...(parentText && parentText !== text && parentText.length <= 120 ? { ancestorText: parentText } : {}),
    };
  };
  const describe = (target, sourceEvent) => {
    const element = actionableTarget(target, sourceEvent);
    if (!element) return {};
    const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element : null;
    const label = element.getAttribute('aria-label') || (input && input.labels && input.labels[0] && input.labels[0].innerText) || element.getAttribute('placeholder') || element.getAttribute('title') || '';
    const name = element.getAttribute('name') || element.id || clean(label) || element.tagName.toLowerCase();
    const inputType = element.getAttribute('type') || element.tagName.toLowerCase();
    const sensitive = inputType === 'password' || /pass|pwd|secret|token|card|验证码|密码|密钥/i.test(name + ' ' + label);
    const parentText = clean(element.parentElement?.innerText || element.parentElement?.textContent);
    const text = clean(element.innerText || element.textContent);
    const locator = {
      ...(text ? { text } : {}),
      ...(clean(label) ? { accessibleName: clean(label) } : {}),
      role: element.getAttribute('role') || element.tagName.toLowerCase(),
      tag: element.tagName.toLowerCase(),
      ...(element.id ? { id: element.id } : {}),
      ...(element.getAttribute('name') ? { name: element.getAttribute('name') } : {}),
      ...(element.getAttribute('data-testid') ? { testId: element.getAttribute('data-testid') } : {}),
      ...(element.getAttribute('placeholder') ? { placeholder: element.getAttribute('placeholder') } : {}),
      ...(element.getAttribute('title') ? { title: element.getAttribute('title') } : {}),
      ...(element instanceof HTMLAnchorElement && element.href ? { href: element.href } : {}),
      ...(parentText && parentText !== text && parentText.length <= 120 ? { ancestorText: parentText } : {}),
    };
    const rawTarget = target instanceof Element ? target : null;
    const path = sourceEvent?.composedPath ? sourceEvent.composedPath() : [];
    const domPath = path.filter((item) => item instanceof Element && visible(item) && isInteractive(item)).slice(0, 8).map(compactLocator).filter(Boolean);
    const domSource = rawTarget && rawTarget !== element ? compactLocator(rawTarget) : null;
    return {
      selectorCandidates: selectors(element), role: element.getAttribute('role') || element.tagName.toLowerCase(), accessibleName: clean(label), text, fieldKey: clean(name), inputType, sensitive, locator,
      ...(domSource ? { domSource } : {}),
      ...(domPath.length > 1 ? { domPath } : {}),
    };
  };
  document.addEventListener('click', (event) => emit({ type: 'click', ...describe(event.target, event) }, event), true);
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement) emit({ type: 'select', ...describe(target, event), value: target.value }, event);
    else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const detail = describe(target, event);
      emit({ type: 'input', ...detail, value: detail.sensitive ? undefined : target.value }, event);
    }
  }, true);
  document.addEventListener('keydown', (event) => { if (event.key === 'Enter') emit({ type: 'press', key: 'Enter', ...describe(event.target, event) }, event); }, true);
  document.addEventListener('submit', (event) => emit({ type: 'submit', ...describe(event.target, event) }, event), true);
  let scrollTimer = 0;
  addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => emit({ type: 'scroll', scrollX, scrollY }), 350);
  }, true);
})();`;

export class OperationSkillManager {
  private sessions = new Map<string, BrowserSession>();
  private recordingQueues = new Map<string, Promise<void>>();
  private cancelledRuns = new Set<string>();
  private runPromises = new Map<string, Promise<void>>();
  private runContexts = new Map<string, OperationLoopContext>();

  constructor(
    private db: Database.Database,
    private getGateway: () => ModelGateway | null,
    private dispatch: (event: Record<string, unknown>) => void,
    private studioRoot = getStudioRoot(),
  ) {}

  syncPlatform(input: OperationPlatformInput): { platformId: string; ownerAgentId: string } {
    const normalized = new URL(input.url);
    if (!['http:', 'https:'].includes(normalized.protocol)) throw new Error('操作平台仅支持 HTTP 或 HTTPS 地址');
    const existingRow = this.db.prepare('SELECT id FROM operation_platforms WHERE id = ?').get(input.id);
    if (!input.modelProfileId?.trim() && !existingRow) throw new Error('操作智能体必须绑定模型');
    const ownerAgentId = `operation-agent-${safeSegment(input.id)}`;
    const now = nowIso();
    this.db.prepare(
      `INSERT INTO operation_platforms (id, owner_agent_id, name, url, description, model_profile_id, temperature, status, created_at, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET owner_agent_id = excluded.owner_agent_id, name = excluded.name, url = excluded.url,
         description = excluded.description, model_profile_id = excluded.model_profile_id, temperature = excluded.temperature,
         updated_at = excluded.updated_at`,
    ).run(input.id, ownerAgentId, input.name.trim(), normalized.toString(), input.description?.trim() ?? '', input.modelProfileId || null, Math.max(0, Math.min(2, input.temperature ?? 0.7)), now, now);
    void this.ensureAgentDefinition({ ...input, url: normalized.toString() }, ownerAgentId);
    const existing = this.sessions.get(input.id);
    if (existing && existing.view.webContents.getURL() !== normalized.toString()) void existing.view.webContents.loadURL(normalized.toString());
    return { platformId: input.id, ownerAgentId };
  }

  /**
   * 操作智能体有自己的身份、记忆和成果目录。默认目录与群聊实例隔离；
   * 关联项目后，项目工作区只为该操作智能体建立同名的身份/记忆目录，
   * 不复制或暴露其它智能体的数据。
   */
  async ensureWorkspace(platformId: string, projectId?: string): Promise<{
    platformId: string;
    ownerAgentId: string;
    defaultRoot: string;
    projectRoot?: string;
  }> {
    const platform = this.getPlatform(platformId);
    await this.ensureAgentDefinition({
      id: platform.id,
      name: platform.name,
      url: platform.url,
      description: platform.description,
      temperature: platform.temperature,
      ...(platform.modelProfileId ? { modelProfileId: platform.modelProfileId } : {}),
    }, platform.ownerAgentId);

    const defaultRoot = join(this.studioRoot, 'operation-agents', `${safeSegment(platform.ownerAgentId)}-workspace`);
    await this.initializeWorkspaceRoot(defaultRoot, platform);

    let projectRoot: string | undefined;
    if (projectId?.trim()) {
      projectRoot = await ensureEnterpriseProjectWorkspace({ projectId: projectId.trim() });
      const projectContextRoot = join(projectRoot, '.runtime', 'node-context', 'operations', safeSegment(platform.ownerAgentId));
      await this.initializeMemoryAndOutputs(projectContextRoot, platform.ownerAgentId, platform.name);
    }
    return { platformId, ownerAgentId: platform.ownerAgentId, defaultRoot, ...(projectRoot ? { projectRoot } : {}) };
  }

  private async initializeWorkspaceRoot(root: string, platform: { ownerAgentId: string; name: string; description: string; url: string }): Promise<void> {
    await mkdir(root, { recursive: true });
    await this.initializeMemoryAndOutputs(root, platform.ownerAgentId, platform.name);
    const definitionRoot = join(this.studioRoot, 'agent-definitions', 'custom', platform.ownerAgentId, '1.0.0');
    await cp(join(definitionRoot, 'skills'), join(root, 'skills'), { recursive: true, force: true }).catch(() => undefined);
    const identityRoot = join(root, 'agent-identities', platform.ownerAgentId);
    await mkdir(identityRoot, { recursive: true });
    const mailboxSecretary = isMailboxSecretaryPlatform(platform);
    const identity = await readFile(join(definitionRoot, 'IDENTITY.md'), 'utf8').catch(() => `# 身份\n\n你是“${platform.name}操作智能体”，只在绑定的平台内调用已生效技能。\n`);
    await writeIfMissing(join(identityRoot, 'IDENTITY.md'), identity);
    await writeFile(join(identityRoot, 'ROLE.md'), mailboxSecretary
      ? `# 角色卡\n\n- 名称：邮箱秘书智能体\n- 平台：邮箱读取演示服务\n- 地址：${platform.url}\n- 说明：接收统筹智能体的邮件读取委派，返回固定演示邮件结果。\n- 调用方式：仅允许后端在统筹委派链路中调用；后端等待 10 秒后回传结果。\n- 边界：不直接面向用户执行网页操作，不索要账号密码，不继续委派其他智能体。\n`
      : `# 角色卡\n\n- 名称：${platform.name}操作智能体\n- 平台：${platform.name}\n- 地址：${platform.url}\n- 说明：${platform.description || '通过 DOM 与视觉理解完成网站操作，并返回可核验结果。'}\n- 边界：只处理本平台任务，不读取其他智能体的身份、记忆或工作区。\n`, 'utf8');
    await writeFile(join(identityRoot, 'COORDINATION.md'), mailboxSecretary
      ? '# 公开协作职责\n\n只接受统筹智能体的邮件读取委派。后端演示流程等待 10 秒后，向统筹回传固定邮件信息和附件状态；不得自行执行网页技能或向用户提问。\n'
      : `# 公开协作职责\n\n负责理解用户对“${platform.name}”的操作需求，选择最小必要的已生效技能并返回页面结果；技能无法安全匹配时先澄清，不猜测。\n`, 'utf8');
    await writeIfMissing(join(identityRoot, 'ADAPTATION.md'), `# 适应性补充\n\n这里只记录该操作智能体在本平台内经过验证的稳定偏好。\n`);
    await writeFile(join(root, 'WORKSPACE.md'), `# ${platform.name}操作智能体工作区\n\n- agent-identities/${platform.ownerAgentId}/：本智能体的身份、角色卡与适应性补充。\n- agent-memories/${platform.ownerAgentId}/：本智能体自己的短期、长期和会话记忆。\n- skills/：本平台已安装的操作技能。\n- outputs/：本平台操作产生的成果。\n\n${mailboxSecretary ? '邮箱秘书仅作为统筹委派的后端演示代理，邮件固定结果由系统回传。\n' : ''}禁止读取其它智能体的身份、记忆和工作区。\n`, 'utf8');
  }

  private async initializeMemoryAndOutputs(root: string, ownerAgentId: string, name: string): Promise<void> {
    const memoryRoot = join(root, 'agent-memories', ownerAgentId);
    await Promise.all([
      mkdir(join(memoryRoot, 'short-term'), { recursive: true }),
      mkdir(join(memoryRoot, 'long-term'), { recursive: true }),
      mkdir(join(memoryRoot, 'sessions'), { recursive: true }),
      mkdir(join(root, 'outputs'), { recursive: true }),
    ]);
    const now = new Date().toISOString();
    const current = join(memoryRoot, 'short-term', 'current.md');
    const summary = join(memoryRoot, 'long-term', 'summary.md');
    const index = join(memoryRoot, 'index.jsonl');
    await writeIfMissing(current, `---\nschemaVersion: 1\nscope: short-term\nupdatedAt: ${now}\n---\n\n# 当前任务记忆\n\n${name}暂无活跃任务。\n`);
    await writeIfMissing(summary, `---\nschemaVersion: 1\nscope: long-term\nupdatedAt: ${now}\n---\n\n# 长期记忆摘要\n\n${name}尚未形成长期记忆。\n`);
    await writeIfMissing(index, '');
  }

  private async ensureAgentDefinition(input: OperationPlatformInput, ownerAgentId: string): Promise<void> {
    const root = join(this.studioRoot, 'agent-definitions', 'custom', ownerAgentId, '1.0.0');
    await mkdir(join(root, 'skills'), { recursive: true });
    const mailboxSecretary = isMailboxSecretaryPlatform({ name: input.name, url: input.url });
    await writeIfMissing(join(root, 'IDENTITY.md'), mailboxSecretary
      ? `---\nschemaVersion: 2\nscope: definition\ndefinitionId: ${ownerAgentId}\ndefinitionVersion: 1.0.0\n---\n\n# 身份\n\n你是“邮箱秘书智能体”。你只接受统筹智能体委派的邮件读取任务，邮件结果由后端演示流程固定回传；不要直接执行网页操作、不要向用户索要账号密码、不要继续委派其他智能体。\n`
      : `---\nschemaVersion: 2\nscope: definition\ndefinitionId: ${ownerAgentId}\ndefinitionVersion: 1.0.0\n---\n\n# 身份\n\n你是“${input.agentName?.trim() || `${input.name}操作智能体`}”。你只负责在 ${input.name}（${input.url}）内使用已生效的专属操作技能完成任务。执行前确认技能与用户目标匹配；技能不存在、已注销或关键输入缺失时明确说明，不得猜测操作。\n`);
    await writeFile(join(root, 'agent.yaml'), `schemaVersion: 1\nid: ${ownerAgentId}\nversion: 1.0.0\ndisplayName: ${JSON.stringify(input.agentName?.trim() || `${input.name}操作智能体`)}\nruntime: native-model\nframework: loop-engine\nentry: operationAgentLoop\ndefaultModelSlot: reasoning\n`, 'utf8');
  }

  private getPlatform(platformId: string): { id: string; ownerAgentId: string; name: string; url: string; description: string; modelProfileId: string | null; temperature: number; status: string } {
    const row = this.db.prepare(
      `SELECT id, owner_agent_id as ownerAgentId, name, url, description, model_profile_id as modelProfileId, temperature, status
       FROM operation_platforms WHERE id = ?`,
    ).get(platformId) as ReturnType<OperationSkillManager['getPlatform']> | undefined;
    if (!row) throw new Error('操作平台不存在');
    if (row.status !== 'active') throw new Error('操作平台已注销');
    return row;
  }

  addConversationMessage(
    platformId: string,
    role: OperationConversationMessage['role'],
    content: string,
    relatedRunId: string | null = null,
    metadata: Record<string, unknown> = {},
  ): OperationConversationMessage {
    const message: OperationConversationMessage = {
      id: randomUUID(), platformId, role, content: content.trim(), relatedRunId, metadata, createdAt: nowIso(),
    };
    if (!message.content) throw new Error('对话消息不能为空');
    this.db.prepare(
      `INSERT INTO operation_conversation_messages (id, platform_id, role, content, related_run_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(message.id, platformId, role, message.content, relatedRunId, JSON.stringify(metadata), message.createdAt);
    this.dispatch({ type: 'operation.conversation', platformId, message });
    return message;
  }

  listConversation(platformId: string, limit = 100): OperationConversationMessage[] {
    const rows = this.db.prepare(
      `SELECT * FROM (
         SELECT rowid as rowSequence, id, platform_id as platformId, role, content, related_run_id as relatedRunId,
                metadata_json as metadataJson, created_at as createdAt
         FROM operation_conversation_messages WHERE platform_id = ?
         ORDER BY rowid DESC LIMIT ?
       ) ORDER BY rowSequence`,
    ).all(platformId, Math.max(1, Math.min(500, limit))) as Array<Omit<OperationConversationMessage, 'metadata'> & { metadataJson: string | null; rowSequence: number }>;
    return rows.map(({ metadataJson, rowSequence: _rowSequence, ...row }) => ({ ...row, metadata: safeJson(metadataJson, {}) }));
  }

  private ensureSession(platformId: string, host?: BrowserWindow): BrowserSession {
    const existing = this.sessions.get(platformId);
    if (existing && !existing.view.webContents.isDestroyed()) return existing;
    const platform = this.getPlatform(platformId);
    const window = host ?? BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
    if (!window) throw new Error('主窗口尚未就绪');
    const partition = `persist:kla-operation-${createHash('sha1').update(platformId).digest('hex').slice(0, 20)}`;
    const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    // The view is hidden while the operation page is being laid out. Keep its
    // renderer active so the first visible frame is not delayed by background
    // throttling, while retaining the persistent session cache.
    view.webContents.setBackgroundThrottling(false);
    window.contentView.addChildView(view);
    view.setVisible(false);
    const session: BrowserSession = { platformId, host: window, view, visible: false, debuggerReady: false, currentRecordingId: null };
    this.sessions.set(platformId, session);
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void view.webContents.loadURL(url);
      return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (event, url) => { if (!/^https?:\/\//i.test(url)) event.preventDefault(); });
    view.webContents.on('did-navigate', (_event, url) => {
      if (session.currentRecordingId) void this.queueTrace(session.currentRecordingId, { type: 'navigate', timestamp: nowIso(), url });
      this.dispatch({ type: 'operation.browser.navigated', platformId, ...this.getNavigationState(session), url });
    });
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      if (session.currentRecordingId) void this.queueTrace(session.currentRecordingId, { type: 'navigate', timestamp: nowIso(), url });
      this.dispatch({ type: 'operation.browser.navigated', platformId, ...this.getNavigationState(session), url });
    });
    view.webContents.on('did-finish-load', () => {
      this.dispatch({ type: 'operation.browser.ready', platformId, ...this.getNavigationState(session) });
    });
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      this.dispatch({ type: 'operation.browser.error', platformId, errorCode, errorDescription, url: validatedURL });
    });
    void view.webContents.loadURL(platform.url);
    return session;
  }

  private getNavigationState(session: BrowserSession): BrowserNavigationState {
    return {
      url: session.view.webContents.getURL(),
      canGoBack: session.view.webContents.canGoBack(),
      canGoForward: session.view.webContents.canGoForward(),
    };
  }

  getBrowserNavigation(platformId: string): BrowserNavigationState {
    const session = this.sessions.get(platformId);
    if (!session || session.view.webContents.isDestroyed()) {
      const platform = this.getPlatform(platformId);
      return { url: platform.url, canGoBack: false, canGoForward: false };
    }
    return this.getNavigationState(session);
  }

  goBack(platformId: string): BrowserNavigationState {
    const session = this.sessions.get(platformId);
    if (session && !session.view.webContents.isDestroyed() && session.view.webContents.canGoBack()) session.view.webContents.goBack();
    return session && !session.view.webContents.isDestroyed() ? this.getNavigationState(session) : this.getBrowserNavigation(platformId);
  }

  goForward(platformId: string): BrowserNavigationState {
    const session = this.sessions.get(platformId);
    if (session && !session.view.webContents.isDestroyed() && session.view.webContents.canGoForward()) session.view.webContents.goForward();
    return session && !session.view.webContents.isDestroyed() ? this.getNavigationState(session) : this.getBrowserNavigation(platformId);
  }

  showView(platformId: string, bounds: Rectangle, host?: BrowserWindow): { visible: true; url: string } {
    const session = this.ensureSession(platformId, host);
    for (const [id, candidate] of this.sessions) {
      const visible = id === platformId;
      candidate.visible = visible;
      candidate.view.setVisible(visible);
    }
    session.view.setBounds({
      x: Math.max(0, Math.round(bounds.x)), y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(320, Math.round(bounds.width)), height: Math.max(180, Math.round(bounds.height)),
    });
    return { visible: true, ...this.getNavigationState(session) };
  }

  hideView(platformId?: string): void {
    for (const [id, session] of this.sessions) {
      if (!platformId || id === platformId) { session.visible = false; session.view.setVisible(false); }
    }
  }

  private async prepareDebugger(session: BrowserSession): Promise<void> {
    if (session.debuggerReady) return;
    const debug = session.view.webContents.debugger;
    if (!debug.isAttached()) debug.attach('1.3');
    await debug.sendCommand('Runtime.enable');
    await debug.sendCommand('Page.enable');
    await debug.sendCommand('Network.enable');
    await debug.sendCommand('Runtime.addBinding', { name: '__KLA_RECORD__' });
    await debug.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER_SCRIPT });
    debug.on('message', (_event, method, params) => {
      if (!session.currentRecordingId) return;
      if (method === 'Runtime.bindingCalled' && (params as { name?: string }).name === '__KLA_RECORD__') {
        const raw = (params as { payload?: string }).payload;
        if (!raw) return;
        try { void this.queueTrace(session.currentRecordingId, JSON.parse(raw) as OperationTraceEvent, session); } catch { /* invalid page payload */ }
      }
      if (method === 'Network.responseReceived') {
        const response = (params as { response?: { url?: string; status?: number; mimeType?: string } }).response;
        if (!response?.url || !/^https?:/i.test(response.url)) return;
        void this.queueTrace(session.currentRecordingId, {
          type: 'network-response', timestamp: nowIso(), url: response.url,
          ...(response.status !== undefined ? { status: response.status } : {}),
          ...(response.mimeType !== undefined ? { mimeType: response.mimeType } : {}),
        });
      }
    });
    session.debuggerReady = true;
    await debug.sendCommand('Runtime.evaluate', { expression: RECORDER_SCRIPT }).catch(() => undefined);
  }

  async beginRecording(platformId: string, host?: BrowserWindow): Promise<{ recordingId: string; startedAt: string }> {
    const platform = this.getPlatform(platformId);
    const session = this.ensureSession(platformId, host);
    await this.prepareDebugger(session);
    if (session.currentRecordingId) throw new Error('当前平台已有正在进行的录制');
    const id = randomUUID();
    const startedAt = nowIso();
    const root = join(this.studioRoot, '.kstudio', 'operations', safeSegment(platformId), 'recordings', id);
    await mkdir(join(root, 'screenshots'), { recursive: true });
    const tracePath = join(root, 'trace.jsonl');
    await writeFile(tracePath, '', 'utf8');
    const traceRelPath = normalizeRelPath(relative(this.studioRoot, tracePath));
    this.db.prepare(
      `INSERT INTO operation_recording_sessions (id, platform_id, status, trace_rel_path, event_count, started_at, updated_at)
       VALUES (?, ?, 'recording', ?, 0, ?, ?)`,
    ).run(id, platformId, traceRelPath, startedAt, startedAt);
    session.currentRecordingId = id;
    await this.queueTrace(id, { type: 'navigate', timestamp: startedAt, url: session.view.webContents.getURL() || platform.url }, session);
    this.dispatch({ type: 'operation.recording', platformId, recordingId: id, status: 'recording', startedAt });
    return { recordingId: id, startedAt };
  }

  pauseRecording(recordingId: string, paused: boolean): void {
    const row = this.db.prepare('SELECT platform_id as platformId, status FROM operation_recording_sessions WHERE id = ?').get(recordingId) as { platformId: string; status: string } | undefined;
    if (!row || !['recording', 'paused'].includes(row.status)) throw new Error('录制会话不可暂停');
    const status = paused ? 'paused' : 'recording';
    this.db.prepare('UPDATE operation_recording_sessions SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), recordingId);
    this.dispatch({ type: 'operation.recording', platformId: row.platformId, recordingId, status });
  }

  async stopRecording(recordingId: string): Promise<{ eventCount: number }> {
    const row = this.db.prepare('SELECT platform_id as platformId, status FROM operation_recording_sessions WHERE id = ?').get(recordingId) as { platformId: string; status: string } | undefined;
    if (!row || !['recording', 'paused'].includes(row.status)) throw new Error('录制会话不可停止');
    const queued = this.recordingQueues.get(recordingId);
    if (queued) await queued;
    const session = this.sessions.get(row.platformId);
    if (session?.currentRecordingId === recordingId) session.currentRecordingId = null;
    const stoppedAt = nowIso();
    this.db.prepare("UPDATE operation_recording_sessions SET status = 'stopped', stopped_at = ?, updated_at = ? WHERE id = ?").run(stoppedAt, stoppedAt, recordingId);
    const count = (this.db.prepare('SELECT event_count as count FROM operation_recording_sessions WHERE id = ?').get(recordingId) as { count: number }).count;
    this.dispatch({ type: 'operation.recording', platformId: row.platformId, recordingId, status: 'stopped', eventCount: count });
    return { eventCount: count };
  }

  async saveRecordingVideo(recordingId: string, bytes?: Uint8Array): Promise<{ recordingRelPath: string | null }> {
    const row = this.db.prepare('SELECT platform_id as platformId, trace_rel_path as traceRelPath, status FROM operation_recording_sessions WHERE id = ?').get(recordingId) as { platformId: string; traceRelPath: string; status: string } | undefined;
    if (!row || !['stopped', 'saved'].includes(row.status)) throw new Error('请先停止录制');
    let recordingRelPath: string | null = null;
    if (bytes?.byteLength) {
      if (bytes.byteLength > 1024 * 1024 * 1024) throw new Error('录制视频超过 1GB 限制');
      const target = join(dirname(join(this.studioRoot, row.traceRelPath)), 'operation.webm');
      await writeFile(target, bytes);
      recordingRelPath = normalizeRelPath(relative(this.studioRoot, target));
    }
    this.db.prepare("UPDATE operation_recording_sessions SET status = 'saved', recording_rel_path = ?, updated_at = ? WHERE id = ?").run(recordingRelPath, nowIso(), recordingId);
    this.dispatch({ type: 'operation.recording', platformId: row.platformId, recordingId, status: 'saved', recordingRelPath });
    return { recordingRelPath };
  }

  private queueTrace(recordingId: string, event: OperationTraceEvent, session?: BrowserSession): Promise<void> {
    const previous = this.recordingQueues.get(recordingId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const row = this.db.prepare('SELECT trace_rel_path as traceRelPath, status FROM operation_recording_sessions WHERE id = ?').get(recordingId) as { traceRelPath: string; status: string } | undefined;
      if (!row || row.status !== 'recording') return;
      const actionable = event.type !== 'network-response';
      if (actionable && session && !event.sensitive) {
        try {
          const countRow = this.db.prepare('SELECT event_count as count FROM operation_recording_sessions WHERE id = ?').get(recordingId) as { count: number };
          const screenshot = await session.view.webContents.capturePage();
          const target = join(dirname(join(this.studioRoot, row.traceRelPath)), 'screenshots', `${String(countRow.count + 1).padStart(4, '0')}.png`);
          await writeFile(target, screenshot.toPNG());
          event.screenshotRelPath = normalizeRelPath(relative(this.studioRoot, target));
        } catch { /* screenshots are optional */ }
      }
      const sanitizedBase = {
        ...event,
        url: redactUrl(event.url),
        ...(event.frameUrl ? { frameUrl: redactUrl(event.frameUrl) } : {}),
      };
      const sanitized: OperationTraceEvent = event.sensitive
        ? Object.fromEntries(Object.entries(sanitizedBase).filter(([key]) => key !== 'value' && key !== 'text')) as OperationTraceEvent
        : sanitizedBase;
      await appendFile(join(this.studioRoot, row.traceRelPath), `${JSON.stringify(sanitized)}\n`, 'utf8');
      this.db.prepare('UPDATE operation_recording_sessions SET event_count = event_count + 1, updated_at = ? WHERE id = ?').run(nowIso(), recordingId);
    }).catch((error) => getLogger(this.studioRoot)?.warn({ err: error, recordingId }, '操作录制事件写入失败'));
    this.recordingQueues.set(recordingId, next);
    return next;
  }

  async learnSkill(input: { platformId: string; recordingId: string; name: string; description: string }): Promise<{ skillId: string; status: string }> {
    const platform = this.getPlatform(input.platformId);
    if (!platform.modelProfileId) throw new Error('请先为操作智能体绑定模型，再学习技能');
    const recording = this.db.prepare(
      'SELECT id, status FROM operation_recording_sessions WHERE id = ? AND platform_id = ?',
    ).get(input.recordingId, input.platformId) as { id: string; status: string } | undefined;
    if (!recording || recording.status !== 'saved') throw new Error('操作视频和 DOM 轨迹尚未保存');
    const name = input.name.trim();
    const description = input.description.trim();
    if (!name || !description) throw new Error('技能名称和说明不能为空');
    const skillId = `operation-${createHash('sha1').update(`${input.platformId}:${name}:${randomUUID()}`).digest('hex').slice(0, 20)}`;
    const now = nowIso();
    this.db.prepare(
      `INSERT INTO operation_skills (id, platform_id, owner_agent_id, recording_session_id, name, description, status, model_profile_id, learning_phase, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'learning', ?, 'processing', ?, ?)`,
    ).run(skillId, input.platformId, platform.ownerAgentId, input.recordingId, name, description, platform.modelProfileId, now, now);
    this.addLearningMessage(skillId, 'agent', `我正在理解“${name}”的操作顺序、输入项和完成条件。`);
    this.dispatch({ type: 'operation.learning', platformId: input.platformId, skillId, status: 'learning' });
    void this.processLearning(skillId);
    return { skillId, status: 'learning' };
  }

  async replyLearning(skillId: string, content: string): Promise<void> {
    const skill = this.getSkill(skillId);
    if (!['learning', 'active', 'draft', 'failed'].includes(skill.status)) throw new Error('当前技能不支持学习修正');
    if (!content.trim()) return;
    const answer = content.trim();
    this.resolvePendingLearningIssues(skillId, answer);
    this.addLearningMessage(skillId, 'user', answer);
    if (!skill.recordingSessionId) {
      this.addLearningMessage(skillId, 'agent', '我已经收到你的修改说明，但这项技能没有可回放的录制轨迹，暂时无法安全改写操作步骤。请重新录制一次该技能，我会按新的说明重新学习。');
      this.dispatch({ type: 'operation.learning', platformId: skill.platformId, skillId, status: skill.status, messageAdded: true });
      return;
    }
    // A new correction supersedes an unactivated candidate revision. The
    // active workflow remains untouched until the user confirms it.
    const resumedStatus = skill.status === 'failed' ? 'learning' : skill.status;
    this.db.prepare("UPDATE operation_skills SET status = ?, learning_phase = 'processing', learning_error = NULL, pending_workflow_json = NULL, pending_summary = NULL, updated_at = ? WHERE id = ?").run(resumedStatus, nowIso(), skillId);
    this.dispatch({ type: 'operation.learning', platformId: skill.platformId, skillId, status: 'learning', messageAdded: true });
    // Wait for the model's correction reply before completing the IPC request.
    // This keeps the skill-management dialog from looking silent while the
    // response is already being persisted in the background.
    await this.processLearning(skillId);
  }

  private addLearningMessage(skillId: string, role: 'user' | 'agent' | 'system', content: string): void {
    this.db.prepare('INSERT INTO operation_learning_messages (id, skill_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), skillId, role, content, nowIso());
  }

  private resolvePendingLearningIssues(skillId: string, answer: string): void {
    let pending = this.db.prepare(
      `SELECT issue_id as issueId FROM operation_learning_resolutions
       WHERE skill_id = ? AND status = 'pending' ORDER BY created_at`,
    ).all(skillId) as Array<{ issueId: string }>;
    // Learning conversations created before resolution tracking may already
    // be waiting on a visible question. Bind the reply to that question so
    // upgrading does not force the user to answer it twice more.
    if (pending.length === 0) {
      const phase = this.db.prepare('SELECT learning_phase as learningPhase FROM operation_skills WHERE id = ?')
        .get(skillId) as { learningPhase?: string } | undefined;
      if (phase?.learningPhase === 'awaiting-user') {
        const latestQuestion = this.db.prepare(
          `SELECT content FROM operation_learning_messages
           WHERE skill_id = ? AND role = 'agent' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        ).get(skillId) as { content?: string } | undefined;
        if (latestQuestion?.content?.trim()) {
          pending = [{ issueId: this.savePendingLearningIssue(skillId, latestQuestion.content.trim(), '') }];
        }
      }
    }
    if (pending.length === 0) return;
    const resolvedAt = nowIso();
    const sourcePriority = detectLearningSourcePriority(answer);
    const update = this.db.prepare(
      `UPDATE operation_learning_resolutions
       SET status = 'resolved', answer = ?, source_priority = ?, resolved_at = ?
       WHERE skill_id = ? AND issue_id = ?`,
    );
    const transaction = this.db.transaction(() => {
      for (const item of pending) update.run(answer, sourcePriority, resolvedAt, skillId, item.issueId);
    });
    transaction();
  }

  private listLearningResolutions(skillId: string): LearningResolution[] {
    return this.db.prepare(
      `SELECT issue_id as issueId, question, mismatch, status, answer,
              source_priority as sourcePriority, created_at as createdAt, resolved_at as resolvedAt
       FROM operation_learning_resolutions WHERE skill_id = ? ORDER BY created_at, issue_id`,
    ).all(skillId) as LearningResolution[];
  }

  private savePendingLearningIssue(skillId: string, question: string, mismatch: string): string {
    const issueId = learningIssueId(question, mismatch);
    const createdAt = nowIso();
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE operation_learning_resolutions SET status = 'superseded'
         WHERE skill_id = ? AND status = 'pending' AND issue_id != ?`,
      ).run(skillId, issueId);
      this.db.prepare(
        `INSERT INTO operation_learning_resolutions
           (skill_id, issue_id, question, mismatch, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(skill_id, issue_id) DO UPDATE SET
           question = excluded.question,
           mismatch = excluded.mismatch,
           status = 'pending',
           answer = NULL,
           source_priority = NULL,
           created_at = excluded.created_at,
           resolved_at = NULL`,
      ).run(skillId, issueId, question, mismatch || null, createdAt);
    })();
    return issueId;
  }

  private async readTrace(recordingId: string): Promise<OperationTraceEvent[]> {
    const row = this.db.prepare('SELECT trace_rel_path as traceRelPath FROM operation_recording_sessions WHERE id = ?').get(recordingId) as { traceRelPath: string } | undefined;
    if (!row) return [];
    const raw = await readFile(join(this.studioRoot, row.traceRelPath), 'utf8');
    return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as OperationTraceEvent]; } catch { return []; }
    });
  }

  private modelSupportsVision(profileId: string | null): boolean {
    if (!profileId) return false;
    const row = this.db.prepare(
      'SELECT model_id as modelId, declared_capabilities_json as declared, verified_capabilities_json as verified FROM model_profiles WHERE id = ?',
    ).get(profileId) as { modelId: string; declared: string | null; verified: string | null } | undefined;
    if (!row) return false;
    return /vision|image|multimodal|视觉|图像/i.test(`${row.modelId} ${row.declared ?? ''} ${row.verified ?? ''}`);
  }

  private async processLearning(skillId: string): Promise<void> {
    const skill = this.getSkill(skillId);
    if (!skill.recordingSessionId || !['learning', 'draft', 'active'].includes(skill.status)) return;
    const preserveActive = skill.status === 'active';
    try {
      this.db.prepare("UPDATE operation_skills SET learning_phase = 'processing', updated_at = ? WHERE id = ?").run(nowIso(), skillId);
      const events = await this.readTrace(skill.recordingSessionId);
      if (!events.some((event) => ['click', 'input', 'select', 'press', 'submit'].includes(event.type))) throw new Error('没有录制到可执行的页面操作，请重新录制');
      const messages = this.listLearningMessages(skillId);
      const learningResolutions = this.listLearningResolutions(skillId);
      const resolvedDecisions = learningResolutions
        .filter((item) => item.status === 'resolved' && item.answer)
        .map((item) => ({
          issueId: item.issueId,
          question: item.question,
          mismatch: item.mismatch,
          answer: item.answer,
          sourcePriority: item.sourcePriority,
        }));
      const platform = this.getPlatform(skill.platformId);
      const gateway = this.getGateway();
      const compactEvents = collapseDelegatedDomInteractions(compactTraceEvents(events));
      const traceDigest = compactEvents.map((event, index) => ({
        index: index + 1, type: event.type, url: event.url, target: event.accessibleName || event.text || event.locator?.text || event.fieldKey,
        inputType: event.inputType, key: event.key, role: event.role, locator: event.locator,
        domSource: event.domSource, domPath: event.domPath, nativeEventTrusted: event.nativeEventTrusted,
        domInteraction: event.domInteraction,
        screenshot: event.screenshotRelPath ? `recording:${index + 1}` : undefined,
      }));
      const inputFields = compactEvents
        .map((event, index) => event.type === 'input' ? { key: inputFieldKey(event, index), label: event.accessibleName || event.fieldKey || `步骤 ${index + 1} 的输入值`, sensitive: event.sensitive === true } : null)
        .filter((field): field is OperationInputField => !!field);
      const extractedDefaults = extractFixedInputValues(skill.description, inputFields);
      const transcript = messages.map((item) => ({ role: item.role, content: item.content }));
      const detectedInputs = Object.fromEntries(inputFields.map((field) => [field.key, { label: field.label, fixed: Boolean(extractedDefaults[field.key]), sensitive: field.sensitive }]));
      const traceImages: Uint8Array[] = [];
      const visionEnabled = this.modelSupportsVision(platform.modelProfileId);
      if (visionEnabled) {
        const screenshotPaths = events.filter((event) => event.screenshotRelPath).slice(0, 4).map((event) => event.screenshotRelPath!);
        for (const screenshotPath of screenshotPaths) {
          try { traceImages.push(await readFile(join(this.studioRoot, screenshotPath))); } catch { /* optional reference screenshot */ }
        }
      }
      const modelSnapshot = JSON.stringify({ profileId: platform.modelProfileId, parameters: { temperature: platform.temperature } });
      const requestObject = <T>(prompt: string, system: string): Promise<T> => {
        if (!gateway || !platform.modelProfileId) return Promise.reject(new Error('操作智能体未绑定可用模型'));
        return gateway.runWithModelProfileSnapshot(
          modelSnapshot,
          () => traceImages.length > 0
            ? gateway.generateObjectWithImages<T>('reasoning', prompt, traceImages, system)
            : gateway.generateObject<T>('reasoning', [{ role: 'user', content: prompt }], system),
        );
      };
      const requestAnalysis = (repairFeedback: string[] = []): Promise<LearningAnalysis> => {
        const prompt = `请结合真实网页操作轨迹、录制截图和用户说明，理解并构建这个网页技能。
技能名称：${skill.name}
技能说明：${skill.description}
平台说明：${platform.description}
已经按用户手势归并的 DOM 轨迹：${JSON.stringify(traceDigest)}
此前问答：${JSON.stringify(transcript)}
用户已经确认的裁决（最高优先级，禁止再次询问同一事项）：${JSON.stringify(resolvedDecisions)}
技能说明中已检测到的输入：${JSON.stringify(detectedInputs)}${repairFeedback.length ? `\n上一轮工作流校验发现的问题：${JSON.stringify(repairFeedback)}` : ''}

必须严格按以下方式构建：
1. plan.businessSteps 是唯一的执行主流程。先从用户说明、录制截图和操作结果中归纳真实的业务顺序、分支、前置状态和完成条件。
2. 归并后的 DOM 轨迹只是可引用的动作证据库。每个业务节点只通过 domStepIndexes 引用完成该节点确实需要的 DOM 动作；未被业务节点引用的录制事件不会执行，也不要求全部覆盖。
3. 同一个业务节点可以引用多个 DOM 动作，也可以在状态判断和结果确认时不引用 DOM，仅使用 vision/page-state。dependsOn 必须表达真正的业务依赖，不能按录制位置机械补齐。
4. 如果无法确认用户行为的业务含义、分支条件或某个 DOM 动作是否应执行，ready=false，并在 questions 中用自然语言向用户询问；禁止用完整录制轨迹兜底成固定宏。
5. 用户已经确认的裁决是本轮学习的既定事实。sourcePriority=user-description 表示业务意图和步骤以用户说明为准，录制截图与 DOM 只用于寻找实现该意图的动作证据；sourcePriority=recording-evidence 表示以真实录制操作为准。不得以换一种措辞的方式重新询问已经解决的问题。

一次用户手势可能产生 div click、所属 button click、组件代理事件、form submit 和路由反馈。domInteraction 已把它们归为一个 DOM 执行动作：source 是原始点击目标，effective/propagated 是控件链，feedbackTypes 是反馈证据，均不得拆成额外业务动作或重复执行。录制示例条目只用于证明“页面中的一条记录可以怎样被点击”，不得写入 fixedFacts、固定选择器语义、完成条件或以后唯一目标。动态记录节点必须引用该示例点击对应的 domStepIndexes，运行时会用用户当前目标替换录制文本和行号；不能因为目标会变化就把点击节点留成无 DOM 的 page-state。branches.targetStepIndex 必须同时出现在对应动态业务节点的 domStepIndexes 中。列表已有字段足以回答时停留在列表；用户需要的字段不在列表时，即使没有说“详情”二字，也必须进入匹配条目的详情。最终完成条件应描述已经取得足以回答用户的结果证据，返回首页等善后动作不能代替业务结果。已检测到的固定输入不要重复询问。

只返回 JSON：{"summary":"确认后的技能理解","plan":{"goal":"技能目标","triggers":["何时使用"],"preconditions":["前置条件"],"completionCriteria":["最终可观察证据"],"decisionRules":["运行时选择规则"],"businessSteps":[{"id":"稳定节点ID","title":"业务节点名称","purpose":"节点目的","domStepIndexes":[1,2],"dependsOn":[],"when":"何时需要","kind":"state-check|navigation|input|collection|detail|result|other","verification":"dom|vision|dom-and-vision|page-state","completionCriteria":["节点完成证据"]}],"branches":[{"id":"分支ID","when":"何时选择","purpose":"分支目的","stepIndexes":[1,2],"targetStepIndex":2,"terminal":false}],"fixedFacts":{"事实名":"事实内容"}},"stepAnnotations":[{"stepIndex":1,"title":"与该 DOM 动作一致的名称","purpose":"动作目的","when":"何时执行","expected":"动作后的可观察证据","locator":{"text":"真实文字","role":"真实角色","tag":"真实标签"}}],"inputDefaults":{"字段key":"说明中明确给出的固定值"},"subSkills":[{"name":"可复用子技能名称","description":"子技能职责","stepIndexes":[1,2]}],"mismatches":["无法自行解决的不一致"],"questions":["必须由用户确认的问题"],"ready":true或false}。不要返回 plan.steps、stepTitles、stepSemantics 等位置数组。`;
        const gestureGuidance = `${prompt}\n先按时间顺序还原用户真正做过的手势，再把每个手势关联到对应的 DOM 目标、实际控件和页面反馈。录制轨迹是事实来源，模型只负责命名、解释和抽象，不得凭空增加动作，也不得因为同一手势产生多个 DOM 事件而拆成多步。简单技能优先保留最短可执行路径；只有说明、DOM、截图和页面反馈确实互相矛盾时，才提出具体问题等待用户确认。`;
        return requestObject<LearningAnalysis>(gestureGuidance, '你是网页操作技能构建智能体。以真实 DOM 和页面截图为证据，把录制示例抽象为可复用工作流；能从证据解决的问题自行解决，不能解决的关键歧义才询问用户。');
      };
      const pauseForUser = (questions: string[], mismatches: string[] = []): void => {
        const question = (questions[0]
          ?? (mismatches[0] ? `录制步骤与说明存在不一致：${mismatches[0]}。请说明应以哪一项为准。` : '录制步骤与技能说明还没有完全对应，请补充这个技能的预期结果和关键操作。')).trim();
        const mismatch = (mismatches[0] ?? '').trim();
        this.savePendingLearningIssue(skillId, question, mismatch);
        this.addLearningMessage(skillId, 'agent', question);
        this.db.prepare(`UPDATE operation_skills SET ${preserveActive ? "status = 'active'," : ''} learning_phase = 'awaiting-user', updated_at = ? WHERE id = ?`).run(nowIso(), skillId);
        this.dispatch({ type: 'operation.learning', platformId: skill.platformId, skillId, status: 'awaiting-user' });
      };

      const unresolvedClarifications = (questions: string[], mismatches: string[]): { questions: string[]; mismatches: string[]; resolvedCount: number } => {
        const candidates = questions.length > 0
          ? questions.map((question, index) => ({ question, mismatch: mismatches[index] ?? (mismatches.length === 1 ? mismatches[0]! : '') }))
          : mismatches.map((mismatch) => ({ question: `录制步骤与说明存在不一致：${mismatch}。请说明应以哪一项为准。`, mismatch }));
        const unresolved = candidates.filter((item) => !isLearningClarificationResolved(item.question, item.mismatch, learningResolutions));
        return {
          questions: unresolved.map((item) => item.question),
          mismatches: unresolved.map((item) => item.mismatch).filter(Boolean),
          resolvedCount: candidates.length - unresolved.length,
        };
      };

      let analysis: LearningAnalysis;
      if (!gateway || !platform.modelProfileId) {
        pauseForUser(['我暂时无法理解这段录制所代表的业务流程。请确认操作智能体已经绑定可用模型，然后告诉我这个技能应按什么业务顺序完成。']);
        return;
      } else {
        try {
          analysis = await requestAnalysis();
          if (!analysis || typeof analysis !== 'object') throw new Error('模型没有返回有效的技能理解结果');
        } catch (error) {
          getLogger(this.studioRoot)?.warn({ err: error, platformId: skill.platformId, skillId }, '技能学习模型理解失败，等待补充业务说明');
          pauseForUser(['我还没有确认这段录制对应的业务流程，因此不会把全部录制动作直接做成技能。请按实际业务顺序说明关键步骤和最终完成标志，我会据此重新学习。']);
          return;
        }
      }
      let workflow: OperationWorkflow | null = null;
      let semanticSummary = '';
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const modelDefaults = normalizeInputDefaults(analysis.inputDefaults, inputFields);
        const factDefaults = normalizeInputDefaults(analysis.plan && typeof analysis.plan === 'object' ? analysis.plan.fixedFacts : undefined, inputFields);
        // Explicit values written by the user are authoritative. Model output
        // may normalize field names but must never rewrite remembered inputs.
        const fixedDefaults = { ...modelDefaults, ...factDefaults, ...extractedDefaults };
        const questions = (Array.isArray(analysis.questions) ? analysis.questions : [])
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .filter((question) => !questionCoveredByDefaults(question, inputFields, fixedDefaults)).slice(0, 3);
        const mismatches = (Array.isArray(analysis.mismatches) ? analysis.mismatches : [])
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 3);
        if (analysis.ready === false || questions.length > 0 || mismatches.length > 0) {
          const unresolved = unresolvedClarifications(questions, mismatches);
          if (unresolved.questions.length > 0 || unresolved.mismatches.length > 0 || unresolved.resolvedCount === 0) {
            pauseForUser(unresolved.questions, unresolved.mismatches);
            return;
          }
          const hasBusinessPlan = Array.isArray(analysis.plan?.businessSteps) && analysis.plan.businessSteps.length > 0;
          if (!hasBusinessPlan) {
            analysis = await requestAnalysis(['此前提出的冲突已经由用户明确裁决。必须应用该裁决生成完整业务工作流，不得再次提问同一事项。']);
            continue;
          }
          analysis = { ...analysis, ready: true, questions: [], mismatches: [] };
        }

        workflow = buildWorkflowFromTrace({
          skillId, platformId: skill.platformId, ownerAgentId: skill.ownerAgentId, name: skill.name, description: skill.description,
          events, visionEnabled,
          inputDefaults: fixedDefaults,
          ...(analysis.plan && typeof analysis.plan === 'object' ? { plan: analysis.plan } : {}),
          ...(Array.isArray(analysis.stepAnnotations) ? { stepAnnotations: analysis.stepAnnotations } : {}),
          ...(Array.isArray(analysis.stepTitles) ? { stepTitles: analysis.stepTitles } : {}),
          ...(Array.isArray(analysis.stepLocators) ? { stepLocators: analysis.stepLocators } : {}),
          ...(Array.isArray(analysis.stepSemantics) ? { stepSemantics: analysis.stepSemantics } : {}),
        });
        if (workflow.steps.length === 0) throw new Error('没有生成可执行步骤');
        const structural = validateOperationWorkflowStructure(workflow);
        this.dispatch({ type: 'operation.learning', platformId: skill.platformId, skillId, status: 'learning', phase: 'validating', attempt });
        const verifierPrompt = `请作为独立验收者复核这个网页操作技能是否安全、通用、可执行。
技能名称：${skill.name}
用户说明：${skill.description}
已按用户手势归并的 DOM 轨迹：${JSON.stringify(traceDigest)}
此前问答：${JSON.stringify(transcript)}
用户已经确认的裁决（最高优先级，禁止验收者重新打开）：${JSON.stringify(resolvedDecisions)}
生成的工作流：${JSON.stringify(redactWorkflowForDisplay(workflow))}
已有固定输入字段：${JSON.stringify(Object.keys(fixedDefaults))}
本地结构检查：${JSON.stringify(structural)}

验收时必须遵守：
- plan.businessSteps 是唯一执行主流程；workflow.steps 只是录制得到的 DOM 动作证据库。未被业务节点引用的 DOM 动作不执行，未覆盖全部录制动作不是错误。
- 一个 businessStep 可以映射多个 domStepIndexes，也可在状态判断和结果确认时没有 DOM 步骤，仅使用 vision/page-state；这不是结构错误。
- domInteraction 已将 div/button 代理 click、form submit 和路由反馈归为一个用户行为，不得把 propagated 或 feedbackTypes 当作额外动作。
- DOM 动作类型、顺序、字段身份以真实轨迹为准。模型标题只能解释动作，不能把用户名填写改成密码填写，也不能把密码填写改成点击登录。
- 对动态列表记录，录制时的条目文字只是示例。对应业务节点必须引用真实点击动作，并由 branch.targetStepIndex 标记运行时需要重绑定的动作；不得把示例条目、固定行号或示例详情 URL 当作完成条件。
- 如果用户所需字段不在列表可见列中，工作流必须进入动态匹配的详情页；如果列表字段已经足够，则不得进入录制示例详情。
- 重点检查业务节点、分支、固定输入、示例泛化和可观察完成证据。能依据现有证据修复的问题不要询问用户；只有必须由用户补充业务事实时 needsUserInput 才为 true。
- 用户已经确认的裁决属于验收前提，不是待讨论意见。验收者必须按 sourcePriority 解释录制证据，不得就同一冲突再次向用户提问。

只返回 JSON：{"valid":true或false,"needsUserInput":true或false,"summary":"验收结论","issues":["问题"],"repairInstructions":["如何修正"],"questions":["仅限用户必须回答的问题"],"correctedAnalysis":{"summary":"修正后的理解","plan":{"businessSteps":[]},"stepAnnotations":[],"inputDefaults":{},"subSkills":[],"ready":true,"questions":[],"mismatches":[]}}。不要返回 plan.steps 或位置数组 stepTitles/stepSemantics。`;
        let review: WorkflowSemanticReview;
        try {
          review = await requestObject<WorkflowSemanticReview>(verifierPrompt, '你是独立的网页技能验收智能体。逐项比对说明、DOM、截图和生成工作流；不得把结构完整误判成语义正确，也不得把能从证据解决的问题推回给用户。');
        } catch (error) {
          getLogger(this.studioRoot)?.warn({ err: error, platformId: skill.platformId, skillId, attempt }, '技能语义验收不可用，使用已生成的业务映射');
          review = structural.valid
            ? { valid: true, needsUserInput: false, summary: '业务节点、必要 DOM 映射和完成条件已经建立。' }
            : { valid: false, needsUserInput: false, summary: '业务工作流结构仍不完整。', issues: structural.issues };
        }
        const reviewQuestions = (Array.isArray(review?.questions) ? review.questions : []).filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 3);
        const reviewIssues = (Array.isArray(review?.issues) ? review.issues : []).filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
        const repairInstructions = (Array.isArray(review?.repairInstructions) ? review.repairInstructions : []).filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
        if (review?.valid === true && structural.valid) {
          semanticSummary = review.summary?.trim() || '业务阶段、分支、定位信息和完成条件均已通过语义校验。';
          workflow = {
            ...workflow,
            validation: {
              status: 'passed', checkedAt: nowIso(), attempts: attempt, summary: semanticSummary,
              evidence: [...structural.evidence, semanticSummary],
            },
          };
          break;
        }
        if (review?.needsUserInput === true || reviewQuestions.length > 0) {
          const unresolved = unresolvedClarifications(reviewQuestions, reviewIssues);
          if (unresolved.questions.length > 0 || unresolved.mismatches.length > 0 || unresolved.resolvedCount === 0) {
            pauseForUser(unresolved.questions, unresolved.mismatches);
            return;
          }
        }
        const feedback = [
          ...structural.issues,
          ...reviewIssues,
          ...repairInstructions,
          ...(resolvedDecisions.length > 0 ? ['必须应用用户已经确认的裁决，不得重新打开同一冲突。'] : []),
        ];
        if (attempt === 3) {
          if (structural.valid) {
            semanticSummary = '已依据技能说明建立业务主流程，并只映射执行所需的 DOM 动作。';
            getLogger(this.studioRoot)?.warn({ platformId: skill.platformId, skillId, feedback }, '技能复核意见未完全一致，保留结构完整的业务工作流');
            break;
          }
          pauseForUser(['我还不能确定业务步骤与录制动作的对应关系。请按实际执行顺序说明关键步骤、可能的分支以及怎样算完成，我确认后再生成技能。'], feedback);
          return;
        }
        const corrected = review?.correctedAnalysis;
        if (corrected && typeof corrected === 'object') {
          analysis = {
            ...analysis,
            ...corrected,
            ...(corrected.plan && typeof corrected.plan === 'object' ? { plan: corrected.plan } : {}),
            ready: true,
            questions: [],
            mismatches: [],
          };
        } else {
          analysis = await requestAnalysis(feedback.length > 0 ? feedback : ['请重新核对工作流阶段、分支和可观察完成条件。']);
        }
      }
      if (!workflow?.validation) {
        const structural = workflow ? validateOperationWorkflowStructure(workflow) : { valid: false, issues: [], evidence: [] };
        if (workflow && structural.valid) {
          semanticSummary = semanticSummary || '业务工作流结构完整，未映射的录制事件仅作为学习证据保存。';
          workflow = {
            ...workflow,
            validation: {
              status: 'passed', checkedAt: nowIso(), attempts: 3, summary: semanticSummary,
              evidence: [...structural.evidence, semanticSummary],
            },
          };
        } else {
          pauseForUser(['当前信息还不足以生成可靠的业务工作流。请补充关键业务步骤、分支条件和最终完成标志。'], structural.issues);
          return;
        }
      }
      const updatedAt = nowIso();
      if (preserveActive) {
        this.db.prepare("UPDATE operation_skills SET status = 'active', learning_phase = 'ready', pending_workflow_json = ?, pending_summary = ?, learning_error = NULL, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(workflow), analysis.summary?.trim() || null, updatedAt, skillId);
        this.addLearningMessage(skillId, 'agent', `${analysis.summary?.trim() || '操作顺序和完成条件已经确认。'} ${semanticSummary} 已生成新的工作流预览；当前仍使用旧版本，点击“生效技能”后才会替换。`);
      } else {
        await this.writeSkillPackage(skill, workflow, analysis.summary);
        this.db.prepare("UPDATE operation_skills SET status = 'draft', learning_phase = 'ready', workflow_json = ?, pending_workflow_json = NULL, pending_summary = NULL, learning_error = NULL, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(workflow), updatedAt, skillId);
        this.addLearningMessage(skillId, 'agent', `${analysis.summary?.trim() || '操作顺序和完成条件已经确认。'} ${semanticSummary} 现在可以生效这个技能。`);
        const decomposedCount = await this.createDecomposedSkillDrafts(skill, workflow, analysis.subSkills ?? []);
        if (decomposedCount > 0) this.addLearningMessage(skillId, 'agent', `我识别出 ${decomposedCount} 个可以独立复用的子流程，已经生成技能草稿；它们不会自动替换当前技能，确认后可分别生效。`);
      }
      this.dispatch({ type: 'operation.learning', platformId: skill.platformId, skillId, status: 'ready' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.prepare(`UPDATE operation_skills SET status = '${preserveActive ? 'active' : 'failed'}', learning_phase = 'failed', learning_error = ?, updated_at = ? WHERE id = ?`).run(message, nowIso(), skillId);
      this.addLearningMessage(skillId, 'agent', `技能学习失败：${message}`);
      this.dispatch({ type: 'operation.learning', platformId: skill.platformId, skillId, status: 'failed', error: message });
    }
  }

  private async writeSkillPackage(skill: SkillRow, workflow: OperationWorkflow, summary?: string): Promise<void> {
    const definitionRoot = join(this.studioRoot, 'agent-definitions', 'custom', skill.ownerAgentId, '1.0.0');
    const packageRoot = join(definitionRoot, 'skills', skill.id);
    await mkdir(join(packageRoot, 'recording'), { recursive: true });
    await mkdir(join(packageRoot, 'screenshots'), { recursive: true });
    await mkdir(join(packageRoot, 'validation'), { recursive: true });
    const recording = this.db.prepare(
      'SELECT trace_rel_path as traceRelPath, recording_rel_path as recordingRelPath FROM operation_recording_sessions WHERE id = ?',
    ).get(skill.recordingSessionId) as { traceRelPath: string; recordingRelPath: string | null };
    await copyFile(join(this.studioRoot, recording.traceRelPath), join(packageRoot, 'trace.jsonl'));
    if (recording.recordingRelPath) await copyFile(join(this.studioRoot, recording.recordingRelPath), join(packageRoot, 'recording', 'operation.webm'));
    const screenshots = [...new Set((await this.readTrace(skill.recordingSessionId!)).map((event) => event.screenshotRelPath).filter((item): item is string => !!item))];
    for (const screenshot of screenshots) {
      await copyFile(join(this.studioRoot, screenshot), join(packageRoot, 'screenshots', screenshot.split('/').at(-1)!)).catch(() => undefined);
    }
    const plan = workflow.plan;
    const planMarkdown = plan ? `\n## 执行计划\n\n- 目标：${plan.goal || '按技能说明完成目标'}\n- 触发条件：${(plan.triggers ?? []).join('；') || '由操作智能体根据用户意图判断'}\n- 前置条件：${(plan.preconditions ?? []).join('；') || '当前页面和平台状态满足要求'}\n- 完成判断：${(plan.completionCriteria ?? []).join('；') || '页面结果与技能目标一致'}\n- 选择规则：${(plan.decisionRules ?? []).join('；') || '只执行本次任务需要的最小步骤'}\n${plan.businessSteps?.length ? `\n### 业务工作流\n\n${plan.businessSteps.map((step, index) => `- ${index + 1}. ${step.title || step.id || '业务节点'}${step.purpose ? `：${step.purpose}` : ''}${step.domStepIndexes?.length ? `（关联 DOM 步骤 ${step.domStepIndexes.join('、')}）` : `（${step.verification === 'vision' ? '视觉校验' : '页面状态校验'}，无独立 DOM 动作）`}`).join('\n')}\n` : ''}${plan.branches?.length ? `\n### 分支判断\n\n${plan.branches.map((branch, index) => `- ${index + 1}. ${branch.when || branch.id || '分支'}${branch.purpose ? `：${branch.purpose}` : ''}${branch.stepIndexes?.length ? `（DOM 步骤 ${branch.stepIndexes.join('、')}）` : ''}`).join('\n')}\n` : ''}` : '';
    const stepMarkdown = workflow.steps.map((step, index) => `- ${index + 1}. ${step.title}${step.purpose ? `：${step.purpose}` : ''}${step.when ? `（${step.when}）` : ''}${step.expected ? ` -> ${step.expected}` : ''}${step.domInteraction ? `\n  - DOM 证据（同一用户行为）：${domInteractionSummary(step.domInteraction)}` : ''}`).join('\n');
    const markdown = `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n# ${skill.name}\n\n${summary?.trim() || skill.description}\n${planMarkdown}\n## DOM 动作证据库\n\n${stepMarkdown || '暂无 DOM 动作证据'}\n\n## 使用规则\n\n- 仅允许所属操作智能体在绑定平台内调用。\n- plan.businessSteps 是唯一执行主流程；只有业务节点通过 domStepIndexes 引用的 DOM 动作才会执行，其他录制事件仅作为学习证据。\n- 技能说明中明确给出的固定输入已经保存在 workflow.json 的默认值中，执行时自动使用；只有变化输入才向用户获取。\n- 平台或技能注销后不得继续调用。\n`;
    const manifest = {
      schemaVersion: 1, id: skill.id, version: skill.version, entry: 'SKILL.md', executionMode: 'hybrid',
      agentDefinitions: [skill.ownerAgentId], requiredTools: ['operation:execute_skill'], permissions: ['browser:operate'],
      inputSchema: workflow.inputSchema, outputSchema: { type: 'object', properties: { finalUrl: { type: 'string' }, summary: { type: 'string' } } },
      timeoutMs: Math.max(60_000, workflow.steps.length * 30_000),
      compatibility: { codexSkill: true, kunqing: '>=0.1.0', workflow: 'workflow.json' },
      browserAutomation: { platformId: skill.platformId, ownerAgentId: skill.ownerAgentId, allowedDomains: workflow.allowedDomains, visionFallback: workflow.fallback.visionEnabled },
    };
    const structuralValidation = validateOperationWorkflowStructure(workflow);
    await Promise.all([
      writeFile(join(packageRoot, 'SKILL.md'), markdown, 'utf8'),
      writeFile(join(packageRoot, 'kunqing.json'), JSON.stringify(manifest, null, 2), 'utf8'),
      writeFile(join(packageRoot, 'workflow.json'), JSON.stringify(workflow, null, 2), 'utf8'),
      writeFile(join(packageRoot, 'validation', 'structural.json'), JSON.stringify({ ...structuralValidation, checkedAt: nowIso(), stepCount: workflow.steps.length }, null, 2), 'utf8'),
      writeFile(join(packageRoot, 'validation', 'semantic.json'), JSON.stringify(workflow.validation ?? { status: 'missing', checkedAt: nowIso() }, null, 2), 'utf8'),
    ]);
    this.db.prepare('UPDATE operation_skills SET package_rel_path = ?, updated_at = ? WHERE id = ?')
      .run(normalizeRelPath(relative(this.studioRoot, packageRoot)), nowIso(), skill.id);
  }

  private async createDecomposedSkillDrafts(parent: SkillRow, workflow: OperationWorkflow, candidates: Array<{ name: string; description: string; stepIndexes: number[] }>): Promise<number> {
    if (!candidates.length || !parent.recordingSessionId) return 0;
    const recording = this.db.prepare(
      'SELECT trace_rel_path as traceRelPath, recording_rel_path as recordingRelPath, event_count as eventCount, started_at as startedAt, stopped_at as stoppedAt, updated_at as updatedAt FROM operation_recording_sessions WHERE id = ?',
    ).get(parent.recordingSessionId) as { traceRelPath: string; recordingRelPath: string | null; eventCount: number; startedAt: string; stoppedAt: string | null; updatedAt: string } | undefined;
    if (!recording) return 0;
    let created = 0;
    const existingNames = new Set((this.listSkills(parent.platformId, true)).map((item) => String(item.name).trim().toLowerCase()));
    for (const candidate of candidates.slice(0, 6)) {
      const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
      const description = typeof candidate.description === 'string' ? candidate.description.trim() : '';
      const indexes = Array.from(new Set((candidate.stepIndexes ?? []).filter((index) => Number.isInteger(index) && index >= 1 && index <= workflow.steps.length))).sort((a, b) => a - b);
      if (!name || !description || indexes.length < 1 || existingNames.has(name.toLowerCase())) continue;
      const selected = indexes.map((index) => workflow.steps[index - 1]).filter((step): step is OperationWorkflowStep => !!step);
      if (!selected.length) continue;
      const firstNavigate = workflow.steps.slice(0, indexes[0]! - 1).reverse().find((step) => step.action === 'navigate');
      const steps = [...(firstNavigate && selected[0]?.action !== 'navigate' ? [firstNavigate] : []), ...selected].map((step, index) => ({ ...step, id: `step-${String(index + 1).padStart(3, '0')}` }));
      const lastStepUrl = steps.at(-1)?.url;
      const skillId = `operation-${createHash('sha1').update(`${parent.id}:${name}:${randomUUID()}`).digest('hex').slice(0, 20)}`;
      const recordingId = randomUUID();
      const now = nowIso();
      this.db.prepare(
        `INSERT INTO operation_recording_sessions (id, platform_id, status, trace_rel_path, recording_rel_path, event_count, started_at, stopped_at, updated_at)
         VALUES (?, ?, 'saved', ?, ?, ?, ?, ?, ?)`,
      ).run(recordingId, parent.platformId, recording.traceRelPath, recording.recordingRelPath, recording.eventCount, recording.startedAt, recording.stoppedAt, recording.updatedAt);
      const subWorkflow: OperationWorkflow = {
        ...workflow,
        id: skillId,
        name,
        description,
        steps,
        success: {
          ...workflow.success,
          ...(lastStepUrl ? { finalUrl: lastStepUrl } : {}),
        },
        createdAt: now,
      };
      this.db.prepare(
        `INSERT INTO operation_skills (id, platform_id, owner_agent_id, recording_session_id, name, description, version, status, workflow_json, model_profile_id, learning_phase, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, 'ready', ?, ?)`,
      ).run(skillId, parent.platformId, parent.ownerAgentId, recordingId, name, description, parent.version, JSON.stringify(subWorkflow), parent.modelProfileId, now, now);
      const subSkill = this.getSkill(skillId);
      await this.writeSkillPackage(subSkill, subWorkflow, `由“${parent.name}”拆解出的可复用子技能：${description}`);
      this.addLearningMessage(skillId, 'system', `这是从“${parent.name}”中拆解出的独立技能草稿，确认后可单独生效。`);
      this.dispatch({ type: 'operation.skill', platformId: parent.platformId, skillId, status: 'draft', decomposedFrom: parent.id });
      existingNames.add(name.toLowerCase());
      created += 1;
    }
    return created;
  }

  async activateSkill(skillId: string): Promise<{ activated: true; workflow: OperationWorkflow }> {
    const skill = this.getSkill(skillId);
    const platform = this.getPlatform(skill.platformId);
    if (platform.ownerAgentId !== skill.ownerAgentId) throw new Error('技能所有权校验失败');
    if (skill.status === 'active' && skill.pendingWorkflowJson) {
      const pendingWorkflow = safeJson<OperationWorkflow | null>(skill.pendingWorkflowJson, null);
      if (!pendingWorkflow) throw new Error('待生效技能工作流损坏');
      if (isLegacyRecordingFallback(pendingWorkflow) && skill.recordingSessionId) {
        this.db.prepare("UPDATE operation_skills SET pending_workflow_json = NULL, pending_summary = NULL, learning_phase = 'processing', updated_at = ? WHERE id = ?").run(nowIso(), skillId);
        this.addLearningMessage(skillId, 'agent', '这份预览来自旧版完整录制回退逻辑，我会重新按业务节点和必要 DOM 映射学习，不会直接生效旧流程。');
        await this.processLearning(skillId);
        const refreshed = this.getSkill(skillId);
        if (!refreshed.pendingWorkflowJson) throw new Error('业务工作流仍有需要确认的内容，请先回答智能体的问题再生效');
        return this.activateSkill(skillId);
      }
      if (pendingWorkflow.validation?.status !== 'passed') throw new Error('待生效工作流尚未通过语义校验');
      await this.writeSkillPackage(skill, pendingWorkflow, skill.pendingSummary ?? undefined);
      await new SkillRegistry(this.db, this.studioRoot).syncFromWorkspace();
      const now = nowIso();
      this.db.prepare("UPDATE operation_skills SET workflow_json = ?, pending_workflow_json = NULL, pending_summary = NULL, learning_phase = 'ready', learning_error = NULL, enabled = 1, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(pendingWorkflow), now, skillId);
      this.db.prepare('UPDATE skill_packages SET enabled = 1, updated_at = ? WHERE id = ? AND version = ?').run(now, skillId, skill.version);
      this.dispatch({ type: 'operation.skill', platformId: skill.platformId, skillId, status: 'active', revisionActivated: true });
      return { activated: true, workflow: pendingWorkflow };
    }
    if (skill.status !== 'draft' || !skill.packageRelPath || !skill.workflowJson) throw new Error('技能尚未完成学习');
    const workflow = safeJson<OperationWorkflow | null>(skill.workflowJson, null);
    if (!workflow) throw new Error('技能工作流损坏');
    if (isLegacyRecordingFallback(workflow) && skill.recordingSessionId) {
      this.db.prepare("UPDATE operation_skills SET learning_phase = 'processing', updated_at = ? WHERE id = ?").run(nowIso(), skillId);
      this.addLearningMessage(skillId, 'agent', '这份草稿来自旧版完整录制回退逻辑，我会重新按业务节点和必要 DOM 映射学习，不会直接生效旧流程。');
      await this.processLearning(skillId);
      const refreshed = this.getSkill(skillId);
      const refreshedWorkflow = safeJson<OperationWorkflow | null>(refreshed.workflowJson, null);
      if (!refreshedWorkflow || isLegacyRecordingFallback(refreshedWorkflow)) throw new Error('业务工作流仍有需要确认的内容，请先回答智能体的问题再生效');
      return this.activateSkill(skillId);
    }
    if (workflow.validation?.status !== 'passed') throw new Error('技能工作流尚未通过语义校验');
    await new SkillRegistry(this.db, this.studioRoot).syncFromWorkspace();
    const now = nowIso();
    this.db.prepare("UPDATE operation_skills SET status = 'active', enabled = 1, activated_at = ?, updated_at = ? WHERE id = ?").run(now, now, skillId);
    this.db.prepare('UPDATE skill_packages SET enabled = 1, updated_at = ? WHERE id = ? AND version = ?').run(now, skillId, skill.version);
    this.dispatch({ type: 'operation.skill', platformId: skill.platformId, skillId, status: 'active' });
    return { activated: true, workflow };
  }

  setSkillEnabled(skillId: string, enabled: boolean): void {
    const skill = this.getSkill(skillId);
    if (skill.status !== 'active') throw new Error('只有已生效技能可以切换启用状态');
    const value = enabled ? 1 : 0;
    const now = nowIso();
    this.db.prepare('UPDATE operation_skills SET enabled = ?, updated_at = ? WHERE id = ?').run(value, now, skillId);
    this.db.prepare('UPDATE skill_packages SET enabled = ?, updated_at = ? WHERE id = ? AND version = ?').run(value, now, skillId, skill.version);
    this.dispatch({ type: 'operation.skill', platformId: skill.platformId, skillId, status: 'active', enabled });
  }

  async deleteSkill(skillId: string): Promise<void> {
    const skill = this.getSkill(skillId);
    const packagePath = skill.packageRelPath ? join(this.studioRoot, skill.packageRelPath) : null;
    const recording = skill.recordingSessionId
      ? this.db.prepare('SELECT trace_rel_path as traceRelPath FROM operation_recording_sessions WHERE id = ?').get(skill.recordingSessionId) as { traceRelPath?: string } | undefined
      : undefined;
    this.db.transaction(() => {
      // Keep the operation chat transcript, but detach messages from run rows
      // before deleting those rows; related_run_id is a real FK.
      this.db.prepare('UPDATE operation_conversation_messages SET related_run_id = NULL WHERE related_run_id IN (SELECT id FROM operation_skill_runs WHERE skill_id = ?)').run(skillId);
      this.db.prepare('DELETE FROM operation_skill_run_events WHERE run_id IN (SELECT id FROM operation_skill_runs WHERE skill_id = ?)').run(skillId);
      this.db.prepare('DELETE FROM operation_skill_runs WHERE skill_id = ?').run(skillId);
      this.db.prepare('DELETE FROM operation_learning_messages WHERE skill_id = ?').run(skillId);
      // skill_packages 使用复合主键；SkillRegistry 会为操作技能建立定义绑定，
      // 必须先解除绑定，否则 SQLite 会因外键约束拒绝删除 package。
      this.db.prepare('DELETE FROM agent_definition_skills WHERE skill_id = ?').run(skillId);
      this.db.prepare('DELETE FROM skill_packages WHERE id = ?').run(skillId);
      this.db.prepare('DELETE FROM operation_skills WHERE id = ?').run(skillId);
      if (skill.recordingSessionId) this.db.prepare('DELETE FROM operation_recording_sessions WHERE id = ?').run(skill.recordingSessionId);
    })();
    if (packagePath) await rm(packagePath, { recursive: true, force: true }).catch(() => undefined);
    if (recording?.traceRelPath) {
      const references = this.db.prepare('SELECT COUNT(*) as count FROM operation_recording_sessions WHERE trace_rel_path = ?').get(recording.traceRelPath) as { count: number };
      if (references.count === 0) await rm(join(this.studioRoot, dirname(recording.traceRelPath)), { recursive: true, force: true }).catch(() => undefined);
    }
    this.dispatch({ type: 'operation.skill', platformId: skill.platformId, skillId, status: 'deleted' });
  }

  abandonSkill(skillId: string): void {
    const skill = this.getSkill(skillId);
    if (skill.status === 'active' || skill.status === 'revoked') throw new Error('已生效或已注销技能不能作为草稿放弃');
    this.db.prepare("UPDATE operation_skills SET status = 'abandoned', updated_at = ? WHERE id = ?").run(nowIso(), skillId);
    if (skill.recordingSessionId) this.db.prepare("UPDATE operation_recording_sessions SET status = 'abandoned', updated_at = ? WHERE id = ?").run(nowIso(), skill.recordingSessionId);
    this.dispatch({ type: 'operation.skill', platformId: skill.platformId, skillId, status: 'abandoned' });
  }

  listSkills(platformId: string, includeRevoked = false, includeDefaults = false): Array<Record<string, unknown>> {
    const rows = this.db.prepare(
      `SELECT id, platform_id as platformId, owner_agent_id as ownerAgentId, name, description, version, status, enabled,
              workflow_json as workflowJson, pending_workflow_json as pendingWorkflowJson, pending_summary as pendingSummary,
              learning_error as learningError, learning_phase as learningPhase, created_at as createdAt,
              updated_at as updatedAt, activated_at as activatedAt, revoked_at as revokedAt
       FROM operation_skills WHERE platform_id = ? ${includeRevoked ? '' : "AND status != 'revoked'"} ORDER BY updated_at DESC`,
    ).all(platformId) as Array<Record<string, unknown> & {
      id: string;
      workflowJson: string | null;
      pendingWorkflowJson: string | null;
      pendingSummary: string | null;
    }>;
    return rows.map((row) => {
      const workflow = hydrateWorkflowPlan(safeJson<OperationWorkflow | null>(row.workflowJson, null));
      const pendingWorkflow = hydrateWorkflowPlan(safeJson<OperationWorkflow | null>(row.pendingWorkflowJson, null));
      return {
        ...row,
        workflow: includeDefaults ? workflow : redactWorkflowForDisplay(workflow),
        pendingWorkflow: includeDefaults ? pendingWorkflow : redactWorkflowForDisplay(pendingWorkflow),
        messages: this.listLearningMessages(row.id),
      };
    });
  }

  getLearningStatus(skillId: string): Record<string, unknown> {
    const skill = this.getSkill(skillId);
    return { ...skill, workflow: redactWorkflowForDisplay(hydrateWorkflowPlan(safeJson(skill.workflowJson, null))), pendingWorkflow: redactWorkflowForDisplay(hydrateWorkflowPlan(safeJson(skill.pendingWorkflowJson, null))), messages: this.listLearningMessages(skillId) };
  }

  async getSkillRecording(skillId: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    const skill = this.getSkill(skillId);
    if (!skill.recordingSessionId) return null;
    const row = this.db.prepare('SELECT recording_rel_path as recordingRelPath FROM operation_recording_sessions WHERE id = ?').get(skill.recordingSessionId) as { recordingRelPath?: string | null } | undefined;
    if (!row?.recordingRelPath) return null;
    try { return { bytes: new Uint8Array(await readFile(join(this.studioRoot, row.recordingRelPath))), mimeType: 'video/webm' }; } catch { return null; }
  }

  private listLearningMessages(skillId: string): Array<{ id: string; role: string; content: string; createdAt: string }> {
    return this.db.prepare(
      'SELECT id, role, content, created_at as createdAt FROM operation_learning_messages WHERE skill_id = ? ORDER BY created_at, id',
    ).all(skillId) as Array<{ id: string; role: string; content: string; createdAt: string }>;
  }

  private getSkill(skillId: string): SkillRow {
    const row = this.db.prepare(
      `SELECT id, platform_id as platformId, owner_agent_id as ownerAgentId, recording_session_id as recordingSessionId,
               name, description, version, status, enabled, package_rel_path as packageRelPath, workflow_json as workflowJson,
              pending_workflow_json as pendingWorkflowJson, pending_summary as pendingSummary,
              model_profile_id as modelProfileId, learning_error as learningError, learning_phase as learningPhase, created_at as createdAt,
              updated_at as updatedAt, activated_at as activatedAt, revoked_at as revokedAt
       FROM operation_skills WHERE id = ?`,
    ).get(skillId) as SkillRow | undefined;
    if (!row) throw new Error('操作技能不存在');
    return row;
  }

  async executeSkill(input: { skillId: string; ownerAgentId: string; parameters?: Record<string, unknown>; businessStepIds?: string[]; stepIndexes?: number[]; instruction?: string; loopContext?: OperationLoopContext }): Promise<{ runId: string }> {
    const skill = this.getSkill(input.skillId);
    if (skill.status !== 'active' || skill.enabled !== 1 || !skill.workflowJson) throw new Error('操作技能未启用或已注销');
    if (skill.ownerAgentId !== input.ownerAgentId) throw new Error('该技能不属于当前操作智能体');
    const platform = this.getPlatform(skill.platformId);
    if (platform.ownerAgentId !== input.ownerAgentId) throw new Error('操作平台与智能体所有权不匹配');
    const workflow = hydrateWorkflowPlan(safeJson<OperationWorkflow | null>(skill.workflowJson, null));
    if (!workflow) throw new Error('技能工作流损坏');
    const instruction = input.instruction ?? input.loopContext?.instruction ?? '';
    const executionWorkflow = buildBusinessExecutionWorkflow(workflow, input.businessStepIds, input.stepIndexes, instruction);
    if (executionWorkflow.steps.length === 0) throw new Error('没有找到与本次要求匹配的业务节点，未执行任何录制动作');
    const parameters = mergeWorkflowDefaults(workflow, input.parameters);
    const runId = randomUUID();
    const now = nowIso();
    const persistedInput = Object.fromEntries(Object.entries(parameters).map(([key, value]) => [
      key,
      workflow.inputSchema.properties[key]?.sensitive ? '[REDACTED]' : value,
    ]));
    this.db.prepare(
      `INSERT INTO operation_skill_runs (id, skill_id, platform_id, owner_agent_id, status, input_json, browser_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    ).run(runId, skill.id, skill.platformId, skill.ownerAgentId, JSON.stringify(persistedInput), `platform:${skill.platformId}`, now, now);
    this.emitRunEvent(runId, 'run.queued', null, { skillId: skill.id, skillName: skill.name });
    if (input.loopContext) {
      this.runContexts.set(runId, {
        ...input.loopContext,
        rootRunId: input.loopContext.rootRunId ?? runId,
      });
    }
    const execution = this.runWorkflow(runId, executionWorkflow, parameters);
    this.runPromises.set(runId, execution);
    void execution.finally(() => {
      this.runPromises.delete(runId);
      this.runContexts.delete(runId);
    });
    return { runId };
  }

  async runInstruction(input: { platformId: string; instruction: string; projectId?: string }): Promise<{ runId?: string; message: string; intent: OperationAgentDecision['intent'] }> {
    const platform = this.getPlatform(input.platformId);
    const instruction = input.instruction.trim();
    if (!instruction) throw new Error('请输入操作要求');
    this.addConversationMessage(input.platformId, 'user', instruction, null, { kind: 'instruction' });
    const skills = this.listSkills(input.platformId, false, true).filter((skill) => skill.status === 'active' && skill.enabled !== 0);
    const gateway = this.getGateway();
    const respond = (message: string, intent: OperationAgentDecision['intent'], relatedRunId: string | null = null, metadata: Record<string, unknown> = {}) => {
      this.addConversationMessage(input.platformId, 'agent', message, relatedRunId, { kind: 'decision', intent, ...metadata });
      void this.appendPrivateMemory(platform, input.projectId, input.instruction, message).catch((error) => getLogger(this.studioRoot)?.warn({ err: error, platformId: input.platformId }, '操作智能体记忆写入失败'));
      return relatedRunId ? { runId: relatedRunId, message, intent } : { message, intent };
    };
    if (!gateway || !platform.modelProfileId) return respond('这个操作智能体还没有绑定可用模型，暂时无法理解和执行你的要求。请先在“智能体管理”中完成模型绑定。', 'clarify');

    const conversation = this.listConversation(input.platformId, 24).filter((item) => item.role !== 'system');
    const currentSession = this.sessions.get(input.platformId);
    const initialSnapshot = currentSession ? await this.readPageSnapshot(currentSession) : { url: platform.url, title: '', text: '', links: [], interactive: [] };
    const privateContext = await this.readPrivateContext(platform, input.projectId);
    let projectKnowledgeContext = '当前操作平台未关联项目，不得读取任何项目知识；企业知识也不会自动注入本次操作。';
    if (input.projectId?.trim()) {
      try {
        projectKnowledgeContext = formatHybridKnowledgeResult(
          searchHybridKnowledge(this.db, instruction, input.projectId.trim(), 3),
        ).slice(0, 2_500);
      } catch {
        projectKnowledgeContext = '当前操作平台已关联项目，但项目与企业知识中暂时没有可用的已知识化证据。';
      }
    }
    const currentUrl = initialSnapshot.url || platform.url;
    const recentRuns = this.listRuns(input.platformId, 6).map((run) => ({
      skillId: run.skillId, skillName: run.skillName, status: run.status, errorMessage: run.errorMessage,
      output: run.output, updatedAt: run.updatedAt,
    }));
    const skillCatalog = skills.map((skill) => {
      const workflow = skill.workflow as OperationWorkflow | null;
      return {
        id: skill.id, name: skill.name, description: skill.description,
        requiredInputs: workflow?.inputSchema?.required ?? [],
        inputProperties: Object.fromEntries(Object.entries(workflow?.inputSchema?.properties ?? {}).map(([key, property]) => [key, { description: property.description, sensitive: property.sensitive, defaultAvailable: workflowHasDefault(workflow, key, property) }])),
        plan: workflow?.plan ?? {},
        steps: (workflow?.steps ?? []).map((step, index) => ({ index: index + 1, title: step.title, purpose: step.purpose, when: step.when, expected: step.expected, action: step.action, locator: step.locator, url: step.url })),
        success: workflow?.success ?? {},
      };
    });
    const system = `你是“${platform.name}”的专属操作智能体。平台用途：${platform.description || '未补充'}。当前页面：${currentUrl}。\n你的职责是先理解用户真正要得到的结果，再决定是否执行技能。每项技能的 plan.businessSteps 是唯一执行主流程；录制 DOM 只是业务节点引用的动作证据，不是完整宏。只在用户明确要求网页操作、意图与某个已生效技能匹配且关键输入齐全时执行。用户只是询问技能、页面、执行历史或普通说明时直接回答。信息不足、技能相近、指代不清或置信度不足时追问。绝不能默认选择第一个技能，不能用名称相似替代精确判断，也不能把录制时点击的示例条目当成固定目标。\n执行规划规则：businessStepIds 只填写本次任务需要走的业务节点 ID；依赖节点会按 dependsOn 自动带入。不要直接规划底层 DOM，也不要选择未被业务节点引用的录制动作。先判断回答用户所需的字段和证据位于集合页还是条目详情：集合页字段足够时只执行到集合结果节点；所需字段不在集合页时选择动态目标和详情节点，并用 targetText 指定本次真实目标，即使用户没有使用“详情”二字也一样。认证/登录任务必须选择完整认证业务链并完成登录结果判断；不能只打开登录页，也不能把登录页正文当作答案。操作完成后由你自己读取页面、整理结论并直接回答，不要把原始页面全文或未分析的 DOM 结果交给统筹。只有当前问题确实超出本平台领域、需要其他智能体补充时，才将 needsCollaboration 设为 true，并填写 collaborationReason/collaborationBrief；这时系统会把完整证据写入当前任务临时目录，供负责人读取。\n项目知识权限：只有平台存在有效项目关联时，才可使用该项目与企业知识辅助理解目标和参数；项目知识不能替代当前网页执行结果，也不得读取其他项目。当前可用项目知识证据：${projectKnowledgeContext}\n只把下面的身份和记忆当作你自己的上下文，不要读取其它智能体的数据：${privateContext}\n当前页面证据：${JSON.stringify({ url: initialSnapshot.url, frameUrls: initialSnapshot.frameUrls ?? [], title: initialSnapshot.title, text: initialSnapshot.text.slice(0, 8000), links: initialSnapshot.links.slice(0, 30) })}\n最近对话上下文：${JSON.stringify(conversation.slice(-12))}\n可用技能：${JSON.stringify(skillCatalog)}\n最近执行：${JSON.stringify(recentRuns)}\n只返回 JSON：{\"intent\":\"execute|clarify|answer\",\"skillId\":\"仅 execute 时填写精确 ID\",\"confidence\":0到1,\"needsCollaboration\":true或false,\"collaborationReason\":\"需要跨领域协作时填写\",\"collaborationBrief\":\"给后续成员的简短工作说明\",\"businessStepIds\":[\"业务节点ID\"],\"targetText\":\"需要动态匹配的条目文本，没有则省略\",\"targetStepIndex\":底层动态目标动作序号，没有则省略,\"parameters\":{},\"reply\":\"给用户的自然、简洁回复\"}。不要输出 Markdown 或解释 JSON 以外的内容。`;
    const systemWithDefaults = `${system}\n技能输入规则：技能包中标记 defaultAvailable=true 的字段，表示技能说明已经明确保存了固定值。执行时引擎会自动填入这些值，不要向用户索要；只有 defaultAvailable=false 且任务确实需要变化的输入才向用户询问。先依据技能 plan、步骤 purpose/when/expected 和当前 DOM/截图选择最小工作流。当前页面的 interactive 元素摘要也属于证据，优先使用语义匹配而不是录制时的固定选择。${JSON.stringify(initialSnapshot.interactive?.slice(0, 300) ?? [])}\n动态记录规则：先判断用户需要的答案依赖哪些页面字段。列表字段足够时停留在集合节点；所需字段只在具体记录中时，即使用户没说“详情”，也要进入动态目标和详情节点。targetText 必须是本次真正目标，录制示例条目、固定行号和示例详情 URL 只能作为交互证据，不能作为本次选择。`;
    let decision: OperationAgentDecision;
    try {
      const plannerImages: Uint8Array[] = [];
      if (currentSession && this.modelSupportsVision(platform.modelProfileId)) {
        try { plannerImages.push((await currentSession.view.webContents.capturePage()).toPNG()); } catch { /* visual context is optional */ }
      }
      const generateDecision = () => plannerImages.length > 0
        ? gateway.generateObjectWithImages<OperationAgentDecision>('reasoning', systemWithDefaults, plannerImages, '你是网页操作任务规划器。先结合当前页面截图和技能说明理解用户目标，再选择最小必要的步骤；不要把录制时的示例条目当成固定目标。')
        : gateway.generateObject<OperationAgentDecision>(
          'reasoning',
          conversation.map((item) => ({ role: item.role === 'agent' ? 'assistant' as const : 'user' as const, content: item.content })),
          systemWithDefaults,
        );
      decision = await gateway.runWithModelProfileSnapshot(
        JSON.stringify({ profileId: platform.modelProfileId, parameters: { temperature: platform.temperature } }),
        generateDecision,
      );
    } catch (error) {
      getLogger(this.studioRoot)?.warn({ err: error, platformId: input.platformId }, '操作智能体意图理解失败');
      return respond(`我暂时没能理解这条要求，未执行任何技能。${error instanceof Error ? ` ${error.message}` : ''}`.trim(), 'clarify');
    }

    // A direct login request should never be downgraded to a page read by a
    // planner that only selected the first navigation step. Preserve a model
    // choice when it already picked an authentication skill; otherwise choose
    // the available credential-based authentication skill as a safe fallback.
    if (isExplicitAuthenticationRequest(instruction)) {
      const authenticationSkills = skills
        .filter((skill) => isAuthenticationWorkflow(skill.workflow as OperationWorkflow | null | undefined))
        .sort((left, right) => {
          const leftWorkflow = left.workflow as OperationWorkflow | null;
          const rightWorkflow = right.workflow as OperationWorkflow | null;
          const countInputs = (workflow: OperationWorkflow | null): number => Object.keys(workflow?.inputSchema.properties ?? {}).filter((key) => /user|账号|用户名|pass|密码|口令|pwd/i.test(key)).length;
          return countInputs(rightWorkflow) - countInputs(leftWorkflow);
        });
      const selectedWorkflow = skills.find((skill) => skill.id === decision.skillId)?.workflow as OperationWorkflow | null;
      if (authenticationSkills.length > 0 && (decision.intent !== 'execute' || !selectedWorkflow || !isAuthenticationWorkflow(selectedWorkflow))) {
        const forcedDecision: OperationAgentDecision = {
          ...decision,
          intent: 'execute',
          skillId: String(authenticationSkills[0]!.id),
          confidence: Math.max(decision.confidence ?? 0, 0.9),
          reply: decision.reply?.trim() || '好的，我现在为你登录。',
        };
        delete forcedDecision.stepIndexes;
        decision = forcedDecision;
      } else if (selectedWorkflow && isAuthenticationWorkflow(selectedWorkflow) && decision.intent === 'execute' && (decision.confidence ?? 0) < 0.9) {
        decision = { ...decision, confidence: 0.9 };
      }
    }

    if (decision.intent === 'answer') return respond(decision.reply?.trim() || '我已经理解你的问题，但这次不需要执行网页操作。', 'answer');
    if (decision.intent !== 'execute') return respond(decision.reply?.trim() || '我还需要你补充具体要完成的操作，确认后再执行。', 'clarify');

    const selected = skills.find((skill) => skill.id === decision.skillId);
    if (!selected) return respond('我没有找到与这条要求准确匹配的已生效技能，因此没有执行。请确认技能名称或先创建对应技能。', 'clarify', null, { rejectedSkillId: decision.skillId ?? null });
    const confidence = typeof decision.confidence === 'number' && Number.isFinite(decision.confidence) ? decision.confidence : 0;
    if (confidence < 0.72) return respond(`我还不能确定你是否要执行“${selected.name}”，因此没有操作。请再明确一下要完成的动作。`, 'clarify', null, { skillId: selected.id, confidence });
    const workflow = selected.workflow as OperationWorkflow | null;
    const parameters = mergeWorkflowDefaults(workflow, decision.parameters && typeof decision.parameters === 'object' && !Array.isArray(decision.parameters) ? decision.parameters : {});
    if (typeof decision.targetText === 'string' && decision.targetText.trim()) parameters.__targetText = decision.targetText.trim();
    if (Number.isInteger(decision.targetStepIndex) && Number(decision.targetStepIndex) > 0) parameters.__targetStepIndex = Number(decision.targetStepIndex);
    else if (typeof decision.targetText === 'string' && decision.targetText.trim()) {
      const inferredTarget = inferDynamicTargetStepIndex(workflow, instruction);
      if (inferredTarget) parameters.__targetStepIndex = inferredTarget;
    }
    const missing = (workflow?.inputSchema.required ?? []).filter((key) => parameters[key] === undefined || parameters[key] === null || String(parameters[key]).trim() === '');
    if (missing.length > 0) {
      const labels = missing.map((key) => workflow?.inputSchema.properties[key]?.description || key);
      return respond(decision.reply?.trim() && decision.reply.includes('?') ? decision.reply.trim() : `执行“${selected.name}”还需要：${labels.join('、')}。请补充后我再开始。`, 'clarify', null, { skillId: selected.id, missing });
    }

    // A browser session can be recreated after a preview restart while the
    // platform still starts at its login URL. Reuse the platform's own
    // credential skill as a generic prerequisite instead of making every
    // business skill duplicate authentication steps.
    if (!isAuthenticationWorkflow(workflow) && isAuthenticationPage(initialSnapshot)) {
      const authenticationSkill = skills
        .filter((candidate) => isAuthenticationWorkflow(candidate.workflow as OperationWorkflow | null | undefined))
        .sort((left, right) => {
          const score = (candidate: Record<string, unknown>): number => {
            const candidateWorkflow = candidate.workflow as OperationWorkflow | null | undefined;
            const credentialFields = Object.entries(candidateWorkflow?.inputSchema.properties ?? {})
              .filter(([key, property]) => /user|账号|用户名|login|pass|密码|口令|pwd/i.test(`${key} ${property.description}`)).length;
            const label = `${candidate.name ?? ''} ${candidateWorkflow?.description ?? ''}`;
            return credentialFields * 100 + (/登录|登陆|sign\s*in|log\s*in/i.test(label) ? 20 : 0);
          };
          return score(right) - score(left) || String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''));
        })[0] as {
          id: string;
          workflow?: OperationWorkflow | null;
        } | undefined;
      if (!authenticationSkill) {
        return respond('当前操作平台尚未登录，且没有可用的登录技能，暂时无法执行这项查询。请先配置并生效登录技能。', 'clarify', null, { authenticationRequired: true });
      }
      const authenticationWorkflow = authenticationSkill.workflow as OperationWorkflow | null;
      const authenticationParameters = mergeWorkflowDefaults(authenticationWorkflow, {});
      const authenticationMissing = (authenticationWorkflow?.inputSchema.required ?? [])
        .filter((key) => authenticationParameters[key] === undefined || authenticationParameters[key] === null || String(authenticationParameters[key]).trim() === '');
      if (authenticationMissing.length > 0) {
        return respond(`当前操作平台尚未登录，请先补充登录技能所需的${authenticationMissing.join('、')}。`, 'clarify', null, { authenticationRequired: true, missing: authenticationMissing });
      }
      const authenticationRun = await this.executeSkill({
        skillId: authenticationSkill.id,
        ownerAgentId: platform.ownerAgentId,
        parameters: authenticationParameters,
        instruction,
        loopContext: {
          instruction,
          platformId: input.platformId,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ownerAgentId: platform.ownerAgentId,
          depth: 0,
          completedSkillIds: [authenticationSkill.id],
          completedStepIndexes: {},
          resumeSkillId: String(selected.id),
          resumeParameters: parameters,
        },
      });
      return respond(`当前页面尚未登录，我先完成登录，再继续执行“${selected.name}”。`, 'execute', authenticationRun.runId, { skillId: authenticationSkill.id, authenticationRequired: true, resumeSkillId: selected.id });
    }

    const run = await this.executeSkill({
      skillId: String(selected.id),
      ownerAgentId: platform.ownerAgentId,
      parameters,
      ...(Array.isArray(decision.businessStepIds) ? { businessStepIds: decision.businessStepIds } : {}),
      ...(Array.isArray(decision.stepIndexes) ? { stepIndexes: decision.stepIndexes } : {}),
      instruction,
      loopContext: {
        instruction,
        platformId: input.platformId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ownerAgentId: platform.ownerAgentId,
        depth: 0,
        completedSkillIds: [String(selected.id)],
        // Step completion is recorded by runWorkflow after each successful
        // action. Do not pre-mark the planner's selection: a failed submit or
        // a partial run must remain eligible for recovery.
        completedStepIndexes: {},
      },
    });
    const message = decision.reply?.trim() || `好的，我现在执行“${selected.name}”。`;
    return respond(message, 'execute', run.runId, { skillId: selected.id, confidence });
  }

  private async readPrivateContext(platform: { ownerAgentId: string; name: string }, projectId?: string): Promise<string> {
    const defaultRoot = join(this.studioRoot, 'operation-agents', `${safeSegment(platform.ownerAgentId)}-workspace`);
    const identityRoot = join(defaultRoot, 'agent-identities', platform.ownerAgentId);
    const memoryRoot = projectId?.trim()
      ? join(getEnterpriseProjectRoot(projectId.trim()), '.runtime', 'node-context', 'operations', safeSegment(platform.ownerAgentId), 'agent-memories', platform.ownerAgentId)
      : join(defaultRoot, 'agent-memories', platform.ownerAgentId);
    const files = [
      ['身份', join(identityRoot, 'IDENTITY.md'), 1_600],
      ['角色卡', join(identityRoot, 'ROLE.md'), 1_600],
      ['适应性补充', join(identityRoot, 'ADAPTATION.md'), 1_200],
      ['当前记忆', join(memoryRoot, 'short-term', 'current.md'), 1_800],
      ['长期记忆', join(memoryRoot, 'long-term', 'summary.md'), 2_200],
    ] as const;
    const sections: string[] = [];
    for (const [label, path, limit] of files) {
      const content = await readFile(path, 'utf8').catch(() => '');
      if (content.trim()) sections.push(`【${label}】\n${content.slice(0, limit)}`);
    }
    return sections.length ? sections.join('\n\n') : `【身份】\n你是“${platform.name}”专属操作智能体，只使用自己的已生效技能。`;
  }

  private async appendPrivateMemory(
    platform: { ownerAgentId: string; name: string },
    projectId: string | undefined,
    instruction: string,
    result: string,
  ): Promise<void> {
    const roots = [
      join(this.studioRoot, 'operation-agents', `${safeSegment(platform.ownerAgentId)}-workspace`),
      ...(projectId?.trim() ? [join(getEnterpriseProjectRoot(projectId.trim()), '.runtime', 'node-context', 'operations', safeSegment(platform.ownerAgentId))] : []),
    ];
    const timestamp = nowIso();
    const compactInstruction = instruction.replace(/\s+/g, ' ').trim().slice(0, 800);
    const compactResult = result.replace(/\s+/g, ' ').trim().slice(0, 1_200);
    const day = timestamp.slice(0, 10);
    for (const root of roots) {
      const memoryRoot = join(root, 'agent-memories', platform.ownerAgentId);
      await mkdir(join(memoryRoot, 'short-term'), { recursive: true });
      await mkdir(join(memoryRoot, 'sessions'), { recursive: true });
      await appendFile(join(memoryRoot, 'short-term', 'current.md'), `\n- ${timestamp}\n  - 用户要求：${compactInstruction}\n  - 当前结果：${compactResult}\n`, 'utf8');
      await appendFile(join(memoryRoot, 'sessions', `${day}.md`), `\n## ${timestamp}\n- 用户要求：${compactInstruction}\n- 结果：${compactResult}\n`, 'utf8');
      await appendFile(join(memoryRoot, 'index.jsonl'), `${JSON.stringify({ schemaVersion: 1, timestamp, kind: 'operation-interaction', instruction: compactInstruction, result: compactResult })}\n`, 'utf8');
    }
  }

  private markStepCompleted(runId: string, workflowId: string, step: OperationWorkflowStep, _index: number): void {
    const context = this.runContexts.get(runId);
    if (!context) return;
    const represented = representedStepNumbers(step);
    if (represented.length === 0) return;
    const completed = context.completedStepIndexes?.[workflowId] ?? [];
    context.completedStepIndexes = {
      ...(context.completedStepIndexes ?? {}),
      [workflowId]: Array.from(new Set([...completed, ...represented])).sort((left, right) => left - right),
    };
  }

  private async operationEvidence(session: BrowserSession, workflow: OperationWorkflow, step: OperationWorkflowStep): Promise<{ snapshot: OperationPageSnapshot; images: Uint8Array[] }> {
    const snapshot = await this.readPageSnapshot(session);
    const images: Uint8Array[] = [];
    const platform = this.getPlatform(workflow.platformId);
    if (this.modelSupportsVision(platform.modelProfileId)) {
      try { images.push((await session.view.webContents.capturePage()).toPNG()); } catch { /* visual evidence is optional */ }
    }
    const recordingReference = await this.findRecordingScreenshot(workflow, step);
    if (recordingReference && images.length > 0) {
      try { images.push(await readFile(join(this.studioRoot, recordingReference))); } catch { /* recording reference is optional */ }
    }
    return { snapshot, images };
  }

  private async confirmStepBeforeExecution(
    session: BrowserSession,
    workflow: OperationWorkflow,
    step: OperationWorkflowStep,
    index: number,
    input: Record<string, unknown>,
    runId: string,
  ): Promise<OperationStepGateDecision> {
    const policy = operationStepConfirmationPolicy(workflow, step, index);
    if (policy.reason === 'authentication-state-local') {
      const snapshot = await this.readPageSnapshot(session);
      if (!isAuthenticationPage(snapshot)) {
        return { action: 'complete', confidence: 1, reason: '当前页面已经处于登录后的平台区域，无需重复登录' };
      }
      return { action: 'execute', confidence: 1, reason: '当前是登录页，继续执行认证动作' };
    }
    if (!policy.before) return { action: 'execute', confidence: 1, reason: '当前动作由已确认的业务工作流直接执行' };
    const platform = this.getPlatform(workflow.platformId);
    const gateway = this.getGateway();
    if (!gateway || !platform.modelProfileId) return { action: 'clarify', reason: '操作智能体暂时无法确认当前页面状态，已停止后续操作' };
    const evidence = await this.operationEvidence(session, workflow, step);
    this.emitRunEvent(runId, 'step.confirming', step.id, { index, phase: 'before', title: step.title });
    const context = this.runContexts.get(runId);
    const prompt = `用户要求：${context?.instruction || ''}\n技能目标：${workflow.plan?.goal || workflow.description}\n业务节点（与 DOM 步骤不要求一一对应）：${JSON.stringify(workflow.plan?.businessSteps ?? workflow.plan?.stages ?? [])}\n可选分支：${JSON.stringify(workflow.plan?.branches ?? [])}\n当前 DOM 步骤（${index + 1}/${workflow.steps.length}）：${JSON.stringify({ id: step.id, title: step.title, purpose: step.purpose, when: step.when, expected: step.expected, action: step.action, locator: step.locator, url: step.url })}\n当前输入（敏感值不展示）：${JSON.stringify(Object.fromEntries(Object.entries(input).filter(([key]) => !/pass|password|pwd|密码|口令/i.test(key))))}\n当前页面证据：${JSON.stringify({ url: evidence.snapshot.url, frameUrls: evidence.snapshot.frameUrls ?? [], title: evidence.snapshot.title, text: evidence.snapshot.text.slice(0, 8000), links: evidence.snapshot.links.slice(0, 30), interactive: evidence.snapshot.interactive?.slice(0, 300) ?? [] })}\n已经确认完成的 DOM 步骤：${JSON.stringify(context?.completedStepIndexes ?? {})}\n请确认下一步：execute=当前 DOM 动作需要执行，skip=页面证据已证明该动作无需重复，complete=用户目标已经完成，clarify=必须让用户确认。列表/详情等分支必须依据用户目标和当前页面选择。若登录技能开始时已能从页面和视觉证据确认处于登录后的平台首页，应直接 complete；若仍在登录页，则必须完成凭据输入、提交和登录后页面确认。只返回 JSON：{\"action\":\"execute|skip|complete|clarify\",\"confidence\":0到1,\"targetText\":\"需要动态选择的条目文本，没有则省略\",\"targetStepIndex\":步骤序号，没有则省略,\"reason\":\"简短自然原因\"}`;
    const promptWithDom = `${prompt}\n当前步骤的 DOM 穿透说明：${domInteractionSummary(step.domInteraction) || '该步骤没有记录到额外的穿透事件'}。source 是用户实际触发的目标，effective 是优先执行的控件，propagated 与 feedbackTypes 是同一行为的 DOM 链和页面反馈，不得拆成额外步骤或再次执行。`;
    try {
      const generate = evidence.images.length > 0
        ? () => gateway.generateObjectWithImages<OperationStepGateDecision>('reasoning', promptWithDom, evidence.images, '你是网页操作流程确认器。结合当前 DOM 和截图，在每一步执行前确认是否应该进入该节点；遇到业务分支要按用户目标选择。')
        : () => gateway.generateObject<OperationStepGateDecision>('reasoning', [{ role: 'user', content: promptWithDom }], '你是网页操作流程确认器。先确认当前页面和用户目标，再决定执行、跳过、完成或询问。');
      const decision = await gateway.runWithModelProfileSnapshot(JSON.stringify({ profileId: platform.modelProfileId, parameters: { temperature: 0 } }), generate);
      const action = decision.action;
      const hasConfidence = typeof decision.confidence === 'number' && Number.isFinite(decision.confidence);
      const confidence = hasConfidence ? decision.confidence! : undefined;
      if (!['execute', 'skip', 'complete', 'clarify'].includes(action)) return { action: 'clarify', reason: '操作智能体没有给出有效的节点判断，已停止后续操作' };
      if (hasConfidence && confidence! < 0.55) return { action: 'clarify', confidence: confidence!, reason: decision.reason || '当前页面证据不足，无法安全进入下一节点' };
      if (isAuthenticationWorkflow(workflow) && action === 'complete') {
        if (!isAuthenticationPage(evidence.snapshot) && (confidence ?? 0) >= 0.8) return { ...decision, action: 'complete', ...(confidence !== undefined ? { confidence } : {}) };
        return { action: 'execute', ...(confidence !== undefined ? { confidence } : {}), reason: '当前仍是登录页，需要完成输入、提交和登录结果确认' };
      }
      if (isAuthenticationWorkflow(workflow) && action === 'skip') return { action: 'execute', ...(confidence !== undefined ? { confidence } : {}), reason: '认证动作不能在未确认登录成功时跳过' };
      if (action === 'skip') {
        let skipEvidence: OperationPageSnapshot | undefined;
        let skipIsSafe = true;
        if (step.action === 'navigate' && step.url) {
          skipEvidence = await this.readPageSnapshot(session);
          skipIsSafe = snapshotMatchesFeedbackUrl(skipEvidence, [step.url]);
        }
        const feedbackUrls = step.domInteraction?.feedbackUrls ?? [];
        if (skipIsSafe && feedbackUrls.length > 0 && ['click', 'press'].includes(step.action)) {
          skipEvidence ??= await this.readPageSnapshot(session);
          // A login shell is never evidence that a recorded portal navigation
          // already happened. For other pages, accept a skip only when the
          // recorded navigation target is visible in the main page or frame.
          skipIsSafe = !isAuthenticationPage(skipEvidence) && snapshotMatchesFeedbackUrl(skipEvidence, feedbackUrls);
        }
        const requestedTarget = typeof input.__targetText === 'string' ? input.__targetText.trim().toLowerCase() : '';
        if (skipIsSafe && requestedTarget) {
          skipEvidence ??= await this.readPageSnapshot(session);
          skipIsSafe = skipEvidence.text.toLowerCase().includes(requestedTarget);
        }
        if (!skipIsSafe) return { action: 'execute', ...(confidence !== undefined ? { confidence } : {}), reason: '当前页面尚未满足跳过该节点的证据条件，继续执行' };
      }
      return { ...decision, action, ...(confidence !== undefined ? { confidence } : {}) };
    } catch (error) {
      getLogger(this.studioRoot)?.warn({ err: error, platformId: workflow.platformId, runId, stepId: step.id }, '操作节点执行前确认失败');
      return { action: 'clarify', reason: '操作智能体暂时无法确认当前节点，已停止后续操作' };
    }
  }

  private async confirmStepCompletion(
    session: BrowserSession,
    workflow: OperationWorkflow,
    step: OperationWorkflowStep,
    index: number,
    runId: string,
    attempt: number,
  ): Promise<OperationStepVerification> {
    const policy = operationStepConfirmationPolicy(workflow, step, index);
    if (!policy.after) {
      return { status: 'confirmed', confidence: 1, workflowComplete: false, reason: 'DOM 动作已由执行器本地确认' };
    }
    if (isAuthenticationWorkflow(workflow)) {
      const snapshot = await this.readPageSnapshot(session);
      if (!isAuthenticationPage(snapshot)) {
        return { status: 'confirmed', confidence: 1, workflowComplete: true, reason: '页面已经离开登录入口并进入登录后的平台区域' };
      }
    }
    const platform = this.getPlatform(workflow.platformId);
    const gateway = this.getGateway();
    const evidence = await this.operationEvidence(session, workflow, step);
    this.emitRunEvent(runId, 'step.confirming', step.id, { index, phase: 'after', title: step.title, attempt: attempt + 1 });
    if (!gateway || !platform.modelProfileId) return { status: 'clarify', reason: '操作智能体暂时无法确认节点结果，已停止后续操作' };
    const next = workflow.steps[index + 1];
    const prompt = `用户要求：${this.runContexts.get(runId)?.instruction || ''}\n技能完成条件：${JSON.stringify(workflow.plan?.completionCriteria ?? workflow.success.evidence)}\n刚刚执行的节点：${JSON.stringify({ id: step.id, title: step.title, purpose: step.purpose, expected: step.expected, action: step.action })}\n下一节点：${next ? JSON.stringify({ id: next.id, title: next.title, purpose: next.purpose, when: next.when, action: next.action }) : '没有下一节点'}\n执行后页面证据：${JSON.stringify({ url: evidence.snapshot.url, title: evidence.snapshot.title, text: evidence.snapshot.text.slice(0, 10000), links: evidence.snapshot.links.slice(0, 30), interactive: evidence.snapshot.interactive?.slice(0, 300) ?? [] })}\n请确认刚才的节点是否真的完成。只有页面明确显示动作未生效、跳转错误、表单校验失败或目标元素状态未改变时才 retry；证据足够或动作本身不可见但已成功触发时返回 confirmed。页面出现需要用户选择、扫码或解释的歧义时返回 clarify。若用户目标已经达到，可将 workflowComplete=true。不要把页面全文当作回答。只返回 JSON：{\"status\":\"confirmed|retry|clarify\",\"confidence\":0到1,\"workflowComplete\":true或false,\"reason\":\"简短证据\"}`;
    const promptWithDom = `${prompt}\n刚刚执行的步骤包含 DOM 穿透说明：${domInteractionSummary(step.domInteraction) || '该步骤没有记录到额外的穿透事件'}。source/effective/propagated 用于解释同一用户行为的控件链，feedbackTypes 是完成证据而不是需要重放的动作，不要因为原始事件多就要求重复执行。`;
    try {
      const generate = evidence.images.length > 0
        ? () => gateway.generateObjectWithImages<OperationStepVerification>('reasoning', promptWithDom, evidence.images, '你是网页操作结果验收器。根据 DOM、页面跳转和截图证据确认当前节点，只有确实失败才要求重试。')
        : () => gateway.generateObject<OperationStepVerification>('reasoning', [{ role: 'user', content: promptWithDom }], '你是网页操作结果验收器。根据当前页面证据确认节点是否完成，再允许流程进入下一步。');
      const decision = await gateway.runWithModelProfileSnapshot(JSON.stringify({ profileId: platform.modelProfileId, parameters: { temperature: 0 } }), generate);
      const status = decision.status;
      const hasConfidence = typeof decision.confidence === 'number' && Number.isFinite(decision.confidence);
      const confidence = hasConfidence ? decision.confidence! : undefined;
      if (!['confirmed', 'retry', 'clarify'].includes(status)) return { status: 'clarify', reason: '操作智能体没有给出有效的结果判断，已停止后续操作' };
      if (hasConfidence && confidence! < 0.55) return { status: 'clarify', confidence: confidence!, reason: decision.reason || '当前页面证据不足，无法确认节点已完成' };
      if (status === 'retry') return { ...decision, status, ...(confidence !== undefined ? { confidence } : {}) };
      if (status === 'clarify') return { ...decision, status, ...(confidence !== undefined ? { confidence } : {}) };
      if (operationVerificationIndicatesFailure(decision.reason)) {
        return { ...decision, status: 'retry', ...(confidence !== undefined ? { confidence } : {}) };
      }
      return { ...decision, status: 'confirmed', ...(confidence !== undefined ? { confidence } : {}), workflowComplete: decision.workflowComplete === true && !next?.stateOnly && (!hasConfidence || confidence! >= 0.8) };
    } catch (error) {
      getLogger(this.studioRoot)?.warn({ err: error, platformId: workflow.platformId, runId, stepId: step.id }, '操作节点完成确认失败');
      return { status: 'clarify', reason: '操作智能体暂时无法确认节点结果，已停止后续操作' };
    }
  }

  private async runWorkflow(runId: string, workflow: OperationWorkflow, input: Record<string, unknown>): Promise<void> {
    try {
      const session = this.ensureSession(workflow.platformId);
      const startedAt = nowIso();
      this.db.prepare("UPDATE operation_skill_runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?").run(startedAt, startedAt, runId);
      this.emitRunEvent(runId, 'run.started', null, { stepCount: workflow.steps.length, workflowMode: 'agent-confirmed-loop' });
      let stopAfterStep = false;
      const extractedValues: string[] = [];
      const skippedStepIndexes: number[] = [];
      let resultSnapshot: OperationPageSnapshot | null = null;
      const completedStepNumbers = new Set(this.runContexts.get(runId)?.completedStepIndexes?.[workflow.id] ?? []);
      let activeStageId: string | null = null;
      const stageForStep = (step: OperationWorkflowStep, stepNumber: number | null): WorkflowStage | undefined => {
        const businessStep = workflow.plan?.businessSteps?.find((item) => (
          step.businessStepId ? item.id === step.businessStepId : stepNumber !== null && item.domStepIndexes?.includes(stepNumber)
        ));
        if (businessStep) {
          return {
            ...(businessStep.id ? { id: businessStep.id } : {}),
            ...(businessStep.title ? { title: businessStep.title } : {}),
            ...(businessStep.purpose ? { purpose: businessStep.purpose } : {}),
            ...(businessStep.domStepIndexes?.length ? { stepIndexes: businessStep.domStepIndexes } : {}),
            ...(businessStep.dependsOn?.length ? { dependsOn: businessStep.dependsOn } : {}),
            ...(businessStep.kind ? { kind: businessStep.kind } : {}),
            ...(businessStep.completionCriteria?.length ? { completionCriteria: businessStep.completionCriteria } : {}),
          };
        }
        return stepNumber === null ? undefined : workflow.plan?.stages?.find((stage) => stage.stepIndexes?.includes(stepNumber));
      };
      const updateStage = (step: OperationWorkflowStep, stepNumber: number | null, phase: 'started' | 'completed'): void => {
        const stage = stageForStep(step, stepNumber);
        if (!stage?.id) return;
        if (phase === 'started' && activeStageId !== stage.id) {
          activeStageId = stage.id;
          this.emitRunEvent(runId, 'stage.started', null, { stageId: stage.id, title: stage.title, purpose: stage.purpose, kind: stage.kind, stepIndexes: stage.stepIndexes ?? [] });
        }
        if (phase === 'completed' && ((stage.stepIndexes?.length ?? 0) === 0 || stage.stepIndexes?.every((index) => completedStepNumbers.has(index)))) {
          this.emitRunEvent(runId, 'stage.completed', null, { stageId: stage.id, title: stage.title, purpose: stage.purpose, kind: stage.kind, stepIndexes: stage.stepIndexes ?? [] });
        }
      };
      for (let index = 0; index < workflow.steps.length; index++) {
        if (this.cancelledRuns.has(runId)) throw new Error('__CANCELLED__');
        const step = workflow.steps[index]!;
        const stepNumber = recordedStepNumber(step);
        const stepNumbers = representedStepNumbers(step);
        const loopContext = this.runContexts.get(runId);
        // A continuation run receives the complete abstract workflow. Steps
        // already confirmed by the previous run are carried forward without
        // re-navigating or repeating side effects.
        if (stepNumbers.length > 0 && stepNumbers.every((value) => loopContext?.completedStepIndexes?.[workflow.id]?.includes(value))) {
          skippedStepIndexes.push(...stepNumbers);
          this.emitRunEvent(runId, 'step.skipped', step.id, { index, title: step.title, reason: '此前执行已确认完成', alreadyCompleted: true });
          stepNumbers.forEach((value) => completedStepNumbers.add(value));
          updateStage(step, stepNumber, 'completed');
          continue;
        }
        updateStage(step, stepNumber, 'started');
        this.db.prepare('UPDATE operation_skill_runs SET current_step_index = ?, updated_at = ? WHERE id = ?').run(index, nowIso(), runId);

        const gate = await this.confirmStepBeforeExecution(session, workflow, step, index, input, runId);
        if (gate.targetText?.trim()) input.__targetText = gate.targetText.trim();
        if (Number.isInteger(gate.targetStepIndex) && Number(gate.targetStepIndex) > 0) input.__targetStepIndex = Number(gate.targetStepIndex);
        else if (gate.targetText?.trim()) input.__targetStepIndex = index + 1;
        if (gate.action === 'clarify') throw new Error(`执行“${step.title}”前需要确认：${gate.reason || '当前页面状态与任务要求不一致'}`);
        if (gate.action === 'complete') {
          this.emitRunEvent(runId, 'workflow.satisfied', step.id, { index, reason: gate.reason || 'agent-confirmed-complete', confidence: gate.confidence ?? null });
          updateStage(step, stepNumber, 'completed');
          stopAfterStep = true;
          break;
        }
        if (gate.action === 'skip' && !isAuthenticationWorkflow(workflow)) {
          this.emitRunEvent(runId, 'step.skipped', step.id, { index, title: step.title, reason: gate.reason || 'agent-confirmed-not-needed', confidence: gate.confidence ?? null });
          skippedStepIndexes.push(...stepNumbers);
          this.markStepCompleted(runId, workflow.id, step, index);
          stepNumbers.forEach((value) => completedStepNumbers.add(value));
          updateStage(step, stepNumber, 'completed');
          continue;
        }

        let attempt = 0;
        while (true) {
          if (this.cancelledRuns.has(runId)) throw new Error('__CANCELLED__');
          this.emitRunEvent(runId, 'step.started', step.id, { index, title: step.title, action: step.action, attempt: attempt + 1 });
          try {
            const stepResult = await this.executeStep(session, workflow, step, input);
            if (stepResult.value) extractedValues.push(stepResult.value);
          } catch (error) {
            if (attempt < 1 && !this.cancelledRuns.has(runId)) {
              attempt += 1;
              this.emitRunEvent(runId, 'step.retrying', step.id, { index, title: step.title, reason: error instanceof Error ? error.message : String(error), attempt: attempt + 1 });
              continue;
            }
            throw error;
          }
          const verification = await this.confirmStepCompletion(session, workflow, step, index, runId, attempt);
          if (verification.status === 'retry') {
            if (attempt < 1) {
              attempt += 1;
              this.emitRunEvent(runId, 'step.retrying', step.id, { index, title: step.title, reason: verification.reason || '页面证据未确认该步骤已完成', attempt: attempt + 1 });
              continue;
            }
            throw new Error(`步骤“${step.title}”连续校验未通过：${verification.reason || '页面证据未确认该步骤已完成'}`);
          }
          if (verification.status === 'clarify') throw new Error(`步骤“${step.title}”需要确认：${verification.reason || '页面状态存在歧义'}`);
          this.emitRunEvent(runId, 'step.completed', step.id, { index, title: step.title, url: session.view.webContents.getURL(), confirmation: verification.reason || 'agent-confirmed', confidence: verification.confidence ?? null });
          this.markStepCompleted(runId, workflow.id, step, index);
          stepNumbers.forEach((value) => completedStepNumbers.add(value));
          updateStage(step, stepNumber, 'completed');
          const completedBusinessStep = businessStepForRuntimeStep(workflow, step);
          if (completedBusinessStep && ['collection', 'detail', 'result'].includes(completedBusinessStep.kind ?? '')) {
            resultSnapshot = await this.readPageSnapshot(session);
          }
          if (verification.workflowComplete && (verification.confidence ?? 0) >= 0.8) {
            this.emitRunEvent(runId, 'workflow.satisfied', step.id, { index, url: session.view.webContents.getURL(), reason: 'agent-confirmed-complete', confidence: verification.confidence });
            stopAfterStep = true;
          }
          break;
        }
        // Authentication may reach its explicit success URL before redundant
        // recorded clicks/navigation steps. Other workflows only stop early
        // when the verifier has strong evidence of completion.
        const hasPendingStateNode = workflow.steps.slice(index + 1).some((candidate) => candidate.stateOnly);
        if (stopAfterStep || (isAuthenticationWorkflow(workflow) && !hasPendingStateNode && await this.isWorkflowComplete(session, workflow))) break;
      }
      const finalSnapshot = await this.readPageSnapshot(session);
      if (isAuthenticationWorkflow(workflow) && isAuthenticationPage(finalSnapshot)) {
        // Do not expose the login form as a successful page read. The loop
        // gets a chance to recover missing submit actions or ask for a scan.
        throw new Error('认证流程尚未完成：当前仍停留在登录页面');
      }
      const answerSnapshot = resultSnapshot ?? finalSnapshot;
      const output = {
        finalUrl: finalSnapshot.url,
        ...(answerSnapshot.url !== finalSnapshot.url ? { resultUrl: answerSnapshot.url } : {}),
        summary: `“${workflow.name}”已执行完成。`,
        pageTitle: answerSnapshot.title,
        pageText: answerSnapshot.text,
        links: answerSnapshot.links,
        ...(extractedValues.length > 0 ? { extractedText: extractedValues.join('\n') } : {}),
        ...(skippedStepIndexes.length > 0 ? { skippedStepIndexes } : {}),
      };
      const completedAt = nowIso();
      const loopContext = this.runContexts.get(runId);
      // A skill run is only a page-action phase when it has a loop context.
      // Keep it running while the operation agent interprets the page and
      // possibly executes dependent skills. This prevents the group bridge
      // from observing a premature `completed` row and returning pageText.
      this.db.prepare(
        `UPDATE operation_skill_runs
         SET status = ?, output_json = ?, completed_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(loopContext ? 'running' : 'completed', JSON.stringify(output), loopContext ? null : completedAt, completedAt, runId);
      this.emitRunEvent(runId, 'run.completed', null, output);
      if (loopContext) {
        // Keep the original parameters when a session expires halfway
        // through a non-authentication skill. The continuation can run the
        // platform's login skill and then resume the same business request
        // (including a dynamic target row) without asking the user again.
        if (!isAuthenticationWorkflow(workflow) && isAuthenticationPage(finalSnapshot)) {
          loopContext.resumeSkillId ??= workflow.id;
          loopContext.resumeParameters ??= { ...input };
        }
        const continuationSnapshot = !isAuthenticationWorkflow(workflow) && isAuthenticationPage(finalSnapshot)
          ? finalSnapshot
          : answerSnapshot;
        await this.continueOperationLoop(loopContext, workflow, runId, continuationSnapshot);
      } else {
        this.addConversationMessage(workflow.platformId, 'agent', `“${workflow.name}”已执行完成。${answerSnapshot.text ? ` 页面已读取到 ${answerSnapshot.text.length} 个字符。` : ''}`, runId, { kind: 'run-completed', skillId: workflow.id, finalUrl: output.finalUrl });
      }
    } catch (error) {
      const cancelled = error instanceof Error && error.message === '__CANCELLED__';
      const message = cancelled ? '任务已取消' : error instanceof Error ? error.message : String(error);
      const completedAt = nowIso();
      const loopContext = this.runContexts.get(runId);
      this.db.prepare(`UPDATE operation_skill_runs SET status = ?, error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
        .run(cancelled ? 'cancelled' : loopContext ? 'running' : 'failed', message, loopContext ? null : completedAt, completedAt, runId);
      this.emitRunEvent(runId, cancelled ? 'run.cancelled' : 'run.failed', null, { error: message });
      const userMessage = cancelled
        ? `“${workflow.name}”已取消。`
        : /未找到目标页面元素/.test(message)
          ? `我已结合当前页面、DOM 信息和录制画面尝试定位“${workflow.name}”的下一步，但页面结构仍无法确认，暂未继续操作。请告诉我当前页面上要点击的具体入口或补充一张最新页面截图，我再继续。`
          : `“${workflow.name}”执行失败：${message}`;
      if (loopContext && !cancelled) {
        try {
          const session = this.sessions.get(workflow.platformId);
          const snapshot = session ? await this.readPageSnapshot(session) : { url: '', title: '', text: `技能执行失败：${message}`, links: [] };
          if (!isAuthenticationWorkflow(workflow) && isAuthenticationPage(snapshot)) {
            loopContext.resumeSkillId ??= workflow.id;
            loopContext.resumeParameters ??= { ...input };
          }
          await this.continueOperationLoop(loopContext, workflow, runId, snapshot);
        } catch (recoveryError) {
          getLogger(this.studioRoot)?.warn({ err: recoveryError, platformId: workflow.platformId, runId }, '操作技能失败后的 loop 恢复失败');
          this.addConversationMessage(workflow.platformId, 'agent', userMessage, runId, { kind: 'run-failed', skillId: workflow.id });
          const failedAt = nowIso();
          this.db.prepare("UPDATE operation_skill_runs SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?")
            .run(recoveryError instanceof Error ? recoveryError.message : String(recoveryError), failedAt, failedAt, runId);
        }
      } else {
        this.addConversationMessage(workflow.platformId, 'agent', userMessage, runId, { kind: cancelled ? 'run-cancelled' : 'run-failed', skillId: workflow.id });
      }
    } finally {
      this.cancelledRuns.delete(runId);
    }
  }

  private async readPageSnapshot(session: BrowserSession): Promise<OperationPageSnapshot> {
    const fallback: OperationPageSnapshot = { url: session.view.webContents.getURL(), title: '', text: '', links: [], frameUrls: [] };
    const snapshot = await session.view.webContents.executeJavaScript(`(() => {
      // Same-origin frames are common in enterprise portals. Walk them
      // recursively so evidence and semantic matching are not limited to the
      // first iframe level; cross-origin frames are intentionally ignored.
      const collectRoots = (root, seen = new Set()) => {
        if (!root || seen.has(root)) return [];
        seen.add(root);
        const roots = [root];
        for (const frame of Array.from(root.querySelectorAll('iframe,frame'))) {
          try { roots.push(...collectRoots(frame.contentDocument, seen)); } catch {}
        }
        return roots;
      };
      const roots = collectRoots(document);
      const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      return {
        url: location.href,
        title: document.title || '',
        text: roots.map((root) => root.body?.innerText || '').join('\\n').replace(/\\s+/g, ' ').trim().slice(0, 24000),
        frameUrls: roots.map((root) => { try { return root.location?.href || ''; } catch { return ''; } }).filter(Boolean).slice(0, 40),
        links: roots.flatMap((root) => Array.from(root.querySelectorAll('a[href]')).map((item) => ({ text: clean(item.innerText || item.textContent).slice(0, 120), href: item.href }))).filter((item) => item.text || item.href).slice(0, 80),
        interactive: roots.flatMap((root) => Array.from(root.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]')).map((item) => {
          const element = item;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          if (rect.width <= 2 || rect.height <= 2 || style.display === 'none' || style.visibility === 'hidden') return null;
          return {
            tag: element.tagName.toLowerCase(),
            text: clean(element.innerText || element.textContent).slice(0, 160),
            role: element.getAttribute('role') || '',
            name: element.getAttribute('aria-label') || element.getAttribute('name') || element.getAttribute('placeholder') || element.getAttribute('title') || '',
            ...(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? { value: element.value.slice(0, 120) } : {}),
            ...(element instanceof HTMLAnchorElement ? { href: element.href } : {}),
          };
        }).filter(Boolean)).slice(0, 300),
      };
    })()`, true).catch(() => fallback) as Partial<OperationPageSnapshot>;
    return {
      url: typeof snapshot.url === 'string' ? snapshot.url : fallback.url,
      title: typeof snapshot.title === 'string' ? snapshot.title : '',
      text: typeof snapshot.text === 'string' ? snapshot.text : '',
      links: Array.isArray(snapshot.links) ? snapshot.links.filter((item): item is { text: string; href: string } => !!item && typeof item.text === 'string' && typeof item.href === 'string') : [],
      frameUrls: Array.isArray(snapshot.frameUrls) ? snapshot.frameUrls.filter((item): item is string => typeof item === 'string' && item.length > 0) : [],
      interactive: Array.isArray(snapshot.interactive) ? snapshot.interactive.filter((item): item is NonNullable<OperationPageSnapshot['interactive']>[number] => !!item && typeof item === 'object' && typeof item.tag === 'string' && typeof item.text === 'string' && typeof item.role === 'string' && typeof item.name === 'string') : [],
    };
  }

  private fallbackOperationAnswer(snapshot: OperationPageSnapshot, skillName: string): string {
    if (!snapshot.text) return `“${skillName}”已经执行完成，但当前页面没有读取到可供整理的正文。`;
    const excerpt = snapshot.text.slice(0, 4_000);
    return `“${skillName}”已经执行完成。页面内容如下：\n\n${excerpt}${snapshot.text.length > excerpt.length ? '\n\n（页面内容较长，已截取前 4000 个字符。）' : ''}`;
  }

  private async saveCollaborationEvidence(
    context: OperationLoopContext,
    workflow: OperationWorkflow,
    runId: string,
    snapshot: OperationPageSnapshot,
    decision: OperationLoopDecision,
  ): Promise<string | null> {
    if (!context.projectId?.trim()) return null;
    const rootRunId = context.rootRunId ?? runId;
    const root = getProjectTempRunRoot(context.projectId.trim(), rootRunId);
    await mkdir(root, { recursive: true });
    const fileName = `operation-evidence-${safeSegment(workflow.name)}-${runId.slice(0, 8)}.md`;
    const output = this.getRun(runId)?.output;
    const outputJson = output && typeof output === 'object' ? JSON.stringify(output, null, 2) : '{}';
    const body = [
      `# 操作平台证据：${workflow.name}`,
      '',
      `- 用户目标：${context.instruction}`,
      `- 平台：${context.platformId}`,
      `- 页面 URL：${snapshot.url}`,
      `- 页面标题：${snapshot.title}`,
      `- 页面框架：${snapshot.frameUrls?.join('、') || '无'}`,
      `- 需要协作原因：${decision.collaborationReason?.trim() || '操作智能体判断当前领域信息不足'}`,
      `- 协作摘要：${decision.collaborationBrief?.trim() || '请基于以下完整页面证据继续处理'}`,
      '',
      '## 页面正文',
      '',
      snapshot.text || '（页面没有可读取正文）',
      '',
      '## 页面链接',
      '',
      snapshot.links.map((link) => `- ${link.text || '(无标题)'}: ${link.href}`).join('\n') || '（无）',
      '',
      '## 可交互元素摘要',
      '',
      snapshot.interactive?.map((item) => `- [${item.tag}] ${item.name || item.text || '(无名称)'}${item.href ? ` -> ${item.href}` : ''}`).join('\n') || '（无）',
      '',
      '## 操作运行数据',
      '',
      '```json',
      outputJson,
      '```',
      '',
    ].join('\n');
    await writeFile(join(root, fileName), body, 'utf8');
    return fileName;
  }

  private async awaitRun(runId: string): Promise<void> {
    const promise = this.runPromises.get(runId);
    if (promise) {
      await promise;
      return;
    }
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      const row = this.db.prepare('SELECT status FROM operation_skill_runs WHERE id = ?').get(runId) as { status?: string } | undefined;
      if (row && ['completed', 'failed', 'cancelled'].includes(row.status ?? '')) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * Wait for the complete operation loop, not merely the first database
   * status transition. The public bridge uses this when a group-chat task
   * delegates work to an operation agent.
   */
  async waitForRun(runId: string, timeoutMs = 10 * 60 * 1000): Promise<Record<string, unknown> | null> {
    const promise = this.runPromises.get(runId);
    if (promise) {
      await promise;
      return this.getRun(runId);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = this.getRun(runId);
      const status = String(current?.status ?? '');
      if (['completed', 'failed', 'cancelled', 'awaiting_user'].includes(status)) return current;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    return this.getRun(runId);
  }

  private async continueOperationLoop(context: OperationLoopContext, workflow: OperationWorkflow, runId: string, snapshot: OperationPageSnapshot): Promise<void> {
    const gateway = this.getGateway();
    const platform = this.getPlatform(context.platformId);
    const deliver = (content: string, intent: 'answer' | 'clarify', metadata: Record<string, unknown> = {}): void => {
      const finalAnswer = content.trim();
      const finalIntent = intent;
      const resultRunId = context.rootRunId ?? runId;
      const current = this.getRun(runId);
      const currentOutput = current?.output && typeof current.output === 'object'
        ? current.output as Record<string, unknown>
        : {};
      const finalOutput = {
        ...currentOutput,
        finalAnswer,
        finalIntent,
        requiresUserResponse: metadata.requiresUserResponse === true,
        analysisCompleted: true,
        ...metadata,
      };
      const updatedAt = nowIso();
      this.db.prepare(
        `UPDATE operation_skill_runs
         SET output_json = ?, status = ?, completed_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify(finalOutput), intent === 'clarify' ? 'awaiting_user' : 'completed', updatedAt, updatedAt, runId);
      // Child skills can be the run that actually reached the answer. Mirror
      // the semantic result onto the root so the group bridge has one stable
      // result to read, while retaining each child run's own evidence/events.
      if (resultRunId !== runId) {
        const root = this.getRun(resultRunId);
        const rootOutput = root?.output && typeof root.output === 'object' ? root.output as Record<string, unknown> : {};
        this.db.prepare(
          `UPDATE operation_skill_runs
           SET output_json = ?, status = ?, completed_at = ?, updated_at = ?
           WHERE id = ?`,
        ).run(JSON.stringify({ ...rootOutput, finalAnswer, finalIntent, requiresUserResponse: metadata.requiresUserResponse === true, analysisCompleted: true, sourceRunId: runId, ...metadata }), intent === 'clarify' ? 'awaiting_user' : 'completed', updatedAt, updatedAt, resultRunId);
      }
      this.addConversationMessage(context.platformId, 'agent', finalAnswer, runId, { kind: intent === 'answer' ? 'operation-final' : 'operation-clarify', skillId: workflow.id, ...metadata });
      void this.appendPrivateMemory(platform, context.projectId, context.instruction, finalAnswer).catch((error) => getLogger(this.studioRoot)?.warn({ err: error, platformId: context.platformId }, '操作智能体记忆写入失败'));
    };

    // An authenticated portal can redirect an otherwise valid operation back
    // to its login page after a session timeout (often on the first click).
    // Treat that page as an implicit prerequisite, just like the initial
    // session check in runInstruction, and resume the original operation once
    // authentication completes. Without this branch the planner sees the
    // login shell as ordinary page evidence and asks for credentials again or
    // stops at the intermediate state node.
    if (!isAuthenticationWorkflow(workflow) && isAuthenticationPage(snapshot)) {
      const attempts = context.authRecoveryAttempts ?? 0;
      if (attempts >= 2) {
        deliver('当前页面仍未完成登录，已停止重复尝试。请确认账号密码有效，或完成页面要求的扫码/二次验证后再继续。', 'clarify', {
          loopDepth: context.depth,
          authenticationPending: true,
          recoveryAttempts: attempts,
          requiresUserResponse: true,
        });
        return;
      }
      const authenticationSkill = this.listSkills(context.platformId, false, true)
        .filter((candidate) => candidate.status === 'active' && candidate.enabled !== 0 && isAuthenticationWorkflow(candidate.workflow as OperationWorkflow | null | undefined))
        .sort((left, right) => {
          const score = (candidate: Record<string, unknown>): number => {
            const candidateWorkflow = candidate.workflow as OperationWorkflow | null | undefined;
            const credentialFields = Object.entries(candidateWorkflow?.inputSchema.properties ?? {})
              .filter(([key, property]) => /user|账号|用户名|login|pass|密码|口令|pwd/i.test(`${key} ${property.description}`)).length;
            const label = `${candidate.name ?? ''} ${candidateWorkflow?.description ?? ''}`;
            return credentialFields * 100 + (/登录|登陆|sign\s*in|log\s*in/i.test(label) ? 20 : 0);
          };
          return score(right) - score(left) || String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''));
        })[0] as { id: string; workflow?: OperationWorkflow | null } | undefined;
      if (!authenticationSkill) {
        deliver('当前操作平台需要重新登录，但没有可用的登录技能。请先配置并生效登录技能。', 'clarify', { authenticationRequired: true, requiresUserResponse: true });
        return;
      }
      const authenticationWorkflow = authenticationSkill.workflow as OperationWorkflow | null;
      const authenticationParameters = mergeWorkflowDefaults(authenticationWorkflow, {});
      const authenticationMissing = (authenticationWorkflow?.inputSchema.required ?? [])
        .filter((key) => authenticationParameters[key] === undefined || authenticationParameters[key] === null || String(authenticationParameters[key]).trim() === '');
      if (authenticationMissing.length > 0) {
        deliver(`当前操作平台需要重新登录，请先补充登录技能所需的${authenticationMissing.join('、')}。`, 'clarify', {
          authenticationRequired: true,
          missing: authenticationMissing,
          requiresUserResponse: true,
        });
        return;
      }
      context.resumeSkillId ??= workflow.id;
      context.resumeParameters ??= {};
      const authenticationRun = await this.executeSkill({
        skillId: authenticationSkill.id,
        ownerAgentId: context.ownerAgentId,
        parameters: authenticationParameters,
        instruction: context.instruction,
        loopContext: {
          ...context,
          depth: context.depth + 1,
          authRecoveryAttempts: attempts + 1,
          completedSkillIds: Array.from(new Set([...context.completedSkillIds, authenticationSkill.id])),
          lastSnapshot: snapshot,
          resumeSkillId: workflow.id,
          resumeParameters: context.resumeParameters,
        },
      });
      await this.awaitRun(authenticationRun.runId);
      return;
    }
    if (isAuthenticationWorkflow(workflow) && isAuthenticationPage(snapshot)) {
      const failedRun = this.db.prepare('SELECT current_step_index as currentStepIndex, error_message as errorMessage FROM operation_skill_runs WHERE id = ?')
        .get(runId) as { currentStepIndex: number | null; errorMessage: string | null } | undefined;
      const completed = context.completedStepIndexes?.[workflow.id] ?? [];
      const pending = authenticationStepIndexes(workflow).filter((index) => !completed.includes(index));
      const attempts = context.authRecoveryAttempts ?? 0;
      if (failedRun?.errorMessage && /脚本执行异常|script failed to execute|未找到目标页面元素/i.test(failedRun.errorMessage)) {
        const failedStep = workflow.steps[Math.max(0, failedRun.currentStepIndex ?? 0)];
        deliver(`登录流程卡在“${failedStep?.title || '页面操作'}”：该页面动作没有成功执行，因此还没有进入账号密码校验。这不是账号或密码无效的判断。`, 'clarify', {
          loopDepth: context.depth,
          authenticationPending: true,
          technicalFailure: true,
          failedStepId: failedStep?.id,
        });
        return;
      }
      // Retry only when the page state is ambiguous. A deterministic DOM
      // lookup failure is a technical error, not a reason to replay the same
      // login action several times and eventually surface a generic page dump.
      if (pending.length > 0 && attempts < 2) {
        const retryWorkflow = this.listSkills(context.platformId, false, true).find((skill) => skill.id === workflow.id)?.workflow as OperationWorkflow | null;
        const parameters = mergeWorkflowDefaults(retryWorkflow, {});
        const child = await this.executeSkill({
          skillId: workflow.id,
          ownerAgentId: context.ownerAgentId,
          parameters,
          stepIndexes: pending,
          instruction: context.instruction,
          loopContext: {
            ...context,
            depth: context.depth + 1,
            authRecoveryAttempts: attempts + 1,
            lastSnapshot: snapshot,
          },
        });
        await this.awaitRun(child.runId);
        return;
      }
      deliver('登录还没有完成，当前页面仍是登录页。请确认账号密码有效，或完成页面要求的扫码/二次验证后，我再继续。', 'clarify', {
        loopDepth: context.depth,
        authenticationPending: true,
        recoveryAttempts: attempts,
        requiresUserResponse: true,
      });
      return;
    }
    const currentRun = this.getRun(runId);
    const priorExecutionError = typeof currentRun?.errorMessage === 'string' && currentRun.errorMessage.trim().length > 0
      ? currentRun.errorMessage.trim()
      : '';
    if (!gateway || !platform.modelProfileId || context.depth >= 6) {
      if (priorExecutionError) {
        deliver(`“${workflow.name}”执行未完成：${priorExecutionError}`, 'clarify', {
          loopDepth: context.depth,
          technicalFailure: true,
          requiresUserResponse: false,
        });
      } else {
        deliver(this.fallbackOperationAnswer(snapshot, workflow.name), 'answer', { loopDepth: context.depth, fallback: true });
      }
      return;
    }

    // Return to the original request after a prerequisite skill (typically
    // authentication) completes. This keeps dependency recovery deterministic
    // while leaving the downstream skill's own planner and loop in control.
    if (context.resumeSkillId) {
      const resume = this.listSkills(context.platformId, false, true)
        .find((candidate) => String(candidate.id) === context.resumeSkillId && candidate.status === 'active' && candidate.enabled !== 0) as {
          id: string;
          workflow?: OperationWorkflow | null;
        } | undefined;
      if (resume) {
        const resumeWorkflow = resume.workflow as OperationWorkflow | null;
        const resumeParameters = mergeWorkflowDefaults(resumeWorkflow, context.resumeParameters ?? {});
        const { resumeSkillId: _resumeSkillId, resumeParameters: _resumeParameters, ...contextWithoutResume } = context;
        const child = await this.executeSkill({
          skillId: resume.id,
          ownerAgentId: context.ownerAgentId,
          parameters: resumeParameters,
          instruction: context.instruction,
          loopContext: {
            ...contextWithoutResume,
            depth: context.depth + 1,
            completedSkillIds: [...context.completedSkillIds, resume.id],
            completedStepIndexes: { ...(context.completedStepIndexes ?? {}) },
            lastSnapshot: snapshot,
          },
        });
        await this.awaitRun(child.runId);
        return;
      }
    }
    const completedRun = this.getRun(runId);
    const runOutput = completedRun?.output && typeof completedRun.output === 'object' ? completedRun.output as Record<string, unknown> : {};
    const skills = this.listSkills(context.platformId, false, true).filter((skill) => skill.status === 'active' && skill.enabled !== 0).map((skill) => {
      const candidateWorkflow = skill.workflow as OperationWorkflow | null;
      return {
        id: String(skill.id),
        name: String(skill.name ?? ''),
        description: String(skill.description ?? ''),
        requiredInputs: candidateWorkflow?.inputSchema.required ?? [],
        inputProperties: Object.fromEntries(Object.entries(candidateWorkflow?.inputSchema.properties ?? {}).map(([key, property]) => [key, { description: property.description, sensitive: property.sensitive, defaultAvailable: workflowHasDefault(candidateWorkflow, key, property) }])),
        plan: candidateWorkflow?.plan ?? {},
        steps: (candidateWorkflow?.steps ?? []).map((step, index) => ({ index: index + 1, title: step.title, purpose: step.purpose, when: step.when, expected: step.expected, action: step.action, locator: step.locator, domInteraction: step.domInteraction })),
      };
    });
    const prompt = `用户原始要求：${context.instruction}\n刚刚完成的技能：${workflow.name}\n技能业务计划：${JSON.stringify(workflow.plan ?? {})}\n本次执行结果：${JSON.stringify(runOutput)}\n当前页面：${JSON.stringify({ url: snapshot.url, frameUrls: snapshot.frameUrls ?? [], title: snapshot.title, text: snapshot.text.slice(0, 16000), links: snapshot.links.slice(0, 40), interactive: snapshot.interactive?.slice(0, 300) ?? [] })}\n已经完成的技能 ID：${JSON.stringify(context.completedSkillIds)}\n已经完成的 DOM 动作：${JSON.stringify(context.completedStepIndexes ?? {})}\n可用技能：${JSON.stringify(skills)}\n请判断当前任务是否已经有足够结果。若页面或执行结果已经能回答用户，返回 answer，并用自然语言归纳关键结果，不要复述执行过程。若仍缺少业务节点，返回 execute、精确 skillId、最小必要的 businessStepIds 和所需 parameters；执行器只会运行这些业务节点映射的 DOM 动作。如果需要同一个技能的后续业务节点，也可以再次选择该技能。列表/统计与详情等分支必须以用户真正要的结果、业务节点、当前 DOM 和截图证据为依据，不能把录制轨迹中的示例点击当成固定目标。只有确实缺少用户无法推断的关键信息时才返回 clarify。不要重复执行已经完成且没有新信息的技能，不要因为页面内容为空就盲目重试。平台领域内应由你自己归纳最终答案；只有确实需要跨领域协作时才设置 needsCollaboration=true，并给出简短原因和后续成员可执行的 collaborationBrief，系统会自动保存完整证据到当前任务临时目录。只返回 JSON：{\"intent\":\"execute|answer|clarify\",\"skillId\":\"execute 时填写\",\"confidence\":0到1,\"needsCollaboration\":true或false,\"collaborationReason\":\"需要跨领域协作时填写\",\"collaborationBrief\":\"给后续成员的简短工作说明\",\"businessStepIds\":[\"业务节点ID\"],\"targetText\":\"需要动态匹配的条目文本，没有则省略\",\"targetStepIndex\":底层动态目标动作序号，没有则省略,\"parameters\":{},\"reply\":\"answer 或 clarify 时的自然语言\"}。`;
    const loopGuidance = '字段判断规则：当前集合页没有用户回答所必需的字段时，必须进入匹配记录的详情；集合页字段已经足够时则直接整理结果。动态记录的 targetText 必须依据当前用户目标和页面证据确定，严禁复用录制示例条目、固定行号或示例 URL。';
    let decision: OperationLoopDecision;
    try {
      const loopImages: Uint8Array[] = [];
      const session = this.sessions.get(context.platformId);
      if (session && this.modelSupportsVision(platform.modelProfileId)) {
        try { loopImages.push((await session.view.webContents.capturePage()).toPNG()); } catch { /* visual context is optional */ }
      }
      const generateDecision = () => loopImages.length > 0
        ? gateway.generateObjectWithImages<OperationLoopDecision>('reasoning', `${prompt}\n${loopGuidance}`, loopImages, '你是网页操作结果规划器。结合当前页面截图和文本证据判断是否已经得到答案，或者选择下一项最小必要操作。')
        : gateway.generateObject<OperationLoopDecision>('reasoning', [{ role: 'user', content: `${prompt}\n${loopGuidance}` }], '你是操作智能体的结果判断器。先阅读当前页面证据，再决定总结、继续执行还是询问用户。不要把技能执行过程当成最终答案。');
      decision = await gateway.runWithModelProfileSnapshot(
        JSON.stringify({ profileId: platform.modelProfileId, parameters: { temperature: platform.temperature } }),
        generateDecision,
      );
    } catch (error) {
      getLogger(this.studioRoot)?.warn({ err: error, platformId: context.platformId, runId }, '操作技能结果判断失败');
      deliver(this.fallbackOperationAnswer(snapshot, workflow.name), 'answer', { loopDepth: context.depth, fallback: true });
      return;
    }

    // A planner may correctly open a collection page but omit the next
    // read-list node in its first decision. Do not present the portal shell as
    // the answer when the user's request requires data and the skill still has
    // an uncompleted collection/detail/result node.
    if (decision.intent === 'answer') {
      const fullWorkflow = this.listSkills(context.platformId, false, true)
        .find((candidate) => String(candidate.id) === workflow.id)?.workflow as OperationWorkflow | null;
      const selectedHasResult = (workflow.plan?.businessSteps ?? []).some(isResultBearingBusinessStep);
      const completed = context.completedStepIndexes?.[workflow.id] ?? [];
      const nextResult = !selectedHasResult
        ? nextResultBusinessStepId(fullWorkflow, context.instruction, completed)
        : undefined;
      if (nextResult && context.depth < 6) {
        const continuedDecision = { ...decision };
        delete continuedDecision.reply;
        decision = {
          ...continuedDecision,
          intent: 'execute',
          skillId: workflow.id,
          confidence: Math.max(decision.confidence ?? 0, 0.75),
          businessStepIds: [nextResult],
        };
      }
    }
    if (decision.intent === 'answer') {
      let reply = decision.reply?.trim() || this.fallbackOperationAnswer(snapshot, workflow.name);
      let collaborationFile: string | null = null;
      const needsCollaboration = decision.needsCollaboration === true || Boolean(decision.collaborationReason?.trim());
      if (needsCollaboration) {
        try {
          collaborationFile = await this.saveCollaborationEvidence(context, workflow, runId, snapshot, decision);
        } catch (error) {
          getLogger(this.studioRoot)?.warn({ err: error, platformId: context.platformId, runId }, '操作协作证据保存失败');
        }
        if (collaborationFile) {
          reply = `${reply}\n\n已将完整页面证据保存到当前任务临时文件“${collaborationFile}”，供后续协作成员读取。`;
        }
      }
      deliver(reply, 'answer', {
        loopDepth: context.depth,
        ...(needsCollaboration ? { needsCollaboration: true } : {}),
        ...(decision.collaborationReason?.trim() ? { collaborationReason: decision.collaborationReason.trim() } : {}),
        ...(collaborationFile ? { collaborationFile } : {}),
      });
      return;
    }
    if (decision.intent === 'clarify') {
      deliver(decision.reply?.trim() || '我已经完成当前可执行步骤，但还缺少一个无法从页面确认的关键信息，请补充后我再继续。', 'clarify', { loopDepth: context.depth, requiresUserResponse: true });
      return;
    }
    const requestedNextIndexes = Array.isArray(decision.stepIndexes)
      ? decision.stepIndexes.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
      : [];
    const completedNextIndexes = context.completedStepIndexes?.[String(decision.skillId)] ?? [];
    const sameSkillContinuation = decision.skillId === workflow.id
      && ((decision.businessStepIds?.length ?? 0) > 0 || requestedNextIndexes.some((index) => !completedNextIndexes.includes(index)));
    const next = skills.find((skill) => skill.id === decision.skillId && (!context.completedSkillIds.includes(skill.id) || sameSkillContinuation));
    if (!next || (decision.confidence ?? 0) < 0.62) {
      deliver(decision.reply?.trim() || this.fallbackOperationAnswer(snapshot, workflow.name), 'answer', { loopDepth: context.depth, fallback: !decision.reply });
      return;
    }
    const nextWorkflow = this.listSkills(context.platformId, false, true).find((skill) => skill.id === next.id)?.workflow as OperationWorkflow | null;
    const parameters = mergeWorkflowDefaults(nextWorkflow, decision.parameters && typeof decision.parameters === 'object' && !Array.isArray(decision.parameters) ? decision.parameters : {});
    if (typeof decision.targetText === 'string' && decision.targetText.trim()) parameters.__targetText = decision.targetText.trim();
    if (Number.isInteger(decision.targetStepIndex) && Number(decision.targetStepIndex) > 0) parameters.__targetStepIndex = Number(decision.targetStepIndex);
    else if (typeof decision.targetText === 'string' && decision.targetText.trim()) {
      const inferredTarget = inferDynamicTargetStepIndex(nextWorkflow, context.instruction);
      if (inferredTarget) parameters.__targetStepIndex = inferredTarget;
    }
    const missing = (nextWorkflow?.inputSchema.required ?? []).filter((key) => parameters[key] === undefined || parameters[key] === null || String(parameters[key]).trim() === '');
    if (missing.length > 0) {
      deliver(`继续执行“${next.name}”还需要：${missing.join('、')}。请补充后我再继续。`, 'clarify', { loopDepth: context.depth, skillId: next.id, missing, requiresUserResponse: true });
      return;
    }
    const child = await this.executeSkill({
      skillId: next.id,
      ownerAgentId: context.ownerAgentId,
      parameters,
      ...(Array.isArray(decision.businessStepIds) ? { businessStepIds: decision.businessStepIds } : {}),
      ...(Array.isArray(decision.stepIndexes) ? { stepIndexes: decision.stepIndexes } : {}),
      instruction: context.instruction,
      loopContext: {
        ...context,
        depth: context.depth + 1,
        completedSkillIds: [...context.completedSkillIds, next.id],
        completedStepIndexes: { ...(context.completedStepIndexes ?? {}) },
        lastSnapshot: snapshot,
      },
    });
    await this.awaitRun(child.runId);
  }

  private async executeStep(session: BrowserSession, workflow: OperationWorkflow, step: OperationWorkflowStep, input: Record<string, unknown>, allowVision = true): Promise<{ value?: string }> {
    if (step.action === 'navigate') {
      const target = substituteInputs(step.url, input);
      if (!target) throw new Error(`步骤“${step.title}”缺少网址`);
      const hostname = new URL(target).hostname;
      if (!workflow.allowedDomains.includes(hostname)) throw new Error(`技能不允许访问域名：${hostname}`);
      await session.view.webContents.loadURL(target);
      await this.waitForPageSettled(session, target, step.timeoutMs);
      return {};
    }
    if (step.action === 'wait') {
      await new Promise((resolve) => setTimeout(resolve, Math.min(step.timeoutMs, 10_000)));
      return {};
    }
    const value = substituteInputs(step.value, input);
    const recordedStepIndex = recordedStepNumber(step) ?? -1;
    const targetStepIndex = Number(input.__targetStepIndex ?? 0);
    const branchTargetStep = workflow.plan?.branches?.some((branch) => Number(branch.targetStepIndex) === recordedStepIndex) === true;
    const dynamicTargetStep = branchTargetStep || (targetStepIndex > 0 && targetStepIndex === recordedStepIndex);
    const targetText = dynamicTargetStep && typeof input.__targetText === 'string'
      ? String(input.__targetText).trim()
      : '';
    if (branchTargetStep && !targetText) {
      throw new Error(`步骤“${step.title}”缺少本次动态目标，已阻止回放录制时的示例条目`);
    }
    const payload = JSON.stringify({
      action: step.action,
      selectors: step.selectorCandidates ?? [],
      locator: step.locator ?? {},
      domInteraction: step.domInteraction,
      title: step.title,
      value,
      key: step.key,
      x: step.x,
      y: step.y,
      targetText,
    });
    const beforeUrl = session.view.webContents.getURL();
    let result: { ok?: boolean; value?: string; error?: string; diagnostics?: Record<string, unknown> };
    try {
      const operationScript = `(() => {
      const command = ${payload};
      const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (element) => {
        if (!(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const collectRoots = (root, seen = new Set()) => {
        if (!root || seen.has(root)) return [];
        seen.add(root);
        const result = [root];
        for (const frame of Array.from(root.querySelectorAll('iframe,frame'))) {
          try { result.push(...collectRoots(frame.contentDocument, seen)); } catch {}
        }
        return result;
      };
      const roots = collectRoots(document);
      const queryAll = (selector) => roots.flatMap((root) => { try { return Array.from(root.querySelectorAll(selector)); } catch { return []; } });
      const titleText = (String(command.title || '').match(/[“\"']([^”\"']+)[”\"']/) || [])[1] || '';
      const locator = command.locator || {};
      const wantedText = clean(command.targetText || locator.text || locator.accessibleName || titleText);
      const candidatesForSemantic = () => queryAll('a,button,input,textarea,select,option,label,summary,li,td,th,tr,div,span,[role],[data-testid]').filter(visible).slice(0, 6000);
      const exactLocatorMatch = (element, candidate) => {
        if (!(element instanceof Element) || !candidate) return false;
        return Boolean(
          (candidate.id && element.id === candidate.id)
          || (candidate.testId && element.getAttribute('data-testid') === candidate.testId)
          || (candidate.name && element.getAttribute('name') === candidate.name)
        );
      };
      const findByLocator = (candidate, rootElement) => {
        if (!candidate) return null;
        const withinRoot = (element) => !rootElement || element === rootElement || rootElement.contains(element);
        const pools = [];
        if (candidate.id) pools.push(...queryAll('[id="' + CSS.escape(String(candidate.id)) + '"]'));
        if (candidate.testId) pools.push(...queryAll('[data-testid="' + CSS.escape(String(candidate.testId)) + '"]'));
        if (candidate.name) pools.push(...queryAll('[name="' + CSS.escape(String(candidate.name)) + '"]'));
        return pools.find(withinRoot) || null;
      };
      const score = (element) => {
        const text = clean(element.innerText || element.textContent);
        const label = clean(element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('title'));
        const role = clean(element.getAttribute('role'));
        const tag = element.tagName.toLowerCase();
        const dynamicTarget = clean(command.targetText).toLowerCase();
        const normalizedText = text.toLowerCase();
        const normalizedLabel = label.toLowerCase();
        const rowText = clean(element.closest('tr')?.innerText || '').toLowerCase();
        let points = 0;
        if (dynamicTarget) {
          const exactText = normalizedText === dynamicTarget || normalizedLabel === dynamicTarget;
          const directText = normalizedText.includes(dynamicTarget) || normalizedLabel.includes(dynamicTarget);
          const rowMatch = rowText.includes(dynamicTarget);
          if (!directText && !rowMatch) return 0;
          points += exactText ? 64 : directText ? 46 : 24;
          if (rowMatch && tag === 'tr') points += 4;
        } else {
          if (locator.id && element.id === locator.id) points += 40;
          if (locator.testId && element.getAttribute('data-testid') === locator.testId) points += 40;
          if (locator.name && element.getAttribute('name') === locator.name) points += 32;
          if (locator.href && element instanceof HTMLAnchorElement && element.href === locator.href) points += 24;
        }
        if (locator.role && role === locator.role) points += 10;
        if (locator.tag && tag === locator.tag) points += 4;
        if (!dynamicTarget && locator.accessibleName && label === clean(locator.accessibleName)) points += 26;
        if (!dynamicTarget && wantedText && text === wantedText) points += 36;
        else if (!dynamicTarget && wantedText && text.includes(wantedText)) points += Math.max(10, 28 - Math.max(0, text.length - wantedText.length));
        if (!dynamicTarget && locator.ancestorText && clean(element.parentElement?.innerText || '').includes(clean(locator.ancestorText))) points += 4;
        if (points === 0 && wantedText && label === wantedText) points += 24;
        return points;
      };
      const find = () => {
        // A user-selected target must override the selector captured from the
        // recording; otherwise a detail workflow would always open the sample
        // row that happened to be clicked during recording.
        if (!command.targetText) {
          for (const selector of command.selectors) {
            for (const root of roots) {
              try {
                const element = root.querySelector(selector);
                const stableHiddenControl = command.action === 'click'
                  && element instanceof HTMLElement
                  && ['INPUT', 'BUTTON'].includes(element.tagName)
                  && exactLocatorMatch(element, locator);
                if (element && (visible(element) || stableHiddenControl)) return element;
              } catch {}
            }
          }
        }
        const semantic = candidatesForSemantic().map((element) => ({ element, points: score(element), text: clean(element.innerText || element.textContent) }))
          .filter((item) => item.points > 0)
          .sort((left, right) => right.points - left.points || left.text.length - right.text.length);
        const candidate = semantic[0]?.element || null;
        if (candidate && command.targetText && !['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'LABEL', 'SUMMARY'].includes(candidate.tagName)) {
          const direct = Array.from(candidate.querySelectorAll('a,button,input,[role="button"],td,span,div')).find((item) => clean(item.innerText || item.textContent).toLowerCase() === clean(command.targetText).toLowerCase());
          return direct?.closest('a,button,input,[role="button"],td,li') || candidate.closest('a,button,input,[role="button"],td,li') || candidate;
        }
        return candidate;
      };
      if (command.action === 'scroll') { scrollTo(command.x || 0, command.y || 0); return { ok: true }; }
      if (command.action === 'extract') return { ok: true, value: roots.map((root) => root.body?.innerText || '').join('\\n').replace(/\\s+/g, ' ').trim().slice(0, 20000) };
      const element = find();
      if (!element) return { ok: false, error: '未找到目标页面元素', diagnostics: { url: location.href, title: document.title, readyState: document.readyState, text: clean(document.body?.innerText).slice(0, 1200) } };
      element.scrollIntoView({ block: 'center', inline: 'center' });
      if (command.action === 'click') {
        const form = element instanceof HTMLFormElement ? element : element.closest('form');
        const interaction = command.domInteraction || {};
        const interactionLocators = [interaction.effective, interaction.source, ...(interaction.propagated || [])].filter(Boolean);
        const submitterLocator = interactionLocators.find((candidate) => {
          const tag = clean(candidate.tag).toLowerCase();
          const role = clean(candidate.role).toLowerCase();
          return ['input', 'button'].includes(tag) || role === 'button';
        });
        const submitter = form && submitterLocator ? findByLocator(submitterLocator, form) : null;
        const clickable = element.closest('a,button,input[type="submit"],input[type="button"],input[type="image"],[role="button"]');
        if (clickable && !(clickable instanceof HTMLFormElement)) {
          clickable.click();
        } else if (form && submitter instanceof HTMLElement) {
          // Keep the original submit control: its name/value and click hooks can
          // be required by the server and by page-side encryption code.
          submitter.click();
        } else if (form && (element instanceof HTMLFormElement || locator.role === 'form' || locator.tag === 'form')) {
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.submit();
        } else {
          element.click();
        }
      }
      if (command.action === 'fill') {
        if (element instanceof HTMLElement && element.isContentEditable) {
          element.textContent = command.value || '';
        } else {
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (setter) setter.call(element, command.value || ''); else element.value = command.value || '';
        }
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: command.value || '' }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (command.action === 'select') {
        if (element instanceof HTMLSelectElement) element.value = command.value || '';
        else if (element instanceof HTMLElement && element.isContentEditable) element.textContent = command.value || '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (command.action === 'press') {
        element.focus();
        element.dispatchEvent(new KeyboardEvent('keydown', { key: command.key || 'Enter', code: command.key || 'Enter', bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keyup', { key: command.key || 'Enter', code: command.key || 'Enter', bubbles: true }));
        if ((command.key || 'Enter') === 'Enter' && element.form) element.form.requestSubmit();
      }
      return { ok: true };
      })()`;
      result = await this.executeInOperationFrames(session, operationScript, step.frameUrl);
    } catch (error) {
      // A successful click can replace the renderer before executeJavaScript
      // returns. Treat an observed navigation as completion; otherwise retain
      // the real failing step instead of misreporting invalid credentials.
      await this.waitForPageSettled(session, beforeUrl, 2_500).catch(() => undefined);
      const afterUrl = session.view.webContents.getURL();
      if (['click', 'press'].includes(step.action) && afterUrl && afterUrl !== beforeUrl) return {};
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`步骤“${step.title}”的页面脚本执行异常：${reason}`, { cause: error });
    }
    if (!result?.ok) {
      const platform = this.getPlatform(workflow.platformId);
      if ((workflow.fallback.visionEnabled || this.modelSupportsVision(platform.modelProfileId)) && allowVision) {
        const visualSelector = await this.resolveSelectorWithVision(session, workflow, step, targetText);
        if (visualSelector) {
          return this.executeStep(session, workflow, { ...step, selectorCandidates: [visualSelector] }, input, false);
        }
      }
      throw new Error(result?.error || `步骤“${step.title}”执行失败`);
    }
    await this.waitForPageSettled(session, session.view.webContents.getURL(), Math.min(step.timeoutMs, 5_000));
    await new Promise((resolve) => setTimeout(resolve, 350));
    return typeof result?.value === 'string' && result.value.trim() ? { value: result.value } : {};
  }

  /**
   * Execute a recorded DOM action in the frame that owns the element.
   *
   * `webContents.executeJavaScript` only evaluates in the top document. Many
   * login pages put the actual form in a cross-origin iframe, where
   * `document.querySelector` from the top page cannot see it. Electron exposes
   * every live WebFrameMain, so probe the recorded frame first and then the
   * remaining frames. The action script itself is idempotent: it returns
   * `{ok:false}` when no element is found and only dispatches once on success.
   */
  private async executeInOperationFrames(
    session: BrowserSession,
    script: string,
    preferredFrameUrl?: string,
  ): Promise<{ ok?: boolean; value?: string; error?: string; diagnostics?: Record<string, unknown> }> {
    const mainFrame = session.view.webContents.mainFrame;
    const frames = Array.from(mainFrame.framesInSubtree).filter((frame): frame is WebFrameMain => !frame.detached && !frame.isDestroyed());
    const preferred = preferredFrameUrl?.trim().toLowerCase();
    frames.sort((left, right) => {
      if (!preferred) return left === mainFrame ? -1 : 0;
      const leftMatch = left.url.toLowerCase() === preferred || left.url.toLowerCase().startsWith(preferred);
      const rightMatch = right.url.toLowerCase() === preferred || right.url.toLowerCase().startsWith(preferred);
      return Number(rightMatch) - Number(leftMatch) || Number(left !== mainFrame) - Number(right !== mainFrame);
    });
    let lastResult: { ok?: boolean; value?: string; error?: string; diagnostics?: Record<string, unknown> } | null = null;
    let lastError: unknown = null;
    for (const frame of frames) {
      try {
        const value = await frame.executeJavaScript(script, true) as { ok?: boolean; value?: string; error?: string; diagnostics?: Record<string, unknown> };
        if (value?.ok) return value;
        if (value) lastResult = value;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastResult) return lastResult;
    if (lastError instanceof Error) throw lastError;
    return { ok: false, error: '未找到目标页面元素' };
  }

  private async waitForPageSettled(session: BrowserSession, expectedUrl: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + Math.max(500, Math.min(timeoutMs, 10_000));
    let stableReads = 0;
    while (Date.now() < deadline) {
      const state = await session.view.webContents.executeJavaScript('({ url: location.href, readyState: document.readyState })', true).catch(() => ({ url: session.view.webContents.getURL(), readyState: 'complete' }));
      const url = typeof state?.url === 'string' ? state.url : session.view.webContents.getURL();
      if (state?.readyState === 'complete' && (url !== expectedUrl || ++stableReads >= 2)) return;
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
  }

  private async isWorkflowComplete(session: BrowserSession, workflow: OperationWorkflow): Promise<boolean> {
    const target = workflow.success.finalUrl;
    if (!target) return false;
    const current = session.view.webContents.getURL();
    try {
      const expected = new URL(target);
      const actual = new URL(current);
      if (expected.origin !== actual.origin || expected.pathname !== actual.pathname) return false;
      if (expected.search && expected.search !== actual.search) return false;
      return true;
    } catch {
      return current === target;
    }
  }

  private async resolveSelectorWithVision(session: BrowserSession, workflow: OperationWorkflow, step: OperationWorkflowStep, targetText = ''): Promise<string | null> {
    const platform = this.getPlatform(workflow.platformId);
    const gateway = this.getGateway();
    if (!gateway || !platform.modelProfileId || !this.modelSupportsVision(platform.modelProfileId)) return null;
    const candidates = await session.view.webContents.executeJavaScript(`(() => {
      const collectRoots = (root, seen = new Set()) => {
        if (!root || seen.has(root)) return [];
        seen.add(root);
        const result = [root];
        for (const frame of Array.from(root.querySelectorAll('iframe,frame'))) {
          try { result.push(...collectRoots(frame.contentDocument, seen)); } catch {}
        }
        return result;
      };
      const roots = collectRoots(document);
      roots.forEach((root) => root.querySelectorAll('[data-kla-vision-index]').forEach((item) => item.removeAttribute('data-kla-vision-index')));
      const selectors = 'button,a,input,textarea,select,option,label,summary,li,div,span,[role],[data-testid],[contenteditable="true"]';
      return roots.flatMap((root) => Array.from(root.querySelectorAll(selectors))).filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        const interactive = ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'LABEL', 'SUMMARY'].includes(element.tagName)
          || Boolean(element.getAttribute('role')) || style.cursor === 'pointer';
        return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none' && (interactive || (text.length > 0 && text.length < 120));
      }).slice(0, 160).map((element, index) => {
        element.setAttribute('data-kla-vision-index', String(index));
        const rect = element.getBoundingClientRect();
        return {
          index,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || '',
          name: element.getAttribute('aria-label') || element.getAttribute('name') || element.getAttribute('placeholder') || element.getAttribute('title') || '',
          text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        };
      });
    })()`, true) as Array<{ index: number; tag: string; role: string; name: string; text: string; rect: Record<string, number> }>;
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const screenshot = await session.view.webContents.capturePage();
    const referenceImages = [screenshot.toPNG()];
    const recordingReference = await this.findRecordingScreenshot(workflow, step);
    if (recordingReference) {
      try { referenceImages.push(await readFile(join(this.studioRoot, recordingReference))); } catch { /* recording reference is optional */ }
    }
    try {
      const choice = await gateway.runWithModelProfileSnapshot(
        JSON.stringify({ profileId: platform.modelProfileId, parameters: { temperature: 0 } }),
        () => gateway.generateObjectWithImages<{ candidateIndex?: number; confidence?: number; reason?: string }>(
          'reasoning',
          `DOM 定位失效。请结合当前页面截图、录制时参考截图（如果提供）以及候选元素，选择最符合步骤“${targetText || step.title}”的唯一元素。动作类型：${step.action}。${targetText ? `本次动态目标是“${targetText}”；录制截图中的其他条目仅是交互示例，禁止选择。` : ''}候选：${JSON.stringify(candidates)}。如果当前页面已经完成该步骤、找不到本次动态目标或没有足够证据，返回 candidateIndex=-1 且 confidence 低于 0.6。只返回 JSON：{"candidateIndex":数字,"confidence":0到1,"reason":"简短原因"}。`,
          referenceImages,
          '你是网页操作定位器。优先依据当前页面真实 DOM 候选和录制截图对照，只能从候选元素中选择，不得生成坐标或虚构元素。',
        ),
      );
      if (typeof choice.candidateIndex !== 'number' || (choice.confidence ?? 0) < 0.6 || !candidates.some((item) => item.index === choice.candidateIndex)) return null;
      return `[data-kla-vision-index="${choice.candidateIndex}"]`;
    } catch (error) {
      getLogger(this.studioRoot)?.warn({ err: error, platformId: workflow.platformId, stepId: step.id }, '操作技能视觉定位兜底失败');
      return null;
    }
  }

  private async findRecordingScreenshot(workflow: OperationWorkflow, step: OperationWorkflowStep): Promise<string | null> {
    if (step.recordingScreenshotRelPath) return step.recordingScreenshotRelPath;
    try {
      const skill = this.getSkill(workflow.id);
      if (!skill.recordingSessionId) return null;
      const events = (await this.readTrace(skill.recordingSessionId)).filter((event) => event.type !== 'network-response');
      const stepNumber = recordedStepNumber(step);
      if (stepNumber === null) return null;
      const index = stepNumber - 1;
      return events[index]?.screenshotRelPath ?? null;
    } catch {
      return null;
    }
  }

  cancelRun(runId: string): void {
    const row = this.db.prepare('SELECT status FROM operation_skill_runs WHERE id = ?').get(runId) as { status: string } | undefined;
    if (!row || !['queued', 'running'].includes(row.status)) return;
    this.cancelledRuns.add(runId);
    this.db.prepare("UPDATE operation_skill_runs SET status = 'cancelling', updated_at = ? WHERE id = ?").run(nowIso(), runId);
    this.emitRunEvent(runId, 'run.cancelling', null, {});
  }

  getRun(runId: string): Record<string, unknown> | null {
    const run = this.db.prepare(
      `SELECT id, skill_id as skillId, platform_id as platformId, owner_agent_id as ownerAgentId, status,
              current_step_index as currentStepIndex, input_json as inputJson, output_json as outputJson,
              error_message as errorMessage, started_at as startedAt, completed_at as completedAt,
              created_at as createdAt, updated_at as updatedAt FROM operation_skill_runs WHERE id = ?`,
    ).get(runId) as Record<string, unknown> & { inputJson?: string; outputJson?: string } | undefined;
    return run ? { ...run, input: safeJson(run.inputJson, {}), output: safeJson(run.outputJson, null), events: this.listRunEvents(runId) } : null;
  }

  listRuns(platformId: string, limit = 50): Array<Record<string, unknown>> {
    const rows = this.db.prepare(
      `SELECT r.id, r.skill_id as skillId, s.name as skillName, r.platform_id as platformId, r.status,
              r.current_step_index as currentStepIndex, r.output_json as outputJson, r.error_message as errorMessage,
              r.started_at as startedAt, r.completed_at as completedAt, r.created_at as createdAt, r.updated_at as updatedAt
       FROM operation_skill_runs r JOIN operation_skills s ON s.id = r.skill_id
       WHERE r.platform_id = ? ORDER BY r.created_at DESC LIMIT ?`,
    ).all(platformId, Math.max(1, Math.min(200, limit))) as Array<Record<string, unknown> & { id: string; outputJson?: string }>;
    return rows.map((row) => ({ ...row, output: safeJson(row.outputJson, null), events: this.listRunEvents(row.id) }));
  }

  private listRunEvents(runId: string): Array<Record<string, unknown>> {
    return (this.db.prepare(
      'SELECT id, sequence, type, step_id as stepId, detail_json as detailJson, created_at as createdAt FROM operation_skill_run_events WHERE run_id = ? ORDER BY sequence',
    ).all(runId) as Array<Record<string, unknown> & { detailJson?: string }>).map((event) => ({ ...event, detail: safeJson(event.detailJson, {}) }));
  }

  private emitRunEvent(runId: string, type: string, stepId: string | null, detail: Record<string, unknown>): void {
    const run = this.db.prepare('SELECT platform_id as platformId, skill_id as skillId FROM operation_skill_runs WHERE id = ?').get(runId) as { platformId: string; skillId: string };
    const sequence = ((this.db.prepare('SELECT MAX(sequence) as value FROM operation_skill_run_events WHERE run_id = ?').get(runId) as { value: number | null }).value ?? 0) + 1;
    const createdAt = nowIso();
    this.db.prepare('INSERT INTO operation_skill_run_events (id, run_id, sequence, type, step_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), runId, sequence, type, stepId, JSON.stringify(detail), createdAt);
    this.dispatch({ type: 'operation.run', platformId: run.platformId, skillId: run.skillId, runId, eventType: type, stepId, detail, sequence, createdAt });
  }

  revokePlatform(platformId: string): void {
    const now = nowIso();
    const skillRows = this.db.prepare('SELECT id, version FROM operation_skills WHERE platform_id = ?').all(platformId) as Array<{ id: string; version: string }>;
    this.db.transaction(() => {
      this.db.prepare("UPDATE operation_platforms SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?").run(now, now, platformId);
      this.db.prepare("UPDATE operation_skills SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE platform_id = ? AND status != 'revoked'").run(now, now, platformId);
      // 群聊中的操作代理只是该平台的轻量挂载 Profile。平台注销后同步停用
      // 这些挂载，避免它继续出现在成员池或被统筹委派。
      this.db.prepare(
        `UPDATE agent_profiles SET enabled = 0, delegatable = 0, updated_at = ?
         WHERE definition_id = (SELECT owner_agent_id FROM operation_platforms WHERE id = ?)`
      ).run(now, platformId);
      const disable = this.db.prepare('UPDATE skill_packages SET enabled = 0, updated_at = ? WHERE id = ? AND version = ?');
      for (const skill of skillRows) disable.run(now, skill.id, skill.version);
      this.db.prepare("UPDATE operation_skill_runs SET status = 'cancelled', error_message = '操作平台已注销', completed_at = ?, updated_at = ? WHERE platform_id = ? AND status IN ('queued','running','cancelling')").run(now, now, platformId);
    })();
    for (const run of this.db.prepare("SELECT id FROM operation_skill_runs WHERE platform_id = ? AND status = 'cancelled'").all(platformId) as Array<{ id: string }>) this.cancelledRuns.add(run.id);
    const session = this.sessions.get(platformId);
    if (session) {
      session.view.setVisible(false);
      session.host.contentView.removeChildView(session.view);
      session.view.webContents.close();
      this.sessions.delete(platformId);
    }
    this.dispatch({ type: 'operation.platform', platformId, status: 'revoked' });
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      if (!session.host.isDestroyed()) session.host.contentView.removeChildView(session.view);
      if (!session.view.webContents.isDestroyed()) session.view.webContents.close();
    }
    this.sessions.clear();
  }
}
