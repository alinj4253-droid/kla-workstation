import { randomUUID, createHash } from 'node:crypto';
import type { AccountRepository, Conversation, Identity, Message, Project, Session, UserAccount } from './types.js';

export class MemoryAccountRepository implements AccountRepository {
  private readonly users = new Map<string, UserAccount>();
  private readonly identities = new Map<string, Identity[]>();
  private readonly credentials = new Map<string, string>();
  private readonly sessions = new Map<string, Session>();
  private readonly projects = new Map<string, Project>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly messages = new Map<string, Message>();

  constructor() {
    this.users.set('placeholder-user', {
      id: 'placeholder-user', email: null, phone: null,
      nickname: 'KLA 用户', status: 'active',
    });
    this.identities.set('placeholder-user', [{
      id: 'placeholder-personal-identity', userId: 'placeholder-user', type: 'personal',
      displayName: '个人身份', organizationId: null, status: 'active', isDefault: true,
    }]);
  }

  async getUser(id: string): Promise<UserAccount | null> {
    return this.users.get(id) ?? null;
  }

  async listIdentities(userId: string): Promise<Identity[]> {
    return this.identities.get(userId) ?? [];
  }

  async register(input: { email?: string; phone?: string; password: string; nickname: string }) {
    const id = randomUUID();
    const user: UserAccount = { id, email: input.email ?? null, phone: input.phone ?? null, nickname: input.nickname, status: 'active' };
    const identity: Identity = { id: randomUUID(), userId: id, type: 'personal', displayName: input.nickname, organizationId: null, status: 'active', isDefault: true };
    this.users.set(id, user); this.identities.set(id, [identity]);
    this.credentials.set(id, createHash('sha256').update(input.password).digest('hex'));
    return { user, identity };
  }

  async authenticate(identifier: string, password: string) {
    const user = [...this.users.values()].find((item) => item.email === identifier || item.phone === identifier);
    if (!user || user.status !== 'active' || this.credentials.get(user.id) !== createHash('sha256').update(password).digest('hex')) return null;
    const identity = (this.identities.get(user.id) ?? []).find((item) => item.isDefault && item.status === 'active') ?? this.identities.get(user.id)?.[0];
    return identity ? { user, identity } : null;
  }

  async createSession(userId: string): Promise<Session> { const session = { id: randomUUID(), userId, accessToken: randomUUID(), refreshToken: randomUUID(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }; this.sessions.set(session.accessToken, session); return session; }
  async getSession(token: string) { return this.sessions.get(token) ?? null; }
  async revokeSession(token: string) { this.sessions.delete(token); }
  async listProjects(identityId: string) { return [...this.projects.values()].filter((item) => item.ownerIdentityId === identityId); }
  async createProject(identityId: string, name: string) { const project = { id: randomUUID(), name, ownerIdentityId: identityId, createdAt: new Date().toISOString() }; this.projects.set(project.id, project); return project; }
  async listConversations(projectId?: string) { return [...this.conversations.values()].filter((item) => !projectId || item.projectId === projectId); }
  async createConversation(projectId: string, name: string) { const item = { id: randomUUID(), projectId, name, createdAt: new Date().toISOString() }; this.conversations.set(item.id, item); return item; }
  async listMessages(conversationId: string) { return [...this.messages.values()].filter((item) => item.conversationId === conversationId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  async createMessage(conversationId: string, senderId: string, text: string) { const item = { id: randomUUID(), conversationId, senderId, text, createdAt: new Date().toISOString() }; this.messages.set(item.id, item); return item; }
}
