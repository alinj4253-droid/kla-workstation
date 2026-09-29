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

export interface AccountRepository {
  getUser(id: string): Promise<UserAccount | null>;
  listIdentities(userId: string): Promise<Identity[]>;
}
