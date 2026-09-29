import type { DatabaseClient, DatabaseHealth } from './types.js';

/** PostgreSQL adapter boundary; the real driver is intentionally not wired yet. */
export class PostgresPlaceholder implements DatabaseClient {
  constructor(private readonly connectionString: string) {}

  health(): DatabaseHealth {
    return { configured: Boolean(this.connectionString), connected: false, engine: 'postgresql' };
  }

  async query<T>(_sql: string, _params: readonly unknown[] = []): Promise<readonly T[]> {
    throw new Error('PostgreSQL adapter is not implemented yet.');
  }

  async transaction<T>(_work: (client: DatabaseClient) => Promise<T>): Promise<T> {
    throw new Error('PostgreSQL transactions are not implemented yet.');
  }

  async close(): Promise<void> {}
}
