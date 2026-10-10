// 账号生命周期：身份创建 → Sub2API 建号 → 默认 Key → ready
// 由 Outbox Worker 触发，支持重试。

import type { ComputeRepository } from './compute-repository.js';
import type { Sub2ApiClient, Sub2ApiConfig } from './sub2api-client.js';
import { Sub2ApiError } from './sub2api-client.js';
import { encryptField, resolveManagedPassword } from './encryption.js';

export type ProvisionContext = {
  identityId: string;
  identityType: 'personal' | 'enterprise';
  displayName: string;
  /** 登录账号邮箱（users.email），作为 Sub2API 账号派生基准；phone-only 用户为 null */
  userEmail?: string | null;
  /** 该身份在企业中的角色，决定邮箱后缀：personal→a / admin→b / member→c */
  role?: 'personal' | 'admin' | 'member';
};

/**
 * 按登录账号邮箱派生子身份的 Sub2API 邮箱：
 *   zhang@qq.com → 个人 zhang_a@qq.com / 企业管理员 zhang_b@qq.com / 企业成员 zhang_c@qq.com
 * 无邮箱（phone-only）时回退到确定性用户名（kla-personal-<id> / kla-org-<id>）。
 */
function deriveSub2apiEmail(ctx: ProvisionContext): string {
  const email = ctx.userEmail;
  if (!email || !email.includes('@')) {
    return ctx.identityType === 'personal' ? `kla-personal-${ctx.identityId}` : `kla-org-${ctx.identityId}`;
  }
  const [local, domain] = email.split('@');
  const suffix = ctx.role === 'admin' ? 'b' : ctx.role === 'member' ? 'c' : 'a';
  return `${local}_${suffix}@${domain}`;
}

export class ProvisioningService {
  constructor(
    private readonly repo: ComputeRepository,
    private readonly sub2api: Sub2ApiClient,
    private readonly config: Sub2ApiConfig,
    private readonly encryptionKey: string,
  ) {}

  /** 完整建号流程（由 Outbox Worker 调用） */
  async provisionIdentity(ctx: ProvisionContext): Promise<void> {
    const { identityId } = ctx;

    // 断点恢复（§5.3 幂等）：上游账号已建好但默认 Key 未建时，复用已存的托管密码续跑，
    // 不再重复 createUser（否则会因邮箱重复被 409 拒绝，且中途失败会产生无法登录的孤儿账号）。
    const existing = await this.repo.getBinding(identityId);
    if (existing?.sub2apiUserId && !resolveManagedPassword(existing.managedPassword, this.encryptionKey)) {
      throw new Error('已有上游账号的托管凭据无法解密；请恢复原加密密钥或由管理员重置该账号密码，不能重新建号');
    }
    if (existing?.status === 'ready') return;
    if (existing?.sub2apiUserId && (existing.status === 'user_created' || existing.status === 'balance_granted')) {
      const password = resolveManagedPassword(existing.managedPassword, this.encryptionKey);
      if (password) {
        await this.createDefaultKey(identityId, existing.sub2apiUserId, existing.sub2apiUsername, password);
        return;
      }
    }

    // 1. 为每个身份新建独立 Sub2API 账号
    const baseEmail = deriveSub2apiEmail(ctx);
    await this.repo.updateBindingStatus(identityId, 'provisioning');
    const password = '123456';
    const managedPassword = this.encryptionKey ? encryptField(password, this.encryptionKey) : password;

    let sub2apiUserId: string;
    let username = baseEmail;
    try {
      // 同一用户同角色多身份时邮箱会冲突（如两个企业管理员都映射到 xxx_b@domain），
      // 遇 409 自动追加序号重试：xxx_b@domain → xxx_b2@domain → xxx_b3@domain
      let seq = 1;
      while (true) {
        try {
          const user = await this.sub2api.createUser(username, password);
          sub2apiUserId = user.id;
          break;
        } catch (error) {
          if (error instanceof Sub2ApiError && error.status === 409 && seq < 10) {
            seq += 1;
            const [local, domain] = baseEmail.split('@');
            username = `${local}${seq}@${domain}`;
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      await this.repo.updateBindingStatus(identityId, 'failed', error instanceof Error ? error.message : '建号失败');
      throw error;
    }

    await this.repo.upsertBinding({
      identityId,
      sub2apiUserId,
      sub2apiUsername: username,
      managedPassword,
      status: 'user_created',
    });

    // 2. 创建默认 Key
    await this.createDefaultKey(identityId, sub2apiUserId, username, password);

    await this.repo.updateBindingStatus(identityId, 'ready');
  }

  async createDefaultKey(identityId: string, sub2apiUserId: string, username: string, password: string): Promise<void> {
    const jwt = await this.sub2api.getUserJwt(sub2apiUserId, username, password);
    const groupId = this.config.personalGroupId || this.config.defaultGroupId;
    const key = await this.sub2api.createApiKey(jwt, '默认工作站 Key', groupId);
    await this.repo.recordDefaultKey({
      identityId,
      sub2apiKeyId: key.id,
      keyPrefix: key.keyPrefix,
      keyFingerprint: key.keyFingerprint,
      name: '默认工作站 Key',
      groupId: groupId || null,
    });
    await this.repo.updateBindingStatus(identityId, 'default_key_created');
  }

  async disableIdentity(identityId: string): Promise<void> {
    const binding = await this.repo.getBinding(identityId);
    if (!binding) return;
    if (binding.sub2apiUserId) {
      await this.sub2api.disableUser(binding.sub2apiUserId);
    }
    await this.repo.updateBindingStatus(identityId, 'disabled');
  }

  /** 重试建号（供 /compute/provision/retry 调用） */
  async retryProvision(ctx: ProvisionContext): Promise<void> {
    await this.provisionIdentity(ctx);
  }
}
