export interface DatabaseClient {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
  transaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DatabaseHealth = {
  configured: boolean;
  connected: boolean;
  engine: 'postgresql';
};
