import Fastify, { LogController } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { PostgresDatabase } from '../database/postgres.js';
import { loadConfig } from '../config.js';
import { registerKnowledgeRoutes } from '../knowledge-api/routes.js';
import { MemoryKnowledgeStore } from '../knowledge-api/context.js';
import { registerRoutes } from '../routes.js';
import { buildLoggerOptions, createRequestIdGenerator, shouldQuietRequestLogging } from '../observability/logger.js';
import { CatalogPool } from './catalog-pool.js';
import { MemoryAccountRepository } from './memory-account-repository.js';

/**
 * Mock server：无 PostgreSQL/Redis 依赖的服务端联调模式。
 * 复用 registerRoutes 与统一响应契约，数据全部保存在内存，
 * 重启即重置；用于前端联调、契约测试和无数据库环境冒烟。
 */
export async function createMockServer(options: { seedDemoAccount?: boolean; logger?: boolean } = {}) {
  const config = loadConfig();
  const app = Fastify({
    logger: options.logger ?? buildLoggerOptions(config),
    genReqId: createRequestIdGenerator(),
    logController: new LogController({ disableRequestLogging: shouldQuietRequestLogging }),
  });
  await app.register(cors, { origin: true });
  await app.register(sensible);
  const accounts = new MemoryAccountRepository();
  if (options.seedDemoAccount !== false) accounts.seedDemoAccount();
  const database = {
    rawPool: new CatalogPool(accounts),
    check: async () => ({ configured: false, connected: false, error: 'mock 模式不连接 PostgreSQL' }),
  } as unknown as PostgresDatabase;
  await registerRoutes(app, { accounts, database, mode: 'mock' });
  await registerKnowledgeRoutes(app, { accounts, store: new MemoryKnowledgeStore(), mock: true });
  return { app, config, accounts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, config } = await createMockServer();
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`KLA mock server 已启动（mock 模式，无数据库依赖）：http://${config.host}:${config.port}`);
}
