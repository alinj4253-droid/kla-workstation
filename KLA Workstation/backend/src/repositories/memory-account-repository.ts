import type { AccountRepository, Identity, UserAccount } from './types.js';

export class MemoryAccountRepository implements AccountRepository {
  private readonly users = new Map<string, UserAccount>();
  private readonly identities = new Map<string, Identity[]>();

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
}
