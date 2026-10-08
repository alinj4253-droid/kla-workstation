export type IdentityType = 'personal' | 'enterprise';

export type UserAccount = {
  id: string;
  email: string | null;
  phone: string | null;
  nickname: string;
  status: 'active' | 'disabled';
};

export type Identity = {
  id: string;
  userId: string;
  type: IdentityType;
  displayName: string;
  organizationId: string | null;
  status: 'active' | 'disabled';
  isDefault: boolean;
  /** 角色：个人身份为 personal；企业身份为 admin（管理员）或 member（企业员工） */
  role: 'personal' | 'admin' | 'member';
};

export type Session = { id: string; userId: string; accessToken: string; refreshToken: string; expiresAt: string; deviceId?: string | null; deviceName?: string | null; lastSeenAt?: string };

export type Organization = {
  id: string;
  name: string;
  inviteCode: string;
  status: 'active' | 'disabled';
};
export type Project = { id: string; name: string; ownerIdentityId: string; createdAt: string };
export type Conversation = { id: string; projectId: string; name: string; createdAt: string };
export type Message = { id: string; conversationId: string; senderId: string; senderType: 'user' | 'agent' | 'system'; senderName?: string | null; kind: string; text: string; metadata?: Record<string, unknown>; createdAt: string };
export type AgentProfile = { id: string; name: string; role: string; type: string; modelId: string | null; enabled: boolean };
export type Artifact = { id: string; conversationId: string | null; name: string; mimeType: string; content: string; sizeBytes: number; createdAt: string };
export type ConversationRun = { id: string; conversationId: string; triggerMessageId: string | null; status: string; mode: string; currentAgent: string | null; result: Record<string, unknown>; createdAt: string; updatedAt: string };

export interface AccountRepository {
  getUser(id: string): Promise<UserAccount | null>;
  listIdentities(userId: string): Promise<Identity[]>;
  register(input: { email?: string; phone?: string; password: string; nickname: string }): Promise<{ user: UserAccount; identity: Identity }>;
  authenticate(identifier: string, password: string): Promise<{ user: UserAccount; identity: Identity } | null>;
  createSession(userId: string, metadata?: { deviceId?: string; deviceName?: string; userAgent?: string; ipAddress?: string }): Promise<Session>;
  getSession(token: string): Promise<Session | null>;
  revokeSession(token: string): Promise<void>;
  revokeSessionByRefreshToken(refreshToken: string): Promise<void>;
  rotateSession(refreshToken: string, metadata?: { deviceId?: string; deviceName?: string; userAgent?: string; ipAddress?: string }): Promise<Session | null>;
  listSessions(userId: string): Promise<Array<{ id: string; deviceId: string | null; deviceName: string | null; userAgent: string | null; ipAddress: string | null; expiresAt: string; lastSeenAt: string; current: boolean }>>;
  revokeAllSessions(userId: string, exceptSessionId?: string): Promise<void>;
  listProjects(identityId: string): Promise<Project[]>;
  listAllConversations(identityId: string): Promise<Array<Conversation & { projectName: string }>>;
  createProject(identityId: string, name: string): Promise<Project>;
  listConversations(projectId?: string, identityId?: string): Promise<Conversation[]>;
  createConversation(projectId: string, name: string): Promise<Conversation>;
  listMessages(conversationId: string): Promise<Message[]>;
  createMessage(conversationId: string, senderId: string, text: string): Promise<Message>;
  createAgentMessage(conversationId: string, agentName: string, text: string, metadata?: Record<string, unknown>): Promise<Message>;
  listAgents(identityId: string): Promise<AgentProfile[]>;
  listConversationRuns(conversationId: string): Promise<ConversationRun[]>;
  createRun(conversationId: string, triggerMessageId: string, mode: string): Promise<ConversationRun>;
  completeRun(runId: string, status: string, agentName?: string, result?: Record<string, unknown>): Promise<ConversationRun>;
  createArtifact(identityId: string, conversationId: string, name: string, mimeType: string, content: string): Promise<Artifact>;
  listArtifacts(identityId: string, conversationId?: string): Promise<Artifact[]>;
  getArtifact(identityId: string, artifactId: string): Promise<Artifact | null>;
  createOrganization(userId: string, name: string, licenseNumber: string): Promise<Identity>;
  joinOrganization(userId: string, inviteCode: string): Promise<Identity | null>;
  activateIdentity(userId: string, identityId: string): Promise<Identity | null>;
  getOrganization(orgId: string): Promise<Organization | null>;
  /** 用户是否拥有该企业的 active 企业身份（成员/管理员均算） */
  isOrganizationMember(userId: string, orgId: string): Promise<boolean>;
}
