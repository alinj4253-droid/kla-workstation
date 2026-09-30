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
};

export type Session = { id: string; userId: string; accessToken: string; refreshToken: string; expiresAt: string };
export type Project = { id: string; name: string; ownerIdentityId: string; createdAt: string };
export type Conversation = { id: string; projectId: string; name: string; createdAt: string };
export type Message = { id: string; conversationId: string; senderId: string; text: string; createdAt: string };

export interface AccountRepository {
  getUser(id: string): Promise<UserAccount | null>;
  listIdentities(userId: string): Promise<Identity[]>;
  register(input: { email?: string; phone?: string; password: string; nickname: string }): Promise<{ user: UserAccount; identity: Identity }>;
  authenticate(identifier: string, password: string): Promise<{ user: UserAccount; identity: Identity } | null>;
  createSession(userId: string): Promise<Session>;
  getSession(token: string): Promise<Session | null>;
  revokeSession(token: string): Promise<void>;
  listProjects(identityId: string): Promise<Project[]>;
  createProject(identityId: string, name: string): Promise<Project>;
  listConversations(projectId?: string, identityId?: string): Promise<Conversation[]>;
  createConversation(projectId: string, name: string): Promise<Conversation>;
  listMessages(conversationId: string): Promise<Message[]>;
  createMessage(conversationId: string, senderId: string, text: string): Promise<Message>;
  createOrganization(userId: string, name: string, licenseNumber: string): Promise<Identity>;
  joinOrganization(userId: string, inviteCode: string): Promise<Identity | null>;
  activateIdentity(userId: string, identityId: string): Promise<Identity | null>;
}
