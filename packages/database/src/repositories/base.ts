import type Database from 'better-sqlite3';

export abstract class BaseRepository {
  constructor(protected readonly db: Database.Database) {}

  protected transaction<T>(fn: () => T): T {
    const txn = this.db.transaction(fn);
    return txn();
  }

  protected now(): string {
    return new Date().toISOString();
  }
}
