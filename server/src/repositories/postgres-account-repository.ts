import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import type { AccountRepository, Conversation, Identity, Message, Project, Session, UserAccount, AgentProfile, ConversationRun, Artifact } from './types.js';

const scrypt = promisify(scryptCallback);
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}
async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [salt, expectedHex] = encoded.split(':');
  if (!salt || !expectedHex) return false;
  const actual = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class PostgresAccountRepository implements AccountRepository {
  constructor(private readonly pool: Pool) {}

  async getUser(id: string): Promise<UserAccount | null> {
    const { rows } = await this.pool.query('SELECT id, email, phone, nickname, status FROM users WHERE id = $1', [id]);
    return rows[0] ? { id: rows[0].id, email: rows[0].email, phone: rows[0].phone, nickname: rows[0].nickname, status: rows[0].status } : null;
  }

  async listIdentities(userId: string): Promise<Identity[]> {
    const { rows } = await this.pool.query('SELECT id, user_id, type, display_name, organization_id, status, is_default FROM identities WHERE user_id = $1 ORDER BY is_default DESC, created_at', [userId]);
    return rows.map((row) => ({ id: row.id, userId: row.user_id, type: row.type, displayName: row.display_name, organizationId: row.organization_id, status: row.status, isDefault: row.is_default }));
  }

  async register(input: { email?: string; phone?: string; password: string; nickname: string }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const userResult = await client.query('INSERT INTO users (email, phone, nickname) VALUES ($1, $2, $3) RETURNING id, email, phone, nickname, status', [input.email ?? null, input.phone ?? null, input.nickname]);
      const userRow = userResult.rows[0];
      await client.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [userRow.id, await hashPassword(input.password)]);
      const identityResult = await client.query("INSERT INTO identities (user_id, type, display_name, is_default) VALUES ($1, 'personal', $2, true) RETURNING id, user_id, type, display_name, organization_id, status, is_default", [userRow.id, input.nickname]);
      await client.query("INSERT INTO workspaces (identity_id, type, name) VALUES ($1, 'personal', $2)", [identityResult.rows[0].id, `${input.nickname}的个人工作区`]);
      const project = await client.query("INSERT INTO projects (owner_identity_id, name) VALUES ($1, $2) RETURNING id", [identityResult.rows[0].id, '我的协作项目']);
      for (const [name, role, type] of [['统筹智能体', '识别目标、规划协作任务并调度执行智能体', 'official'], ['本地执行智能体', '检索知识、编写材料并交付成果文件', 'official']] as const) await client.query('INSERT INTO agents (identity_id, name, role, type) VALUES ($1,$2,$3,$4)', [identityResult.rows[0].id, name, role, type]);
      await client.query('INSERT INTO conversations (project_id, name) VALUES ($1, $2)', [project.rows[0].id, '默认协作群聊']);
      await client.query('COMMIT');
      return { user: { id: userRow.id, email: userRow.email, phone: userRow.phone, nickname: userRow.nickname, status: userRow.status }, identity: this.identity(identityResult.rows[0]) };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async authenticate(identifier: string, password: string) {
    const { rows } = await this.pool.query('SELECT u.id, u.email, u.phone, u.nickname, u.status, c.password_hash FROM users u JOIN user_credentials c ON c.user_id = u.id WHERE u.email = $1 OR u.phone = $1 LIMIT 1', [identifier]);
    const row = rows[0];
    if (!row || row.status !== 'active' || !(await verifyPassword(password, row.password_hash))) return null;
    const identities = await this.listIdentities(row.id);
    const identity = identities.find((item) => item.isDefault && item.status === 'active') ?? identities.find((item) => item.status === 'active');
    return identity ? { user: { id: row.id, email: row.email, phone: row.phone, nickname: row.nickname, status: row.status }, identity } : null;
  }

  async createSession(userId: string, metadata: { deviceId?: string; deviceName?: string; userAgent?: string; ipAddress?: string } = {}): Promise<Session> {
    const accessToken = randomUUID(); const refreshToken = randomUUID(); const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000);
    const { rows } = await this.pool.query('INSERT INTO sessions (user_id, access_token_hash, refresh_token_hash, expires_at, device_id, device_name, user_agent, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::inet) RETURNING id, expires_at, device_id, device_name', [userId, hashToken(accessToken), hashToken(refreshToken), expiresAt, metadata.deviceId ?? null, metadata.deviceName ?? null, metadata.userAgent ?? null, metadata.ipAddress ?? null]);
    return { id: rows[0].id, userId, accessToken, refreshToken, expiresAt: new Date(rows[0].expires_at).toISOString() };
  }
  async getSession(token: string): Promise<Session | null> {
    const { rows } = await this.pool.query("UPDATE sessions s SET last_seen_at=now() FROM users u WHERE s.user_id=u.id AND u.status='active' AND s.access_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() RETURNING s.id, s.user_id, s.expires_at, s.device_id, s.device_name, s.last_seen_at", [hashToken(token)]);
    return rows[0] ? { id: rows[0].id, userId: rows[0].user_id, accessToken: token, refreshToken: '', expiresAt: new Date(rows[0].expires_at).toISOString(), deviceId: rows[0].device_id, deviceName: rows[0].device_name, lastSeenAt: new Date(rows[0].last_seen_at).toISOString() } : null;
  }
  async revokeSession(token: string): Promise<void> { await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE access_token_hash = $1 AND revoked_at IS NULL', [hashToken(token)]); }
  async revokeSessionByRefreshToken(refreshToken: string): Promise<void> { await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL', [hashToken(refreshToken)]); }
  async rotateSession(refreshToken: string, metadata: { deviceId?: string; deviceName?: string; userAgent?: string; ipAddress?: string } = {}): Promise<Session | null> {
    const client = await this.pool.connect(); try { await client.query('BEGIN'); const found = await client.query("SELECT s.id,s.user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.status='active' AND s.refresh_token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() FOR UPDATE", [hashToken(refreshToken)]); if (!found.rows[0]) { await client.query('ROLLBACK'); return null; } const accessToken = randomUUID(); const nextRefresh = randomUUID(); const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000); const result = await client.query('UPDATE sessions SET access_token_hash=$2,refresh_token_hash=$3,expires_at=$4,device_id=COALESCE($5,device_id),device_name=COALESCE($6,device_name),user_agent=COALESCE($7,user_agent),ip_address=COALESCE($8::inet,ip_address),last_seen_at=now() WHERE id=$1 RETURNING id,user_id,expires_at,device_id,device_name,last_seen_at', [found.rows[0].id, hashToken(accessToken), hashToken(nextRefresh), expiresAt, metadata.deviceId ?? null, metadata.deviceName ?? null, metadata.userAgent ?? null, metadata.ipAddress ?? null]); await client.query('COMMIT'); const row = result.rows[0]; return { id: row.id, userId: row.user_id, accessToken, refreshToken: nextRefresh, expiresAt: new Date(row.expires_at).toISOString(), deviceId: row.device_id, deviceName: row.device_name, lastSeenAt: new Date(row.last_seen_at).toISOString() }; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async listSessions(userId: string): Promise<Array<{ id: string; deviceId: string | null; deviceName: string | null; userAgent: string | null; ipAddress: string | null; expiresAt: string; lastSeenAt: string; current: boolean }>> { const { rows } = await this.pool.query('SELECT id,device_id,device_name,user_agent,host(ip_address) AS ip_address,expires_at,last_seen_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY last_seen_at DESC', [userId]); return rows.map((row) => ({ id: row.id, deviceId: row.device_id, deviceName: row.device_name, userAgent: row.user_agent, ipAddress: row.ip_address, expiresAt: new Date(row.expires_at).toISOString(), lastSeenAt: new Date(row.last_seen_at).toISOString(), current: false })); }
  async revokeAllSessions(userId: string, exceptSessionId?: string): Promise<void> { await this.pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id<>$2)', [userId, exceptSessionId ?? null]); }

  async listProjects(identityId: string): Promise<Project[]> { const { rows } = await this.pool.query('SELECT id, name, owner_identity_id, created_at FROM projects WHERE owner_identity_id = $1 ORDER BY created_at DESC', [identityId]); return rows.map((row) => ({ id: row.id, name: row.name, ownerIdentityId: row.owner_identity_id, createdAt: new Date(row.created_at).toISOString() })); }
  async listAllConversations(identityId: string): Promise<Array<Conversation & { projectName: string }>> { const { rows } = await this.pool.query('SELECT c.id,c.project_id,c.name,c.created_at,p.name AS project_name FROM conversations c JOIN projects p ON p.id=c.project_id WHERE p.owner_identity_id=$1 ORDER BY c.created_at DESC', [identityId]); return rows.map((r) => ({ id: r.id, projectId: r.project_id, name: r.name, createdAt: new Date(r.created_at).toISOString(), projectName: r.project_name })); }
  async createProject(identityId: string, name: string): Promise<Project> { const { rows } = await this.pool.query('INSERT INTO projects (owner_identity_id, name) VALUES ($1, $2) RETURNING id, name, owner_identity_id, created_at', [identityId, name]); const row = rows[0]; return { id: row.id, name: row.name, ownerIdentityId: row.owner_identity_id, createdAt: new Date(row.created_at).toISOString() }; }
  async listConversations(projectId?: string, identityId?: string): Promise<Conversation[]> { const { rows } = await this.pool.query('SELECT c.id, c.project_id, c.name, c.created_at FROM conversations c JOIN projects p ON p.id = c.project_id WHERE ($1::uuid IS NULL OR c.project_id = $1) AND ($2::uuid IS NULL OR p.owner_identity_id = $2) ORDER BY c.created_at DESC', [projectId ?? null, identityId ?? null]); return rows.map((row) => ({ id: row.id, projectId: row.project_id, name: row.name, createdAt: new Date(row.created_at).toISOString() })); }
  async createConversation(projectId: string, name: string): Promise<Conversation> { const { rows } = await this.pool.query('INSERT INTO conversations (project_id, name) VALUES ($1, $2) RETURNING id, project_id, name, created_at', [projectId, name]); const row = rows[0]; return { id: row.id, projectId: row.project_id, name: row.name, createdAt: new Date(row.created_at).toISOString() }; }
  async listMessages(conversationId: string): Promise<Message[]> { const { rows } = await this.pool.query('SELECT id, conversation_id, sender_id, sender_type, sender_name, kind, text, metadata, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at, id', [conversationId]); return rows.map((row) => this.message(row)); }
  async createMessage(conversationId: string, senderId: string, text: string): Promise<Message> { const { rows } = await this.pool.query("INSERT INTO messages (conversation_id, sender_id, sender_type, text) VALUES ($1, $2, 'user', $3) RETURNING id, conversation_id, sender_id, sender_type, sender_name, kind, text, metadata, created_at", [conversationId, senderId, text]); return this.message(rows[0]); }
  async createAgentMessage(conversationId: string, agentName: string, text: string, metadata: Record<string, unknown> = {}): Promise<Message> {
    const { rows } = await this.pool.query("INSERT INTO messages (conversation_id, sender_id, sender_type, sender_name, text, metadata) VALUES ($1, (SELECT user_id FROM identities WHERE id = (SELECT owner_identity_id FROM projects WHERE id = (SELECT project_id FROM conversations WHERE id = $1))), 'agent', $2, $3, $4) RETURNING id, conversation_id, sender_id, sender_type, sender_name, kind, text, metadata, created_at", [conversationId, agentName, text, JSON.stringify(metadata)]);
    return this.message(rows[0]);
  }
  async listAgents(identityId: string): Promise<AgentProfile[]> { const { rows } = await this.pool.query('SELECT id, name, role, type, model_id, enabled FROM agents WHERE identity_id = $1 AND enabled = true ORDER BY created_at', [identityId]); return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, type: r.type, modelId: r.model_id, enabled: r.enabled })); }
  async listConversationRuns(conversationId: string): Promise<ConversationRun[]> { const { rows } = await this.pool.query('SELECT * FROM conversation_runs WHERE conversation_id = $1 ORDER BY updated_at DESC LIMIT 20', [conversationId]); return rows.map((r) => this.run(r)); }
  async createRun(conversationId: string, triggerMessageId: string, mode: string): Promise<ConversationRun> { const { rows } = await this.pool.query('INSERT INTO conversation_runs (conversation_id, trigger_message_id, mode) VALUES ($1,$2,$3) RETURNING *', [conversationId, triggerMessageId, mode]); return this.run(rows[0]); }
  async completeRun(runId: string, status: string, agentName?: string, result: Record<string, unknown> = {}): Promise<ConversationRun> { const { rows } = await this.pool.query('UPDATE conversation_runs SET status=$2, current_agent=$3, result=$4, updated_at=now() WHERE id=$1 RETURNING *', [runId, status, agentName ?? null, JSON.stringify(result)]); return this.run(rows[0]); }
  async createArtifact(identityId: string, conversationId: string, name: string, mimeType: string, content: string): Promise<Artifact> { const { rows } = await this.pool.query('INSERT INTO artifacts (identity_id, conversation_id, name, mime_type, content, size_bytes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [identityId, conversationId, name, mimeType, content, Buffer.byteLength(content)]); return this.artifact(rows[0]); }
  async listArtifacts(identityId: string, conversationId?: string): Promise<Artifact[]> { const { rows } = await this.pool.query('SELECT * FROM artifacts WHERE identity_id=$1 AND ($2::uuid IS NULL OR conversation_id=$2) ORDER BY created_at DESC', [identityId, conversationId ?? null]); return rows.map((r) => this.artifact(r)); }
  async getArtifact(identityId: string, artifactId: string): Promise<Artifact | null> { const { rows } = await this.pool.query('SELECT * FROM artifacts WHERE identity_id=$1 AND id=$2', [identityId, artifactId]); return rows[0] ? this.artifact(rows[0]) : null; }
  private message(row: Record<string, any>): Message { return { id: row.id, conversationId: row.conversation_id, senderId: row.sender_id, senderType: row.sender_type ?? 'user', senderName: row.sender_name, kind: row.kind ?? 'text', text: row.text, metadata: row.metadata ?? {}, createdAt: new Date(row.created_at).toISOString() }; }
  private run(row: Record<string, any>): ConversationRun { return { id: row.id, conversationId: row.conversation_id, triggerMessageId: row.trigger_message_id, status: row.status, mode: row.mode, currentAgent: row.current_agent, result: row.result ?? {}, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }; }
  private artifact(row: Record<string, any>): Artifact { return { id: row.id, conversationId: row.conversation_id, name: row.name, mimeType: row.mime_type, content: row.content, sizeBytes: Number(row.size_bytes ?? 0), createdAt: new Date(row.created_at).toISOString() }; }
  async createOrganization(userId: string, name: string, licenseNumber: string): Promise<Identity> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const personal = await client.query("SELECT id FROM identities WHERE user_id = $1 AND type = 'personal' LIMIT 1", [userId]);
      if (!personal.rows[0]) throw new Error('PERSONAL_IDENTITY_REQUIRED');
      const org = await client.query('INSERT INTO organizations (name, license_number) VALUES ($1, $2) RETURNING id', [name, licenseNumber]);
      const identity = await client.query("INSERT INTO identities (user_id, type, display_name, organization_id, is_default) VALUES ($1, 'enterprise', $2, $3, false) RETURNING id, user_id, type, display_name, organization_id, status, is_default", [userId, name, org.rows[0].id]);
      const role = await client.query("INSERT INTO roles (organization_id, name, description, is_system) VALUES ($1, '管理员', '企业管理员', true) RETURNING id", [org.rows[0].id]);
      await client.query('INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)', [identity.rows[0].id, role.rows[0].id]);
      await client.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code IN ('read','write','execute','manage','export') ON CONFLICT DO NOTHING", [role.rows[0].id]);
      await client.query("INSERT INTO workspaces (identity_id, type, name) VALUES ($1, 'enterprise', $2)", [identity.rows[0].id, `${name}企业工作区`]);
      await client.query('COMMIT'); return this.identity(identity.rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async joinOrganization(userId: string, inviteCode: string): Promise<Identity | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const org = await client.query("SELECT id, name FROM organizations WHERE invite_code = $1 AND status = 'active'", [inviteCode.trim().toUpperCase()]);
      if (!org.rows[0]) { await client.query('ROLLBACK'); return null; }
      const existing = await client.query("SELECT id, user_id, type, display_name, organization_id, status, is_default FROM identities WHERE user_id=$1 AND organization_id=$2 AND type='enterprise' AND status='active' LIMIT 1", [userId, org.rows[0].id]);
      if (existing.rows[0]) { await client.query('COMMIT'); return this.identity(existing.rows[0]); }
      const identity = await client.query("INSERT INTO identities (user_id, type, display_name, organization_id, is_default) VALUES ($1, 'enterprise', $2, $3, false) RETURNING id, user_id, type, display_name, organization_id, status, is_default", [userId, org.rows[0].name, org.rows[0].id]);
      const role = await client.query("INSERT INTO roles (organization_id, name, description, is_system) VALUES ($1, '成员', '企业成员', true) ON CONFLICT (organization_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id", [org.rows[0].id]);
      await client.query('INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)', [identity.rows[0].id, role.rows[0].id]);
      await client.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code='read' ON CONFLICT DO NOTHING", [role.rows[0].id]);
      await client.query("INSERT INTO workspaces (identity_id, type, name) VALUES ($1, 'enterprise', $2)", [identity.rows[0].id, `${org.rows[0].name}企业工作区`]);
      await client.query('COMMIT'); return this.identity(identity.rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async activateIdentity(userId: string, identityId: string): Promise<Identity | null> {
    const found = await this.pool.query("SELECT id FROM identities WHERE id = $1 AND user_id = $2 AND status = 'active'", [identityId, userId]);
    if (!found.rows[0]) return null;
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); await client.query('UPDATE identities SET is_default = false WHERE user_id = $1', [userId]); const result = await client.query('UPDATE identities SET is_default = true WHERE id = $1 RETURNING id, user_id, type, display_name, organization_id, status, is_default', [identityId]); await client.query('COMMIT'); return this.identity(result.rows[0]); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  private identity(row: Record<string, any>): Identity { return { id: row.id, userId: row.user_id, type: row.type, displayName: row.display_name, organizationId: row.organization_id, status: row.status, isDefault: row.is_default }; }
}
