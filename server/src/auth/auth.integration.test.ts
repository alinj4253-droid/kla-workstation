import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createServer } from '../server.js';
import { ENTERPRISE_ADMIN_PERMISSIONS, ENTERPRISE_MEMBER_PERMISSIONS } from '../repositories/permission-sets.js';

const testCase = process.env.DATABASE_URL ? it : it.skip;

describe('authentication and identity permissions', () => {
  testCase('registers, rotates sessions, isolates identities, and enforces member permissions', async () => {
    const runtime = await createServer();
    const suffix = randomUUID().replaceAll('-', '');
    const emailA = `auth-regression-a-${suffix}@example.test`;
    const emailB = `auth-regression-b-${suffix}@example.test`;
    const createdUsers: string[] = [];
    const createdOrganizations: string[] = [];
    try {
      const registerA = await runtime.app.inject({
        method: 'POST', url: '/api/v1/auth/register',
        payload: { email: emailA, nickname: '认证回归 A', password: 'TestPass2026!' },
      });
      expect(registerA.statusCode).toBe(201);
      const accountA = registerA.json().data;
      createdUsers.push(accountA.user.id);
      expect(accountA.identities).toHaveLength(1);
      expect(accountA.identities[0].type).toBe('personal');

      const wrongPassword = await runtime.app.inject({
        method: 'POST', url: '/api/v1/auth/login',
        payload: { identifier: emailA, password: 'wrong-password' },
      });
      expect(wrongPassword.statusCode).toBe(401);

      const rotated = await runtime.app.inject({
        method: 'POST', url: '/api/v1/auth/refresh',
        payload: { refreshToken: accountA.session.refreshToken },
      });
      expect(rotated.statusCode).toBe(200);
      const rotatedSession = rotated.json().data.session;
      expect(rotatedSession.refreshToken).not.toBe(accountA.session.refreshToken);

      const replay = await runtime.app.inject({
        method: 'POST', url: '/api/v1/auth/refresh',
        payload: { refreshToken: accountA.session.refreshToken },
      });
      expect(replay.statusCode).toBe(401);

      const authA = { authorization: `Bearer ${rotatedSession.accessToken}` };
      const secondaryLogin = await runtime.app.inject({
        method: 'POST', url: '/api/v1/auth/login',
        headers: { 'x-device-id': `device-${suffix}` },
        payload: { identifier: emailA, password: 'TestPass2026!' },
      });
      expect(secondaryLogin.statusCode).toBe(200);
      const secondaryAccess = secondaryLogin.json().data.session.accessToken;
      const sessions = await runtime.app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: authA });
      expect(sessions.statusCode).toBe(200);
      expect(sessions.json().data.some((item: { deviceId: string }) => item.deviceId === `device-${suffix}`)).toBe(true);
      const revokeAll = await runtime.app.inject({ method: 'POST', url: '/api/v1/auth/sessions/revoke-all', headers: authA });
      expect(revokeAll.statusCode).toBe(200);
      const revokedSecondary = await runtime.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${secondaryAccess}` } });
      expect(revokedSecondary.statusCode).toBe(401);
      expect((await runtime.app.inject({ method: 'GET', url: '/api/v1/me', headers: authA })).statusCode).toBe(200);

      const organization = await runtime.app.inject({
        method: 'POST', url: '/api/v1/organizations', headers: authA,
        payload: { name: `认证回归企业-${suffix.slice(0, 8)}`, licenseNumber: `91310000${suffix.slice(0, 10)}` },
      });
      expect(organization.statusCode).toBe(200);
      const enterpriseIdentity = organization.json().data;
      createdOrganizations.push(enterpriseIdentity.organizationId);
      expect(enterpriseIdentity.inviteCode).toMatch(/^[A-F0-9]{8}$/);

      const adminPermissions = await runtime.app.inject({
        method: 'GET', url: '/api/v1/me/permissions', headers: { ...authA, 'x-identity-id': enterpriseIdentity.id },
      });
      expect(adminPermissions.statusCode).toBe(200);
      // 管理员 = 基础权限 + 算力管理员权限集
      expect(adminPermissions.json().data.map((item: { code: string }) => item.code).sort()).toEqual([...ENTERPRISE_ADMIN_PERMISSIONS, 'execute', 'export', 'manage', 'read', 'write'].sort());
      const organizationList = await runtime.app.inject({
        method: 'GET', url: '/api/v1/organizations', headers: { ...authA, 'x-identity-id': enterpriseIdentity.id },
      });
      expect(organizationList.statusCode).toBe(200);
      expect(organizationList.json().data.some((item: { id: string }) => item.id === enterpriseIdentity.organizationId)).toBe(true);
      const createdRole = await runtime.app.inject({
        method: 'POST', url: `/api/v1/organizations/${enterpriseIdentity.organizationId}/roles`, headers: { ...authA, 'x-identity-id': enterpriseIdentity.id },
        payload: { name: '项目协作者', description: '允许成员创建项目', permissions: ['read', 'write'] },
      });
      expect(createdRole.statusCode).toBe(201);
      const customRole = createdRole.json().data;
      const roles = await runtime.app.inject({ method: 'GET', url: `/api/v1/organizations/${enterpriseIdentity.organizationId}/roles`, headers: { ...authA, 'x-identity-id': enterpriseIdentity.id } });
      expect(roles.statusCode).toBe(200);
      expect(roles.json().data.some((item: { id: string }) => item.id === customRole.id)).toBe(true);

      const registerB = await runtime.app.inject({
        method: 'POST', url: '/api/v1/auth/register',
        payload: { email: emailB, nickname: '认证回归 B', password: 'TestPass2026!' },
      });
      expect(registerB.statusCode).toBe(201);
      const accountB = registerB.json().data;
      createdUsers.push(accountB.user.id);
      const authB = { authorization: `Bearer ${accountB.session.accessToken}` };
      const joined = await runtime.app.inject({
        method: 'POST', url: '/api/v1/organizations/join', headers: authB,
        payload: { inviteCode: enterpriseIdentity.inviteCode },
      });
      expect(joined.statusCode).toBe(200);
      const memberIdentity = joined.json().data;
      const memberPermissions = await runtime.app.inject({
        method: 'GET', url: '/api/v1/me/permissions', headers: { ...authB, 'x-identity-id': memberIdentity.id },
      });
      expect(memberPermissions.statusCode).toBe(200);
      expect(memberPermissions.json().data.map((item: { code: string }) => item.code).sort()).toEqual([...ENTERPRISE_MEMBER_PERMISSIONS, 'execute', 'export', 'read', 'write'].sort());
      const memberCanCreate = await runtime.app.inject({ method: 'POST', url: '/api/v1/projects', headers: { ...authB, 'x-identity-id': memberIdentity.id }, payload: { name: '成员可创建的项目' } });
      expect(memberCanCreate.statusCode).toBe(200);
      const memberProject = memberCanCreate.json().data;
      const memberChat = await runtime.app.inject({ method: 'POST', url: '/api/v1/conversations', headers: { ...authB, 'x-identity-id': memberIdentity.id }, payload: { name: '成员群聊', projectId: memberProject.id } });
      expect(memberChat.statusCode).toBe(200);
      const conversationId = memberChat.json().data.id;
      const ownHistory = await runtime.app.inject({ method: 'GET', url: `/api/v1/conversations/${conversationId}/messages`, headers: { ...authB, 'x-identity-id': memberIdentity.id } });
      expect(ownHistory.statusCode).toBe(200);
      expect(ownHistory.json().data).toEqual([]);
      const isolatedHistory = await runtime.app.inject({ method: 'GET', url: `/api/v1/conversations/${conversationId}/messages`, headers: { ...authB, 'x-identity-id': accountB.identities[0].id } });
      expect(isolatedHistory.statusCode).toBe(404);
      const isolatedCreate = await runtime.app.inject({ method: 'POST', url: '/api/v1/conversations', headers: { ...authB, 'x-identity-id': accountB.identities[0].id }, payload: { name: '跨身份群聊', projectId: memberProject.id } });
      expect(isolatedCreate.statusCode).toBe(403);

      const memberList = await runtime.app.inject({ method: 'GET', url: `/api/v1/organizations/${enterpriseIdentity.organizationId}/members`, headers: { ...authA, 'x-identity-id': enterpriseIdentity.id } });
      expect(memberList.statusCode).toBe(200);
      expect(memberList.json().data.some((item: { identityId: string }) => item.identityId === memberIdentity.id)).toBe(true);
      const assignRole = await runtime.app.inject({
        method: 'PUT', url: `/api/v1/organizations/${enterpriseIdentity.organizationId}/members/${memberIdentity.id}/roles`, headers: { ...authA, 'x-identity-id': enterpriseIdentity.id },
        payload: { roleIds: [customRole.id] },
      });
      expect(assignRole.statusCode).toBe(200);
      const memberPermissionsAfterRole = await runtime.app.inject({ method: 'GET', url: '/api/v1/me/permissions', headers: { ...authB, 'x-identity-id': memberIdentity.id } });
      expect(memberPermissionsAfterRole.statusCode).toBe(200);
      expect(memberPermissionsAfterRole.json().data.map((item: { code: string }) => item.code).sort()).toEqual(['read', 'write']);
      const memberCanWrite = await runtime.app.inject({ method: 'POST', url: '/api/v1/projects', headers: { ...authB, 'x-identity-id': memberIdentity.id }, payload: { name: '授权后的项目' } });
      expect(memberCanWrite.statusCode).toBe(200);
      const memberCannotManage = await runtime.app.inject({ method: 'GET', url: `/api/v1/organizations/${enterpriseIdentity.organizationId}/members`, headers: { ...authB, 'x-identity-id': memberIdentity.id } });
      expect(memberCannotManage.statusCode).toBe(403);
      const readOnlyRole = await runtime.app.inject({ method: 'POST', url: `/api/v1/organizations/${enterpriseIdentity.organizationId}/roles`, headers: { ...authA, 'x-identity-id': enterpriseIdentity.id }, payload: { name: '只读角色', permissions: ['read'] } });
      expect(readOnlyRole.statusCode).toBe(201);
      expect((await runtime.app.inject({ method: 'PUT', url: `/api/v1/organizations/${enterpriseIdentity.organizationId}/members/${memberIdentity.id}/roles`, headers: { ...authA, 'x-identity-id': enterpriseIdentity.id }, payload: { roleIds: [readOnlyRole.json().data.id] } })).statusCode).toBe(200);
      const deniedCreate = await runtime.app.inject({ method: 'POST', url: '/api/v1/projects', headers: { ...authB, 'x-identity-id': memberIdentity.id }, payload: { name: '禁止写入的项目' } });
      expect(deniedCreate.statusCode).toBe(403);
      expect(deniedCreate.json().error.code).toBe('PERMISSION_DENIED');

      await runtime.database.rawPool?.query('UPDATE users SET status=\'disabled\' WHERE id=$1', [accountB.user.id]);
      expect((await runtime.app.inject({ method: 'GET', url: '/api/v1/me', headers: authB })).statusCode).toBe(401);
      await runtime.database.rawPool?.query('UPDATE organizations SET status=\'disabled\' WHERE id=$1', [enterpriseIdentity.organizationId]);
      const disabledOrganizationPermissions = await runtime.app.inject({
        method: 'GET', url: '/api/v1/me/permissions', headers: { ...authA, 'x-identity-id': enterpriseIdentity.id },
      });
      expect(disabledOrganizationPermissions.statusCode).toBe(403);
      const disabledOrganizationEntitlements = await runtime.app.inject({
        method: 'GET', url: '/api/v1/me/entitlements', headers: { ...authA, 'x-identity-id': enterpriseIdentity.id },
      });
      expect(disabledOrganizationEntitlements.statusCode).toBe(403);

      const logout = await runtime.app.inject({
        method: 'POST', url: '/api/v1/auth/logout', headers: authA,
        payload: { refreshToken: rotatedSession.refreshToken },
      });
      expect(logout.statusCode).toBe(200);
      const refreshAfterLogout = await runtime.app.inject({
        method: 'POST', url: '/api/v1/auth/refresh',
        payload: { refreshToken: rotatedSession.refreshToken },
      });
      expect(refreshAfterLogout.statusCode).toBe(401);
    } finally {
      if (runtime.database.rawPool) {
        await runtime.database.rawPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUsers]);
        await runtime.database.rawPool.query('DELETE FROM identities WHERE organization_id = ANY($1::uuid[])', [createdOrganizations]);
        await runtime.database.rawPool.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [createdOrganizations]);
      }
      await runtime.app.close();
    }
  }, 30_000);
});
