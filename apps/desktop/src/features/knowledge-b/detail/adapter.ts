import type { DocumentDetail } from '@kla-workstation/contracts/knowledge';

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isDocumentIdentity(value: string, docId: string): boolean {
  return value === docId || UUID_PATTERN.test(value);
}

/** Convert the API DTO into labels suitable for the document detail header. */
export function adaptDocumentDetail(detail: DocumentDetail, displayName?: string) {
  const mappedName = nonEmpty(displayName);
  const reportedName = nonEmpty(detail.name);
  const name = mappedName && !isDocumentIdentity(mappedName, detail.doc_id)
    ? mappedName
    : reportedName && !isDocumentIdentity(reportedName, detail.doc_id)
      ? reportedName
      : '文档名称未提供';

  return {
    name,
    sourceCategory: nonEmpty(detail.category) ?? '—',
    format: nonEmpty(detail.ext)?.toUpperCase() ?? '—',
    size: formatSize(detail.size),
    modified: nonEmpty(detail.modified) ?? '—',
    readable: detail.readable,
    editable: detail.editable,
    stale: detail.stale,
    hasBackup: detail.has_backup,
    backupTime: nonEmpty(detail.backup_time),
  };
}
