// @vitest-environment node
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { normalizeCollaborationMode, resolveCollaborationMode } from './collaboration-mode';

describe('collaboration mode', () => {
  it('defaults invalid and legacy messages to expert', () => {
    expect(normalizeCollaborationMode('fast')).toBe('fast');
    expect(normalizeCollaborationMode('balanced')).toBe('balanced');
    expect(normalizeCollaborationMode('expert')).toBe('expert');
    expect(normalizeCollaborationMode('unknown')).toBe('expert');

    const db = new Database(':memory:');
    db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, content_json TEXT NOT NULL)');
    db.prepare('INSERT INTO messages VALUES (?, ?)').run('legacy', JSON.stringify({ text: 'hello' }));
    expect(resolveCollaborationMode(db, 'legacy')).toBe('expert');
    expect(resolveCollaborationMode(db, 'missing')).toBe('expert');
    db.close();
  });

  it('reads fast mode from the root trigger message', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, content_json TEXT NOT NULL)');
    db.prepare('INSERT INTO messages VALUES (?, ?)').run('root', JSON.stringify({ text: 'task', collaborationMode: 'fast' }));
    expect(resolveCollaborationMode(db, 'root')).toBe('fast');
    db.close();
  });

  it('reads balanced mode from the root trigger message', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, content_json TEXT NOT NULL)');
    db.prepare('INSERT INTO messages VALUES (?, ?)').run('root', JSON.stringify({ text: 'task', collaborationMode: 'balanced' }));
    expect(resolveCollaborationMode(db, 'root')).toBe('balanced');
    db.close();
  });
});
