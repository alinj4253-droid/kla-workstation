import Fastify from 'fastify';
import cors from '@fastify/cors';
import { describe, expect, it } from 'vitest';
import { corsOptions } from './server.js';

describe('browser API preflight', () => {
  it('allows authenticated agent model mounts from the desktop preview', async () => {
    const app = Fastify();
    await app.register(cors, corsOptions);
    try {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/agents/00000000-0000-0000-0000-000000000000',
        headers: {
          origin: 'http://127.0.0.1:5173',
          'access-control-request-method': 'PATCH',
          'access-control-request-headers': 'authorization,content-type,x-identity-id',
        },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
      expect(response.headers['access-control-allow-methods']).toContain('PATCH');
      expect(response.headers['access-control-allow-headers']).toContain('x-identity-id');
    } finally {
      await app.close();
    }
  });
});
