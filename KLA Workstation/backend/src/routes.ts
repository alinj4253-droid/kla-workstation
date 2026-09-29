import type { FastifyInstance } from 'fastify';
import type { AccountRepository } from './repositories/types.js';

export async function registerRoutes(app: FastifyInstance, deps: { accounts: AccountRepository }): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    service: 'kla-backend' as const,
    version: '0.1.0',
    mode: 'placeholder' as const,
  }));

  app.get('/api/v1/me', async (_request, reply) => {
    const user = await deps.accounts.getUser('placeholder-user');
    return reply.send({ ok: true, data: user });
  });

  app.get('/api/v1/me/identities', async (_request, reply) => {
    const identities = await deps.accounts.listIdentities('placeholder-user');
    return reply.send({ ok: true, data: identities });
  });

  app.all('/api/v1/*', async (_request, reply) => reply.code(501).send({
    ok: false,
    code: 'NOT_IMPLEMENTED',
    message: '该接口将在后续版本实现。',
  }));
}
