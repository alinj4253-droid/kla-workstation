import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { loadConfig } from './config.js';
import { registerRoutes } from './routes.js';
import { MemoryAccountRepository } from './repositories/index.js';

export async function createServer() {
  const config = loadConfig();
  const app = Fastify({ logger: config.nodeEnv !== 'test' });
  await app.register(cors, { origin: true });
  await app.register(sensible);
  await registerRoutes(app, { accounts: new MemoryAccountRepository() });
  return { app, config };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { app, config } = await createServer();
  await app.listen({ host: config.host, port: config.port });
}
