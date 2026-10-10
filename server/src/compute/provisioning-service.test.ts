import { describe, expect, it, vi } from 'vitest';
import type { ComputeRepository } from './compute-repository.js';
import { encryptField } from './encryption.js';
import { ProvisioningService } from './provisioning-service.js';
import type { Sub2ApiClient, Sub2ApiConfig } from './sub2api-client.js';

const context = { identityId: 'identity-1', identityType: 'personal' as const, displayName: '测试' };
const config = {} as Sub2ApiConfig;

describe('existing Sub2API binding recovery', () => {
  it('does not create a new upstream user when the stored password cannot be decrypted', async () => {
    const createUser = vi.fn();
    const updateBindingStatus = vi.fn();
    const repo = { getBinding: async () => ({ sub2apiUserId: 'user-1', status: 'ready',
      managedPassword: encryptField('old-password', 'a'.repeat(64)) }), updateBindingStatus } as unknown as ComputeRepository;
    const service = new ProvisioningService(repo, { createUser } as unknown as Sub2ApiClient, config, 'b'.repeat(64));
    await expect(service.retryProvision(context)).rejects.toThrow('不能重新建号');
    expect(createUser).not.toHaveBeenCalled();
    expect(updateBindingStatus).not.toHaveBeenCalled();
  });

  it('leaves an already ready binding unchanged', async () => {
    const createUser = vi.fn();
    const repo = { getBinding: async () => ({ sub2apiUserId: 'user-1', status: 'ready', managedPassword: 'plain-password' }) } as unknown as ComputeRepository;
    const service = new ProvisioningService(repo, { createUser } as unknown as Sub2ApiClient, config, '');
    await service.provisionIdentity(context);
    expect(createUser).not.toHaveBeenCalled();
  });
});
