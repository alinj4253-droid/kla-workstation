// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test', getVersion: () => '0.1.0-test' },
}));

import { scanDatabase, scanLogFiles, runKeyScan, type ScanResult } from './key-scanner';

function createTestDb(seedSecret: boolean): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE secrets (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ciphertext TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE model_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL);
    INSERT INTO settings (key, value_json, updated_at) VALUES ('theme', '{"value":"dark"}', '2024-01-01T00:00:00Z');
    INSERT INTO secrets (id, kind, ciphertext, created_at, updated_at) VALUES ('s1', 'api-key', 'encrypted:abc123def456', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');
  `);

  if (seedSecret) {
    db.exec(`
      INSERT INTO settings (key, value_json, updated_at) VALUES ('leak', '{"value":"sk-test1234567890abcdefghijklmnopqrstuvwxyz"}', '2024-01-01T00:00:00Z');
    `);
  }

  return db;
}

describe('key scanner', () => {
  it('passes when no secrets are leaked in plaintext', () => {
    const db = createTestDb(false);
    const result = scanDatabase(db);
    expect(result.findings).toHaveLength(0);
    expect(result.scannedTables).toBeGreaterThan(0);
    expect(result.scannedRows).toBeGreaterThan(0);
    db.close();
  });

  it('detects plaintext API keys in database', () => {
    const db = createTestDb(true);
    const result = scanDatabase(db);
    expect(result.findings.length).toBeGreaterThan(0);
    const apikeyFinding = result.findings.find((f) => f.pattern === 'sk-key');
    expect(apikeyFinding).toBeDefined();
    expect(apikeyFinding!.location).toBe('settings');
    expect(apikeyFinding!.severity).toBe('high');
    db.close();
  });

  it('detects plaintext bearer tokens in database', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE test_tokens (id TEXT PRIMARY KEY, token_value TEXT);
      INSERT INTO test_tokens VALUES ('t1', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNqPZx2tL7TGasPktoLkA9w');
    `);
    const result = scanDatabase(db);
    const jwtFinding = result.findings.find((f) => f.pattern === 'jwt-token');
    expect(jwtFinding).toBeDefined();
    expect(jwtFinding!.location).toBe('test_tokens');
    db.close();
  });

  it('detects plaintext private key material', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE test_keys (id TEXT PRIMARY KEY, pem TEXT);
      INSERT INTO test_keys VALUES ('k1', '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...');
    `);
    const result = scanDatabase(db);
    const pkFinding = result.findings.find((f) => f.pattern === 'private-key');
    expect(pkFinding).toBeDefined();
    expect(pkFinding!.severity).toBe('high');
    db.close();
  });

  it('returns passed=true when no findings exist', () => {
    const db = createTestDb(false);
    const result: ScanResult = { ...scanDatabase(db), scannedLogFiles: 0, passed: true, findings: [] };
    // use runKeyScan instead
    const full = runKeyScan(db);
    expect(full.passed).toBe(true);
    expect(full.findings).toHaveLength(0);
    db.close();
  });

  it('returns passed=false when findings exist', () => {
    const db = createTestDb(true);
    const full = runKeyScan(db);
    expect(full.passed).toBe(false);
    expect(full.findings.length).toBeGreaterThan(0);
    db.close();
  });

  it('scans log files for plaintext secrets', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'key-scan-test-'));
    try {
      writeFileSync(join(tmpDir, 'app.log'), 'INFO: api_key=sk-test1234567890abcdefghijklmnopqrstuvwxyz');
      writeFileSync(join(tmpDir, 'error.log'), 'ERROR: connection failed');
      const result = scanLogFiles(tmpDir);
      expect(result.scannedFiles).toBe(2);
      const leakFinding = result.findings.find((f) => f.pattern === 'api-key');
      expect(leakFinding).toBeDefined();
      expect(leakFinding!.location).toContain('app.log');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles missing log directory gracefully', () => {
    const result = scanLogFiles(join(tmpdir(), 'nonexistent-dir-12345'));
    expect(result.scannedFiles).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it('scans multiple tables', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE t1 (id TEXT, val TEXT);
      CREATE TABLE t2 (id TEXT, val TEXT);
      INSERT INTO t1 VALUES ('a1', 'Bearer sk-testAAAABBBBCCCCDDDD');
      INSERT INTO t2 VALUES ('a2', 'safe value');
    `);
    const result = scanDatabase(db);
    expect(result.scannedTables).toBe(2);
    const findings = result.findings;
    expect(findings.length).toBeGreaterThanOrEqual(1);
    db.close();
  });
});
