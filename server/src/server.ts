import Fastify, { LogController } from 'fastify';
import { realpathSync } from 'node:fs';
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
import { registerRuntimeRoutes } from './runtime/routes.js';
import { buildLoggerOptions, createRequestIdGenerator, shouldQuietRequestLogging } from './observability/logger.js';
import { Sub2ApiClient } from './compute/sub2api-client.js';
import { ComputeRepository } from './compute/compute-repository.js';
import { createPointsConverter } from './compute/points.js';
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
import { MemoryRetentionWorker, ShortTermMemoryService } from './memories/short-term.js';
import { ObjectStore } from './storage/object-store.js';

export const corsOptions = { origin: true, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] };

export async function createServer() {
  const config = loadConfig();
  // logController 是 Fastify v5 的日志控制器（v6 将移除顶层 disableRequestLogging 选项）：
  // 按路由压掉设备心跳 poll 的 incoming/completed 请求日志，见 observability/logger.ts
  const app = Fastify({
    logger: buildLoggerOptions(config),
    genReqId: createRequestIdGenerator(),
    logController: new LogController({ disableRequestLogging: shouldQuietRequestLogging }),
  });
  await app.register(cors, corsOptions);
  await app.register(sensible);
  const database = new PostgresDatabase(config.databaseUrl, config.databaseSchema);
  const redis = new RedisDatabase(config.redisUrl);
  await database.migrate(config.databaseSchema);
  if (!database.rawPool) throw new Error('DATABASE_URL 未配置');
  const pool = database.rawPool;
  const accounts = new PostgresAccountRepository(pool);
  const objectStore = new ObjectStore(config.objectStoragePath);
  await objectStore.ensureRoot();

  // 算力模块装配
  const sub2api = new Sub2ApiClient(config.sub2api, redis);
  const points = createPointsConverter(config.compute.pointsPerUsd);
  const computeRepo = new ComputeRepository(pool, points);
  const provisioning = new ProvisioningService(computeRepo, sub2api, config.sub2api, config.compute.secretEncryptionKey);
  const quota = new QuotaService(pool, computeRepo, sub2api, points);
  app.decorate('quotaService', quota);
  const gateway = new ComputeGateway({
    computeRepo,
    quota,
    sub2api,
    encryptionKey: config.compute.secretEncryptionKey,
    minReserveUsd: config.compute.minReserveUsd,
    points,
    timeoutMs: config.compute.modelTimeoutMs,
    toolTimeoutMs: config.compute.toolModelTimeoutMs,
  });

  const shortTermMemory = new ShortTermMemoryService(pool);
  const memoryRetention = new MemoryRetentionWorker(shortTermMemory, error => app.log.error({ err: error }, 'Memory retention failed'));
  const loopWorker = new AgentLoopWorker(pool, accounts, gateway, shortTermMemory, process.env.KNOWLEDGE_SECRET_ENCRYPTION_KEY || config.compute.secretEncryptionKey, error => app.log.error({err:error}, 'Agent loop failed'), objectStore, config.agentStepMaxTurns);
  await registerRoutes(app, { accounts, database, redis, gateway, shortTermMemory, loopWorker, objectStore, objectStorageMaxFileBytes: config.objectStorageMaxFileBytes });
  await registerRuntimeRoutes(app, {pool, accounts, worker:loopWorker, computeRepo, sub2api, encryptionKey:config.compute.secretEncryptionKey, objectStore});
  await registerKnowledgeRoutes(app, { accounts, pool, store: new PostgresKnowledgeStore(pool), encryptionKey: process.env.KNOWLEDGE_SECRET_ENCRYPTION_KEY || config.compute.secretEncryptionKey });
  await registerComputeRoutes(app, { accounts, computeRepo, quota });
  await registerComputeRoutesB(app, { accounts, computeRepo, sub2api, encryptionKey: config.compute.secretEncryptionKey });
  await registerComputeAccountRoutes(app, { accounts, computeRepo, sub2api, provisioning, encryptionKey: config.compute.secretEncryptionKey, quota });
  await registerComputeKeyRoutes(app, {
    accounts,
    computeRepo,
    sub2api,
    encryptionKey: config.compute.secretEncryptionKey,
    defaultGroupId: config.sub2api.defaultGroupId,
  });
  await registerComputeGatewayRoutes(app, { accounts, computeRepo, gateway });

  const outboxWorker = new OutboxWorker(computeRepo, provisioning, config.compute.outboxIntervalMs);
  const usageSyncWorker = new UsageSyncWorker(computeRepo, sub2api, quota, config.compute.usageSyncIntervalMs, config.compute.reserveTimeoutMs, config.compute.balanceReconcileIntervalMs);
  loopWorker.start();
  outboxWorker.start();
  usageSyncWorker.start();
  memoryRetention.start();

  app.addHook('onClose', async () => {
    await loopWorker.stop();
    await Promise.all([outboxWorker.stop(), usageSyncWorker.stop()]);
    await memoryRetention.stop();
    await database.close();
    await redis.close();
  });
  return { app, config, database, redis, loopWorker, outboxWorker, usageSyncWorker, quota, objectStore };
}

// 入口守卫：比较真实路径，兼容 /opt|/home/kla/current 软链部署模式。
// process.argv[1] 是命令行传入的路径（可能是软链），而 import.meta.url 已被
// Node 解析为真实路径，直接用 resolve() 比对会因软链不匹配而静默跳过启动。
const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();
if (isDirectRun) {
  const { app, config } = await createServer();
  await app.listen({ host: config.host, port: config.port });
}
