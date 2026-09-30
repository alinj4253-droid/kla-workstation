import { Pool } from 'pg';
import { runMigrations } from './migrations.js';

export type PostgresCheck = {
  configured: boolean;
  connected: boolean;
  database?: string;
  serverVersion?: string;
  latencyMs?: number;
  error?: string;
};

/** Small connection-pool boundary used by health checks and future repositories. */
export class PostgresDatabase {
  private readonly pool: Pool | null;

  constructor(connectionString: string, schema = 'kla') {
    this.pool = connectionString ? new Pool({ connectionString, options: `-c search_path=${schema},public`, max: 5, connectionTimeoutMillis: 5000 }) : null;
  }

  get rawPool(): Pool | null { return this.pool; }

  async migrate(schema = 'kla'): Promise<void> {
    if (!this.pool) throw new Error('DATABASE_URL 未配置');
    await runMigrations(this.pool, schema);
  }

  async check(): Promise<PostgresCheck> {
    if (!this.pool) return { configured: false, connected: false, error: 'DATABASE_URL 未配置' };
    const started = Date.now();
    try {
      const result = await this.pool.query<{ database: string; server_version: string }>('SELECT current_database() AS database, version() AS server_version');
      return { configured: true, connected: true, database: result.rows[0]?.database, serverVersion: result.rows[0]?.server_version, latencyMs: Date.now() - started };
    } catch (error) {
      return { configured: true, connected: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}
