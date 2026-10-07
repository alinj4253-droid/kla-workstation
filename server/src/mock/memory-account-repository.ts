import { randomUUID } from 'node:crypto';
import type {
  AccountRepository,
  AgentProfile,
  Artifact,
  Conversation,
  ConversationRun,
  Identity,
  Message,
  Project,
  Session,
  UserAccount,
} from '../repositories/types.js';

type StoredUser = UserAccount & { password: string };
type StoredProject = Project & { seq: number };
type StoredConversation = Conversation & { seq: number };
type StoredMessage = Message & { seq: number };
type StoredAgent = AgentProfile & { identityId: string; seq: number };
type StoredRun = ConversationRun;
type StoredArtifact = Artifact & { identityId: string; seq: number };

type StoredOrganization = { id: string; name: string; inviteCode: string; status: 'active' | 'disabled' };

export const DEMO_ACCOUNT = { identifier: 'demo@kla.local', password: 'demo123456' } as const;

/**
 * Mock 模式的内存账号仓库：接口与 PostgresAccountRepository 完全一致，
 * 重启即清空，仅供本地开发与契约联调，不承载真实数据。
 */
export class MemoryAccountRepository implements AccountRepository {
  private seq = 0;
  private readonly users = new Map<string, StoredUser>();
  private readonly identities = new Map<string, Identity>();
  private readonly sessions = new Map<string, Session>();
  private readonly organizations = new Map<string, StoredOrganization>();
  private readonly projects: StoredProject[] = [];
  private readonly conversations: StoredConversation[] = [];
  private readonly messages: StoredMessage[] = [];
  private readonly agents: StoredAgent[] = [];
  private readonly runs: StoredRun[] = [];
  private readonly artifacts: StoredArtifact[] = [];

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq.toString(36).padStart(6, '0')}`;
  }

  /** 预置演示账号，便于免注册联调。 */
  seedDemoAccount(): void {
    const existing = [...this.users.values()].find((user) => user.email === DEMO_ACCOUNT.identifier);
    if (existing) return;
    this.register({ email: DEMO_ACCOUNT.identifier, password: DEMO_ACCOUNT.password, nickname: '演示用户' });
  }

  async getUser(id: string): Promise<UserAccount | null> {
    const user = this.users.get(id);
    return user ? { id: user.id, email: user.email, phone: user.phone, nickname: user.nickname, status: user.status } : null;
  }

  async listIdentities(userId: string): Promise<Identity[]> {
    return [...this.identities.values()]
      .filter((identity) => identity.userId === userId)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  }

  async register(input: { email?: string; phone?: string; password: string; nickname: string }): Promise<{ user: UserAccount; identity: Identity }> {
    const duplicated = [...this.users.values()].some((user) => (input.email && user.email === input.email) || (input.phone && user.phone === input.phone));
    if (duplicated) throw new Error('duplicate key value violates unique constraint "users_email_key"');
    const user: StoredUser = { id: this.nextId('usr'), email: input.email ?? null, phone: input.phone ?? null, nickname: input.nickname, status: 'active', password: input.password };
    this.users.set(user.id, user);
    const identity = this.createIdentity(user.id, 'personal', input.nickname, null, true);
    this.seedIdentityWorkspace(identity);
    const project = this.createProjectRow(identity.id, '我的协作项目');
    for (const [name, role, type] of [
      ['统筹智能体', '识别目标、规划协作任务并调度执行智能体', 'official'],
      ['本地执行智能体', '检索知识、编写材料并交付成果文件', 'official'],
    ] as const) this.createAgentRow(identity.id, name, role, type);
    this.createConversationRow(project.id, '默认协作群聊');
    return { user: this.toUser(user), identity };
  }

  async authenticate(identifier: string, password: string): Promise<{ user: UserAccount; identity: Identity } | null> {
    const user = [...this.users.values()].find((item) => item.email === identifier || item.phone === identifier);
    if (!user || user.status !== 'active' || user.password !== password) return null;
    const identity = (await this.listIdentities(user.id)).find((item) => item.isDefault && item.status === 'active') ?? (await this.listIdentities(user.id)).find((item) => item.status === 'active');
    return identity ? { user: this.toUser(user), identity } : null;
  }

  async createSession(userId: string): Promise<Session> {
    const session: Session = { id: this.nextId('ses'), userId, accessToken: randomUUID(), refreshToken: randomUUID(), expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString() };
    this.sessions.set(session.accessToken, session);
    return session;
  }

  async getSession(token: string): Promise<Session | null> {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() <= Date.now()) { this.sessions.delete(token); return null; }
    return session;
  }

  async revokeSession(token: string): Promise<void> { this.sessions.delete(token); }

  async listProjects(identityId: string): Promise<Project[]> {
    return this.projects.filter((project) => project.ownerIdentityId === identityId).sort((a, b) => b.seq - a.seq);
  }

  async listAllConversations(identityId: string): Promise<Array<Conversation & { projectName: string }>> {
    const owned = new Set((await this.listProjects(identityId)).map((project) => project.id));
    return this.conversations
      .filter((conversation) => owned.has(conversation.projectId))
      .sort((a, b) => b.seq - a.seq)
      .map((conversation) => ({ ...conversation, projectName: this.projects.find((project) => project.id === conversation.projectId)?.name ?? '' }));
  }

  async createProject(identityId: string, name: string): Promise<Project> {
    return this.createProjectRow(identityId, name);
  }

  async listConversations(projectId?: string, identityId?: string): Promise<Conversation[]> {
    const owned = identityId ? new Set(this.projects.filter((project) => project.ownerIdentityId === identityId).map((project) => project.id)) : null;
    return this.conversations
      .filter((conversation) => (!projectId || conversation.projectId === projectId) && (!owned || owned.has(conversation.projectId)))
      .sort((a, b) => b.seq - a.seq);
  }

  async createConversation(projectId: string, name: string): Promise<Conversation> {
    return this.createConversationRow(projectId, name);
  }

  async listMessages(conversationId: string): Promise<Message[]> {
    return this.messages.filter((message) => message.conversationId === conversationId).sort((a, b) => a.seq - b.seq);
  }

  async createMessage(conversationId: string, senderId: string, text: string): Promise<Message> {
    this.seq += 1;
    const message: StoredMessage = { id: this.nextId('msg'), conversationId, senderId, senderType: 'user', senderName: null, kind: 'text', text, metadata: {}, createdAt: new Date().toISOString(), seq: this.seq };
    this.messages.push(message);
    return message;
  }

  async createAgentMessage(conversationId: string, agentName: string, text: string, metadata: Record<string, unknown> = {}): Promise<Message> {
    const conversation = this.conversations.find((item) => item.id === conversationId);
    const project = this.projects.find((item) => item.id === conversation?.projectId);
    this.seq += 1;
    const message: StoredMessage = { id: this.nextId('msg'), conversationId, senderId: project?.ownerIdentityId ?? 'mock-agent', senderType: 'agent', senderName: agentName, kind: 'text', text, metadata, createdAt: new Date().toISOString(), seq: this.seq };
    this.messages.push(message);
    return message;
  }

  async listAgents(identityId: string): Promise<AgentProfile[]> {
    return this.agents
      .filter((agent) => agent.identityId === identityId && agent.enabled)
      .sort((a, b) => a.seq - b.seq)
      .map(({ identityId: _identityId, seq: _seq, ...profile }) => profile);
  }

  async listConversationRuns(conversationId: string): Promise<ConversationRun[]> {
    return this.runs.filter((run) => run.conversationId === conversationId).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 20);
  }

  async createRun(conversationId: string, triggerMessageId: string, mode: string): Promise<ConversationRun> {
    const now = new Date().toISOString();
    const run: StoredRun = { id: this.nextId('run'), conversationId, triggerMessageId, status: 'running', mode, currentAgent: '统筹智能体', result: {}, createdAt: now, updatedAt: now };
    this.runs.push(run);
    return run;
  }

  async completeRun(runId: string, status: string, agentName?: string, result: Record<string, unknown> = {}): Promise<ConversationRun> {
    const run = this.runs.find((item) => item.id === runId);
    if (!run) throw new Error(`RUN_NOT_FOUND: ${runId}`);
    run.status = status;
    run.currentAgent = agentName ?? run.currentAgent;
    run.result = result;
    run.updatedAt = new Date().toISOString();
    return run;
  }

  async createArtifact(identityId: string, conversationId: string, name: string, mimeType: string, content: string): Promise<Artifact> {
    this.seq += 1;
    const artifact: StoredArtifact = { id: this.nextId('art'), conversationId, name, mimeType, content, sizeBytes: Buffer.byteLength(content), createdAt: new Date().toISOString(), identityId, seq: this.seq };
    this.artifacts.push(artifact);
    return artifact;
  }

  async listArtifacts(identityId: string, conversationId?: string): Promise<Artifact[]> {
    return this.artifacts
      .filter((artifact) => artifact.identityId === identityId && (!conversationId || artifact.conversationId === conversationId))
      .sort((a, b) => b.seq - a.seq);
  }

  async getArtifact(identityId: string, artifactId: string): Promise<Artifact | null> {
    return this.artifacts.find((artifact) => artifact.identityId === identityId && artifact.id === artifactId) ?? null;
  }

  async createOrganization(userId: string, name: string, licenseNumber: string): Promise<Identity> {
    const personal = [...this.identities.values()].find((identity) => identity.userId === userId && identity.type === 'personal');
    if (!personal) throw new Error('PERSONAL_IDENTITY_REQUIRED');
    const organization: StoredOrganization = { id: this.nextId('org'), name, inviteCode: randomUUID().slice(0, 8).toUpperCase(), status: 'active' };
    this.organizations.set(organization.id, organization);
    const identity = this.createIdentity(userId, 'enterprise', name, organization.id, false);
    this.seedIdentityWorkspace(identity, `${name}企业工作区`, 'enterprise');
    return identity;
  }

  async joinOrganization(userId: string, inviteCode: string): Promise<Identity | null> {
    const organization = [...this.organizations.values()].find((item) => item.inviteCode === inviteCode.trim().toUpperCase() && item.status === 'active');
    if (!organization) return null;
    const identity = this.createIdentity(userId, 'enterprise', organization.name, organization.id, false);
    this.seedIdentityWorkspace(identity, `${organization.name}企业工作区`, 'enterprise');
    return identity;
  }

  async activateIdentity(userId: string, identityId: string): Promise<Identity | null> {
    const identity = this.identities.get(identityId);
    if (!identity || identity.userId !== userId || identity.status !== 'active') return null;
    for (const item of this.identities.values()) if (item.userId === userId) item.isDefault = item.id === identityId;
    return identity;
  }

  /** 供 mock 联调与契约测试获取企业邀请码（真实系统由服务端另行分发）。 */
  getInviteCodeByName(name: string): string | null {
    return [...this.organizations.values()].find((item) => item.name === name)?.inviteCode ?? null;
  }

  /** 供 CatalogPool 查询的只读视图。 */
  getWorkspaceRows(identityId: string): Array<{ id: string; type: string; name: string; project_id: string | null }> {
    return this.workspaces.filter((workspace) => workspace.identityId === identityId).map(({ id, type, name, projectId }) => ({ id, type, name, project_id: projectId }));
  }

  getAgentRows(identityId: string): Array<{ id: string; name: string; role: string; type: string; model_id: string | null; enabled: boolean; version: number }> {
    return this.agents.filter((agent) => agent.identityId === identityId).sort((a, b) => a.seq - b.seq).map(({ id, name, role, type, modelId, enabled }) => ({ id, name, role, type, model_id: modelId, enabled, version: 1 }));
  }

  findAgentRow(identityId: string, agentId: string): { id: string; name: string; role: string; type: string; model_id: string | null; enabled: boolean } | null {
    const agent = this.agents.find((item) => item.id === agentId && item.identityId === identityId);
    return agent ? { id: agent.id, name: agent.name, role: agent.role, type: agent.type, model_id: agent.modelId, enabled: agent.enabled } : null;
  }

  private workspaces: Array<{ id: string; identityId: string; type: 'personal' | 'enterprise'; name: string; projectId: string | null }> = [];

  private createIdentity(userId: string, type: Identity['type'], displayName: string, organizationId: string | null, isDefault: boolean): Identity {
    const identity: Identity = { id: this.nextId('idy'), userId, type, displayName, organizationId, status: 'active', isDefault };
    if (isDefault) for (const item of this.identities.values()) if (item.userId === userId) item.isDefault = false;
    this.identities.set(identity.id, identity);
    return identity;
  }

  private seedIdentityWorkspace(identity: Identity, name = `${identity.displayName}的个人工作区`, type: 'personal' | 'enterprise' = 'personal'): void {
    this.workspaces.push({ id: this.nextId('wsp'), identityId: identity.id, type, name, projectId: null });
  }

  private createProjectRow(identityId: string, name: string): StoredProject {
    this.seq += 1;
    const project: StoredProject = { id: this.nextId('prj'), name, ownerIdentityId: identityId, createdAt: new Date().toISOString(), seq: this.seq };
    this.projects.push(project);
    return project;
  }

  private createConversationRow(projectId: string, name: string): StoredConversation {
    this.seq += 1;
    const conversation: StoredConversation = { id: this.nextId('cnv'), projectId, name, createdAt: new Date().toISOString(), seq: this.seq };
    this.conversations.push(conversation);
    return conversation;
  }

  private createAgentRow(identityId: string, name: string, role: string, type: string, modelId: string | null = null): StoredAgent {
    this.seq += 1;
    const agent: StoredAgent = { id: this.nextId('agt'), name, role, type, modelId, enabled: true, identityId, seq: this.seq };
    this.agents.push(agent);
    return agent;
  }

  private toUser(user: StoredUser): UserAccount {
    return { id: user.id, email: user.email, phone: user.phone, nickname: user.nickname, status: user.status };
  }
}
