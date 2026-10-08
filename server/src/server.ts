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
import { AgentLoopWorker } from './infrastructure/agent-loop.js';
import { buildLoggerOptions, createRequestIdGenerator } from './observability/logger.js';
import { Sub2ApiClient } from './compute/sub2api-client.js';
import { ComputeRepository } from './compute/compute-repository.js';
import { ProvisioningService } from './compute/provisioning-service.js';
import { QuotaService } from './compute/quota-service.js';
import { OutboxWorker } from './compute/outbox-worker.js';
import { UsageSyncWorker } from './compute/usage-sync-worker.js';
import { registerComputeRoutes } from './compute/routes.js';
import { registerComputeRoutesB } from './compute/routes-b.js';
import { registerComputeAccountRoutes } from './compute/routes-b-account.js';
import { registerComputeKeyRoutes } from './compute/routes-b-keys.js';
import { registerComputeGatewayRoutes } from './compute/routes-b-gateway.js';
import { registerKnowledgeRoutes } from './knowledge-api/routes.js';
import { PostgresKnowledgeStore } from './knowledge-api/context.js';
import { ComputeGateway } from './compute/gateway.js';

export async function createServer() {
  const config = loadConfig();
  const app = Fastify({ logger: buildLoggerOptions(config), genReqId: createRequestIdGenerator() });
  await app.register(cors, { origin: true });
  await app.register(sensible);
  const database = new PostgresDatabase(config.databaseUrl, config.databaseSchema);
  const redis = new RedisDatabase(config.redisUrl);
  await database.migrate(config.databaseSchema);
  if (!database.rawPool) throw new Error('DATABASE_URL 未配置');
  const pool = database.rawPool;
  const accounts = new PostgresAccountRepository(pool);

  // 算力模块装配
  const sub2api = new Sub2ApiClient(config.sub2api, redis);
  const computeRepo = new ComputeRepository(pool);
  const provisioning = new ProvisioningService(computeRepo, sub2api, config.sub2api, config.compute.secretEncryptionKey);
  const quota = new QuotaService(pool, computeRepo, sub2api);
  app.decorate('quotaService', quota);
  const gateway = new ComputeGateway({
    computeRepo,
    quota,
    sub2api,
    encryptionKey: config.compute.secretEncryptionKey,
    minReserveUsd: config.compute.minReserveUsd,
    timeoutMs: config.sub2api.timeoutMs,
  });

  await registerRoutes(app, { accounts, database, redis, gateway });
  await registerKnowledgeRoutes(app, { accounts, pool, store: new PostgresKnowledgeStore(pool), encryptionKey: process.env.KNOWLEDGE_SECRET_ENCRYPTION_KEY || config.compute.secretEncryptionKey });
  await registerComputeRoutes(app, { accounts, computeRepo, quota });
  await registerComputeRoutesB(app, { accounts, computeRepo });
  await registerComputeAccountRoutes(app, { accounts, computeRepo, sub2api, provisioning, quota });
  await registerComputeKeyRoutes(app, {
    accounts,
    computeRepo,
    sub2api,
    encryptionKey: config.compute.secretEncryptionKey,
    defaultGroupId: config.sub2api.defaultGroupId,
  });
  await registerComputeGatewayRoutes(app, { accounts, computeRepo, gateway });

  const loopWorker = new AgentLoopWorker(pool, accounts);
  const outboxWorker = new OutboxWorker(computeRepo, provisioning, config.compute.outboxIntervalMs);
  const usageSyncWorker = new UsageSyncWorker(computeRepo, sub2api, config.compute.usageSyncIntervalMs);
  loopWorker.start();
  outboxWorker.start();
  usageSyncWorker.start();

  app.addHook('onClose', async () => {
    loopWorker.stop();
    outboxWorker.stop();
    usageSyncWorker.stop();
    await database.close();
    await redis.close();
  });
  return { app, config, database, redis, loopWorker, outboxWorker, usageSyncWorker, quota };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, config } = await createServer();
  await app.listen({ host: config.host, port: config.port });
}
