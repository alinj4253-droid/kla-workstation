import { loadConfig } from '../config.js';
import { PostgresDatabase } from './postgres.js';

const config = loadConfig();
const database = new PostgresDatabase(config.databaseUrl, config.databaseSchema);

try {
  await database.migrate(config.databaseSchema);
  const health = await database.check();
  if (!health.connected) throw new Error(health.error ?? '数据库连接校验失败');
  console.log(`Database migrations are current: ${health.database} (schema ${config.databaseSchema})`);
} finally {
  await database.close();
}
