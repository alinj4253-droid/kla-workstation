import Database from 'better-sqlite3';

let _db: Database.Database | null = null;

export function getDatabase(dbPath: string): Database.Database {
  if (_db && _db.name === dbPath) return _db;
  closeDatabase();

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');
  return _db;
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
