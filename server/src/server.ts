import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { registerRoutes } from './routes.js';
import { PostgresAccountRepository } from './repositories/index.js';
import { PostgresDatabase } from './database/postgres.js';
import { RedisDatabase } from './infrastructure/redis.js';

export async function createServer() {
  const config = loadConfig();
  const app = Fastify({ logger: config.nodeEnv !== 'test' });
  await app.register(cors, { origin: true });
  await app.register(sensible);
  const database = new PostgresDatabase(config.databaseUrl, config.databaseSchema);
  const redis = new RedisDatabase(config.redisUrl);
  await database.migrate(config.databaseSchema);
  if (!database.rawPool) throw new Error('DATABASE_URL 未配置');
  await registerRoutes(app, { accounts: new PostgresAccountRepository(database.rawPool), database, redis });
  app.addHook('onClose', async () => { await database.close(); await redis.close(); });
  return { app, config, database, redis };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, config } = await createServer();
  await app.listen({ host: config.host, port: config.port });
}
