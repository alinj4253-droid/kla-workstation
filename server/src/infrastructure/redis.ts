import { createClient, type RedisClientType } from 'redis';

export type RedisCheck = {
  configured: boolean;
  connected: boolean;
  database?: number;
  latencyMs?: number;
  error?: string;
};

export class RedisDatabase {
  private readonly client: RedisClientType | null;
  private connecting: Promise<void> | null = null;
  private readonly database: number;

  constructor(private readonly url: string) {
    this.client = url ? createClient({ url }) : null;
    const parsed = url ? new URL(url) : null;
    this.database = parsed?.pathname.match(/^\/(\d+)$/)?.[1] ? Number(parsed.pathname.slice(1)) : 0;
    this.client?.on('error', () => undefined);
  }

  async check(): Promise<RedisCheck> {
    if (!this.client) return { configured: false, connected: false, error: 'REDIS_URL 未配置' };
    const started = Date.now();
    try {
      if (!this.client.isOpen) {
        this.connecting ??= this.client.connect().then(() => undefined).finally(() => { this.connecting = null; });
        await this.connecting;
      }
      await this.client.ping();
      return { configured: true, connected: true, database: this.database, latencyMs: Date.now() - started };
    } catch (error) {
      return { configured: true, connected: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    if (this.client?.isOpen) await this.client.quit();
  }
}
