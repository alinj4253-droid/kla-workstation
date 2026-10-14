import { randomUUID } from 'node:crypto';
import type {
  AccountRepository,
  AgentProfile,
  Artifact,
  Conversation,
  ConversationRun,
  Identity,
  Message,
  Organization,
  Project,
  Session,
  UserAccount,
} from '../repositories/types.js';

type StoredUser = UserAccount & { password: string };
type StoredSession = Session & { userAgent: string | null; ipAddress: string | null };
type StoredProject = Project & { seq: number };
type StoredConversation = Conversation & { seq: number };
type StoredMessage = Message & { seq: number };
type StoredAgent = AgentProfile & { identityId: string; seq: number };
type StoredRun = ConversationRun;
type StoredArtifact = Artifact & { identityId: string; seq: number };

type StoredOrganization = { id: string; name: string; inviteCode: string; status: 'active' | 'disabled' };
type MockPermissionCode = 'read' | 'write' | 'execute' | 'manage' | 'export';
type StoredRole = { id: string; organizationId: string; name: string; description: string; isSystem: boolean; permissions: Set<MockPermissionCode> };

const ALL_PERMISSIONS: MockPermissionCode[] = ['read', 'write', 'execute', 'manage', 'export'];

export const DEMO_ACCOUNT = { identifier: 'demo@kla.local', password: 'demo123456' } as const;

/**
 * Mock 模式的内存账号仓库：接口与 PostgresAccountRepository 完全一致，
 * 重启即清空，仅供本地开发与契约联调，不承载真实数据。
 */
export class MemoryAccountRepository implements AccountRepository {
  private seq = 0;
  private readonly users = new Map<string, StoredUser>();
  private readonly identities = new Map<string, Identity>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly organizations = new Map<string, StoredOrganization>();
  private readonly identityPermissions = new Map<string, Set<MockPermissionCode>>();
  private readonly roles = new Map<string, StoredRole>();
  private readonly identityRoles = new Map<string, Set<string>>();
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

  async createSession(userId: string, metadata: { deviceId?: string; deviceName?: string; userAgent?: string; ipAddress?: string } = {}): Promise<Session> {
    const session: StoredSession = { id: this.nextId('ses'), userId, accessToken: randomUUID(), refreshToken: randomUUID(), expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(), deviceId: metadata.deviceId ?? null, deviceName: metadata.deviceName ?? null, userAgent: metadata.userAgent ?? null, ipAddress: metadata.ipAddress ?? null, lastSeenAt: new Date().toISOString() };
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

  async revokeSessionByRefreshToken(refreshToken: string): Promise<void> {
    for (const [accessToken, session] of this.sessions) {
      if (session.refreshToken === refreshToken) this.sessions.delete(accessToken);
    }
  }

  async rotateSession(refreshToken: string, metadata: { deviceId?: string; deviceName?: string; userAgent?: string; ipAddress?: string } = {}): Promise<Session | null> {
    const current = [...this.sessions.values()].find((session) => session.refreshToken === refreshToken && new Date(session.expiresAt).getTime() > Date.now());
    if (!current) return null;
    this.sessions.delete(current.accessToken);
    const next: StoredSession = { id: current.id, userId: current.userId, accessToken: randomUUID(), refreshToken: randomUUID(), expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(), deviceId: metadata.deviceId ?? current.deviceId, deviceName: metadata.deviceName ?? current.deviceName, userAgent: metadata.userAgent ?? current.userAgent, ipAddress: metadata.ipAddress ?? current.ipAddress, lastSeenAt: new Date().toISOString() };
    this.sessions.set(next.accessToken, next);
    return next;
  }

  async listSessions(userId: string): Promise<Array<{ id: string; deviceId: string | null; deviceName: string | null; userAgent: string | null; ipAddress: string | null; expiresAt: string; lastSeenAt: string; current: boolean }>> {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId && new Date(session.expiresAt).getTime() > Date.now())
      .map((session) => ({ id: session.id, deviceId: session.deviceId ?? null, deviceName: session.deviceName ?? null, userAgent: session.userAgent ?? null, ipAddress: session.ipAddress ?? null, expiresAt: session.expiresAt, lastSeenAt: session.lastSeenAt ?? session.expiresAt, current: false }));
  }

