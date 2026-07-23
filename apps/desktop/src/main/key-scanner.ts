import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

export interface ScanFinding {
  location: string;
  column: string;
  pattern: string;
  sample: string;
  severity: 'high' | 'medium' | 'low';
}

export interface ScanResult {
  passed: boolean;
  findings: ScanFinding[];
  scannedTables: number;
  scannedRows: number;
  scannedLogFiles: number;
}

const PATTERNS: Array<{ name: string; regex: RegExp; severity: 'high' | 'medium' | 'low' }> = [
  { name: 'api-key', regex: /(?:api[_-]?key|apikey|api_key)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}/i, severity: 'high' },
  { name: 'bearer-token', regex: /bearer\s+[A-Za-z0-9_\-.:]{20,}/i, severity: 'high' },
  { name: 'auth-token', regex: /(?:token|auth_token|access_token|refresh_token)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}/i, severity: 'high' },
  { name: 'secret-key', regex: /(?:secret|secret_key|secretKey)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}/i, severity: 'high' },
  { name: 'password', regex: /(?:password|passwd|pwd)\s*[:=]\s*['"]?[A-Za-z0-9!@#$%^&*()_+\-=\[\]{}|;:',.<>?]{8,}/i, severity: 'high' },
  { name: 'private-key', regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/, severity: 'high' },
  { name: 'jwt-token', regex: /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/, severity: 'high' },
  { name: 'sk-key', regex: /sk-[A-Za-z0-9_\-]{20,}/, severity: 'high' },
];

function scanText(text: string, location: string, column: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const p of PATTERNS) {
    const matches = text.match(p.regex);
    if (matches) {
      const full = matches[0];
      findings.push({
        location,
        column,
        pattern: p.name,
        sample: full.length > 40 ? full.slice(0, 20) + '...' + full.slice(-17) : full,
        severity: p.severity,
      });
    }
  }
  return findings;
}

interface TableInfo {
  name: string;
  columns: string[];
}

function getTextColumns(db: Database.Database): TableInfo[] {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_migrations'"
  ).all() as Array<{ name: string }>;

  const result: TableInfo[] = [];
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info('${t.name}')`).all() as Array<{ name: string; type: string }>;
    const textCols = cols
      .filter((c) => /text|varchar|char|json/i.test(c.type))
      .map((c) => c.name);
    if (textCols.length > 0) result.push({ name: t.name, columns: textCols });
  }
  return result;
}

export function scanDatabase(db: Database.Database): { findings: ScanFinding[]; scannedTables: number; scannedRows: number } {
  const findings: ScanFinding[] = [];
  let scannedRows = 0;

  const tables = getTextColumns(db);

  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM "${table.name}"`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      scannedRows++;
      for (const col of table.columns) {
        const val = row[col];
        if (typeof val === 'string' && val.length > 0) {
          findings.push(...scanText(val, table.name, col));
        }
      }
    }
  }

  return { findings, scannedTables: tables.length, scannedRows };
}

export function scanLogFiles(logDir: string): { findings: ScanFinding[]; scannedFiles: number } {
  const findings: ScanFinding[] = [];
  let scannedFiles = 0;

  try {
    const entries = readdirSync(logDir);
    for (const entry of entries) {
      const fullPath = join(logDir, entry);
      try {
        if (statSync(fullPath).isFile()) {
          scannedFiles++;
          const content = readFileSync(fullPath, 'utf-8');
          findings.push(...scanText(content, `logs/${entry}`, 'file-content'));
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* log dir not found */ }

  return { findings, scannedFiles };
}

export function runKeyScan(db: Database.Database, logDir?: string): ScanResult {
  const dbResult = scanDatabase(db);
  const logResult = logDir ? scanLogFiles(logDir) : { findings: [], scannedFiles: 0 };

  const allFindings = [...dbResult.findings, ...logResult.findings];

  return {
    passed: allFindings.length === 0,
    findings: allFindings,
    scannedTables: dbResult.scannedTables,
    scannedRows: dbResult.scannedRows,
    scannedLogFiles: logResult.scannedFiles,
  };
}
