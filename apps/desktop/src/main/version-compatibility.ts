export type VersionStatus = 'compatible' | 'incompatible' | 'experimental' | 'unknown';

export interface KnownVersionRange {
  min: string;
  max: string;
  label: string;
}

const ADAPTER_RANGES: Record<string, KnownVersionRange[]> = {
  'codex': [
    { min: '0.1.0', max: '1.99.99', label: '>=0.1.0 <=1.99.99' },
  ],
  'claude-code': [
    { min: '0.1.0', max: '9.99.99', label: '>=0.1.0 <=9.99.99' },
  ],
  'opencode': [
    { min: '0.1.0', max: '9.99.99', label: '>=0.1.0 <=9.99.99' },
  ],
  'codegeex': [
    { min: '0.1.0', max: '9.99.99', label: '>=0.1.0 <=9.99.99' },
  ],
  'kimi': [
    { min: '0.1.0', max: '9.99.99', label: '>=0.1.0 <=9.99.99' },
  ],
  'minimax': [
    { min: '0.1.0', max: '9.99.99', label: '>=0.1.0 <=9.99.99' },
  ],
  'marcode': [
    { min: '0.1.0', max: '9.99.99', label: '>=0.1.0 <=9.99.99' },
  ],
  'aion': [
    { min: '0.1.0', max: '9.99.99', label: '>=0.1.0 <=9.99.99' },
  ],
  'gemini': [
    { min: '0.1.0', max: '9.99.99', label: '>=0.1.0 <=9.99.99' },
  ],
  'qwen-code': [
    { min: '0.1.0', max: '9.99.99', label: '>=0.1.0 <=9.99.99' },
  ],
  'codebuddy': [
    { min: '0.1.0', max: '9.99.99', label: '>=0.1.0 <=9.99.99' },
  ],
};

function parseSemver(v: string): { major: number; minor: number; patch: number } | null {
  const m = v.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return { major: parseInt(m[1]!, 10), minor: parseInt(m[2]!, 10), patch: parseInt(m[3] ?? '0', 10) };
}

function lt(a: { major: number; minor: number; patch: number }, b: { major: number; minor: number; patch: number }): boolean {
  if (a.major !== b.major) return a.major < b.major;
  if (a.minor !== b.minor) return a.minor < b.minor;
  return a.patch < b.patch;
}

function gte(a: { major: number; minor: number; patch: number }, b: { major: number; minor: number; patch: number }): boolean {
  return !lt(a, b);
}

function lte(a: { major: number; minor: number; patch: number }, b: { major: number; minor: number; patch: number }): boolean {
  return lt(a, b) || (a.major === b.major && a.minor === b.minor && a.patch === b.patch);
}

export function checkVersionCompatibility(adapterType: string, rawVersion: string | null): VersionStatus {
  const version = rawVersion?.trim() ?? null;
  if (!version) return 'unknown';

  const parsed = parseSemver(version);
  if (!parsed) return 'unknown';

  const ranges = ADAPTER_RANGES[adapterType];
  if (!ranges || ranges.length === 0) {
    return 'unknown';
  }

  const lowestMin = ranges.reduce((a, b) => lt(parseSemver(a.min)!, parseSemver(b.min)!) ? a : b);
  const lowestParsed = parseSemver(lowestMin.min)!;

  if (lt(parsed, lowestParsed)) {
    return 'incompatible';
  }

  for (const range of ranges) {
    const minParsed = parseSemver(range.min)!;
    const maxParsed = parseSemver(range.max)!;
    if (gte(parsed, minParsed) && lte(parsed, maxParsed)) {
      return 'compatible';
    }
  }

  return 'experimental';
}

export function getKnownRanges(adapterType: string): KnownVersionRange[] {
  return ADAPTER_RANGES[adapterType] ?? [];
}