  async revokeAllSessions(userId: string, exceptSessionId?: string): Promise<void> {
    for (const [accessToken, session] of this.sessions) {
      if (session.userId === userId && session.id !== exceptSessionId) this.sessions.delete(accessToken);
    }
  }

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

  async renameProject(identityId: string, projectId: string, name: string): Promise<Project | null> {
    const project = this.projects.find((item) => item.id === projectId && item.ownerIdentityId === identityId);
    if (!project) return null;
    project.name = name;
    return { id: project.id, name: project.name, ownerIdentityId: project.ownerIdentityId, createdAt: project.createdAt };
  }

  async deleteProject(identityId: string, projectId: string): Promise<boolean> {
    const index = this.projects.findIndex((item) => item.id === projectId && item.ownerIdentityId === identityId);
    if (index === -1) return false;
    this.projects.splice(index, 1);
    const removedConversations = new Set(this.conversations.filter((item) => item.projectId === projectId).map((item) => item.id));
    for (let i = this.conversations.length - 1; i >= 0; i -= 1) { if (this.conversations[i].projectId === projectId) this.conversations.splice(i, 1); }
    for (let i = this.messages.length - 1; i >= 0; i -= 1) { if (removedConversations.has(this.messages[i].conversationId)) this.messages.splice(i, 1); }
    return true;
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

  async ensureStandaloneProject(identityId: string): Promise<Project> {
    const existing = this.projects.find((project) => project.ownerIdentityId === identityId && project.kind === 'standalone');
    if (existing) return existing;
    return this.createProjectRow(identityId, '独立群组', 'standalone');
  }

  async renameConversation(identityId: string, conversationId: string, name: string): Promise<Conversation | null> {
    const owned = new Set((await this.listProjects(identityId)).map((project) => project.id));
    const conversation = this.conversations.find((item) => item.id === conversationId && owned.has(item.projectId));
    if (!conversation) return null;
    conversation.name = name;
    return conversation;
  }

  async moveConversation(identityId: string, conversationId: string, targetProjectId: string): Promise<Conversation | null> {
    const owned = new Set((await this.listProjects(identityId)).map((project) => project.id));
    const conversation = this.conversations.find((item) => item.id === conversationId && owned.has(item.projectId));
    if (!conversation || !owned.has(targetProjectId)) return null;
    conversation.projectId = targetProjectId;
    return conversation;
  }

  async deleteConversation(identityId: string, conversationId: string): Promise<boolean> {
    const owned = new Set((await this.listProjects(identityId)).map((project) => project.id));
    const index = this.conversations.findIndex((item) => item.id === conversationId && owned.has(item.projectId));
    if (index === -1) return false;
    this.conversations.splice(index, 1);
    for (let i = this.messages.length - 1; i >= 0; i -= 1) { if (this.messages[i].conversationId === conversationId) this.messages.splice(i, 1); }
    for (let i = this.runs.length - 1; i >= 0; i -= 1) { if (this.runs[i].conversationId === conversationId) this.runs.splice(i, 1); }
    for (const artifact of this.artifacts) { if (artifact.conversationId === conversationId) artifact.conversationId = null; }
    return true;
  }

  async listMessages(conversationId: string): Promise<Message[]> {
    return this.messages.filter((message) => message.conversationId === conversationId).sort((a, b) => a.seq - b.seq);
  }

  async createMessage(conversationId: string, senderId: string, text: string, metadata: Record<string, unknown> = {}): Promise<Message> {
    this.seq += 1;
    const message: StoredMessage = { id: this.nextId('msg'), conversationId, senderId, senderType: 'user', senderName: null, kind: 'text', text, metadata, createdAt: new Date().toISOString(), seq: this.seq };
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

  async createRun(conversationId: string, triggerMessageId: string, mode: string, _leaseOwner?: string, executionAccess: 'approval' | 'full' = 'approval'): Promise<ConversationRun> {
    const now = new Date().toISOString();
    const run: StoredRun = { id: this.nextId('run'), conversationId, triggerMessageId, status: 'running', mode, executionAccess, currentAgent: '统筹智能体', result: {}, createdAt: now, updatedAt: now };
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
    identity.role = 'admin';
    const role = this.createRoleRow(organization.id, '管理员', '企业管理员', true, ALL_PERMISSIONS);
    this.identityRoles.set(identity.id, new Set([role.id]));
    this.seedIdentityWorkspace(identity, `${name}企业工作区`, 'enterprise');
    return identity;
  }

  async joinOrganization(userId: string, inviteCode: string): Promise<Identity | null> {
    const organization = [...this.organizations.values()].find((item) => item.inviteCode === inviteCode.trim().toUpperCase() && item.status === 'active');
    if (!organization) return null;
    const identity = this.createIdentity(userId, 'enterprise', organization.name, organization.id, false);
    const role = [...this.roles.values()].find((item) => item.organizationId === organization.id && item.name === '成员')
      ?? this.createRoleRow(organization.id, '成员', '企业成员', true, ['read', 'write', 'execute', 'export']);
    this.identityRoles.set(identity.id, new Set([role.id]));
    this.seedIdentityWorkspace(identity, `${organization.name}企业工作区`, 'enterprise');
    return identity;
  }

  async activateIdentity(userId: string, identityId: string): Promise<Identity | null> {
    const identity = this.identities.get(identityId);
    if (!identity || identity.userId !== userId || identity.status !== 'active') return null;
    for (const item of this.identities.values()) if (item.userId === userId) item.isDefault = item.id === identityId;
    return identity;
  }

  async getOrganization(orgId: string): Promise<Organization | null> {
    const organization = this.organizations.get(orgId);
    return organization ? { ...organization } : null;
  }

  async isOrganizationMember(userId: string, orgId: string): Promise<boolean> {
    return [...this.identities.values()].some(identity => identity.userId === userId && identity.organizationId === orgId && identity.type === 'enterprise' && identity.status === 'active');
  }

  /** 供 mock 联调与契约测试获取企业邀请码（真实系统由服务端另行分发）。 */
  getInviteCodeByName(name: string): string | null {
    return [...this.organizations.values()].find((item) => item.name === name)?.inviteCode ?? null;
  }

  /** Mock 权限与 PostgreSQL 权限迁移保持一致，供 CatalogPool 和契约测试使用。 */
  getPermissionCodes(identityId: string): MockPermissionCode[] {
    const identity = this.identities.get(identityId);
    if (!identity || identity.status !== 'active') return [];
    if (identity.type === 'personal') return [...ALL_PERMISSIONS];
    const roleIds = this.identityRoles.get(identityId) ?? new Set<string>();
    const codes = new Set<MockPermissionCode>();
    for (const roleId of roleIds) for (const code of this.roles.get(roleId)?.permissions ?? []) codes.add(code);
    return [...codes];
  }

  getOrganizationRow(id: string): { id: string; name: string; invite_code: string; status: string } | null {
    const organization = this.organizations.get(id);
    return organization ? { id: organization.id, name: organization.name, invite_code: organization.inviteCode, status: organization.status } : null;
  }

  getOrganizationRowsForUser(userId: string): Array<Record<string, unknown>> {
    return [...this.identities.values()]
      .filter((identity) => identity.userId === userId && identity.type === 'enterprise' && identity.organizationId)
      .flatMap((identity) => {
        const organization = this.organizations.get(identity.organizationId!);
        return organization ? [{ id: organization.id, name: organization.name, license_number: null, invite_code: organization.inviteCode, status: organization.status, created_at: new Date(0).toISOString(), identity_id: identity.id, identity_name: identity.displayName }] : [];
      });
  }

  getMemberRows(organizationId: string): Array<Record<string, unknown>> {
    return [...this.identities.values()]
      .filter((identity) => identity.organizationId === organizationId && identity.type === 'enterprise')
      .map((identity) => {
        const user = this.users.get(identity.userId);
        const roles = [...(this.identityRoles.get(identity.id) ?? [])].map((roleId) => {
          const role = this.roles.get(roleId);
          return role ? { id: role.id, name: role.name, description: role.description, isSystem: role.isSystem } : null;
        }).filter(Boolean);
        return { identity_id: identity.id, user_id: identity.userId, display_name: identity.displayName, status: identity.status, is_default: identity.isDefault, email: user?.email ?? null, phone: user?.phone ?? null, nickname: user?.nickname ?? null, roles };
      });
  }

  getRoleRows(organizationId: string): Array<Record<string, unknown>> {
    return [...this.roles.values()]
      .filter((role) => role.organizationId === organizationId)
      .map((role) => ({ id: role.id, name: role.name, description: role.description, is_system: role.isSystem, permissions: [...role.permissions].map((code) => ({ code, description: code })) }));
  }

  getPermissionRows(codes?: string[]): Array<Record<string, unknown>> {
    const selected = codes === undefined ? ALL_PERMISSIONS : ALL_PERMISSIONS.filter((code) => codes.includes(code));
    return selected.map((code) => ({ code, description: code }));
  }

  createMockRole(organizationId: string, name: string, description: string, permissions: string[]): StoredRole {
    const role = this.createRoleRow(organizationId, name, description, false, permissions.filter((code): code is MockPermissionCode => ALL_PERMISSIONS.includes(code as MockPermissionCode)));
    return role;
  }

  getRole(organizationId: string, roleId: string): StoredRole | null {
    const role = this.roles.get(roleId);
    return role?.organizationId === organizationId ? role : null;
  }

  updateMockRole(organizationId: string, roleId: string, update: { name?: string | null; description?: string | null }): StoredRole | null {
    const role = this.getRole(organizationId, roleId);
    if (!role) return null;
    if (update.name) role.name = update.name;
    if (update.description !== null && update.description !== undefined) role.description = update.description;
    return role;
  }

  deleteMockRole(organizationId: string, roleId: string): boolean {
    const role = this.getRole(organizationId, roleId);
    if (!role || role.isSystem || this.isMockRoleAssigned(roleId)) return false;
    this.roles.delete(roleId);
    return true;
  }

  isMockRoleAssigned(roleId: string): boolean {
    return [...this.identityRoles.values()].some((roleIds) => roleIds.has(roleId));
  }

  setRolePermissions(roleId: string, permissions: string[]): boolean {
    const role = this.roles.get(roleId);
    if (!role) return false;
    role.permissions = new Set(permissions.filter((code): code is MockPermissionCode => ALL_PERMISSIONS.includes(code as MockPermissionCode)));
    return true;
  }

  findAgentRowAny(agentId: string): { id: string; name: string; role: string; type: string; model_id: string | null; enabled: boolean } | null {
    const agent = this.agents.find((item) => item.id === agentId && item.enabled);
    return agent ? { id: agent.id, name: agent.name, role: agent.role, type: agent.type, model_id: agent.modelId, enabled: agent.enabled } : null;
  }

  setIdentityRoles(identityId: string, organizationId: string, roleIds: string[]): boolean {
    const identity = this.identities.get(identityId);
    if (!identity || identity.organizationId !== organizationId || identity.type !== 'enterprise' || identity.status !== 'active') return false;
    if (roleIds.some((roleId) => this.roles.get(roleId)?.organizationId !== organizationId)) return false;
    this.identityRoles.set(identityId, new Set(roleIds));
    return true;
  }

  clearIdentityRoles(identityId: string): void {
    this.identityRoles.delete(identityId);
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
    const role: Identity['role'] = type === 'personal' ? 'personal' : 'member';
    const identity: Identity = { id: this.nextId('idy'), userId, type, displayName, organizationId, status: 'active', isDefault, role };
    if (isDefault) for (const item of this.identities.values()) if (item.userId === userId) item.isDefault = false;
    this.identities.set(identity.id, identity);
    if (type === 'personal') this.identityPermissions.set(identity.id, new Set(ALL_PERMISSIONS));
    return identity;
  }

  private createRoleRow(organizationId: string, name: string, description: string, isSystem: boolean, permissions: readonly string[]): StoredRole {
    const role: StoredRole = { id: this.nextId('role'), organizationId, name, description, isSystem, permissions: new Set(permissions.filter((code): code is MockPermissionCode => ALL_PERMISSIONS.includes(code as MockPermissionCode))) };
    this.roles.set(role.id, role);
    return role;
  }

  private seedIdentityWorkspace(identity: Identity, name = `${identity.displayName}的个人工作区`, type: 'personal' | 'enterprise' = 'personal'): void {
    this.workspaces.push({ id: this.nextId('wsp'), identityId: identity.id, type, name, projectId: null });
  }

  private createProjectRow(identityId: string, name: string, kind: 'normal' | 'standalone' = 'normal'): StoredProject {
    this.seq += 1;
    const project: StoredProject = { id: this.nextId('prj'), name, ownerIdentityId: identityId, createdAt: new Date().toISOString(), kind, seq: this.seq };
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
