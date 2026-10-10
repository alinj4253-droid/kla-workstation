import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { toolReceiptSchema } from '@kla-workstation/contracts';
import { validateLocalArtifacts } from './local-artifacts.js';

function receipt() {
  const file = (fileName: string, mimeType: string, bytes: Buffer) => ({
    fileName, mimeType, content: bytes.toString('base64'), contentEncoding: 'base64',
    checksum: createHash('sha256').update(bytes).digest('hex'),
  });
  return toolReceiptSchema.parse({
    receiptId: randomUUID(), status: 'completed', approval: { approved: true, decidedAt: new Date().toISOString() },
    result: { qc: { ok: true, blocked: 0 }, renderStatus: 'completed' },
    artifacts: [
      file('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', Buffer.from([80, 75, 3, 4, 1, 2])),
      file('deck.pdf', 'application/pdf', Buffer.from('%PDF-1.7\n')),
      file('deck.png', 'image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    ],
  });
}

describe('local artifact quality and transport boundary', () => {
  it('validates binary bytes, sizes and checksums for the entire batch', () => {
    const files = validateLocalArtifacts('local_ppt_build', receipt());
    expect(files.map(file => file.sizeBytes)).toEqual([6, 9, 8]);
    expect(files.every(file => file.contentEncoding === 'base64')).toBe(true);
  });
  it('rejects a later corrupt file rather than accepting a partial batch', () => {
    const body = receipt();
    body.artifacts![2].checksum = '0'.repeat(64);
    expect(() => validateLocalArtifacts('local_ppt_build', body)).toThrow('校验和');
  });
  it('requires successful quality checks, approval and a successful render if requested', () => {
    const body = receipt();
    body.result.qc = { ok: false, blocked: 1 };
    expect(() => validateLocalArtifacts('local_ppt_build', body)).toThrow('质检');
    body.result.qc = { ok: true, blocked: 0 };
    body.result.renderStatus = 'failed';
    expect(() => validateLocalArtifacts('local_ppt_build', body)).toThrow('质检');
    body.result.renderStatus = 'unavailable';
    expect(validateLocalArtifacts('local_ppt_build', body)).toHaveLength(3);
    body.approval.approved = false;
    expect(() => validateLocalArtifacts('local_ppt_build', body)).toThrow('未经审批');
  });
  it('rejects MIME spoofing, noncanonical base64, duplicate names and non-PPT binary uploads', () => {
    const body = receipt();
    body.artifacts![0].mimeType = 'text/html';
    expect(() => validateLocalArtifacts('local_ppt_build', body)).toThrow('类型');
    body.artifacts![0].mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    body.artifacts![0].content += '\n';
    expect(() => validateLocalArtifacts('local_ppt_build', body)).toThrow('Base64');
    const duplicates = receipt();
    duplicates.artifacts!.push(duplicates.artifacts![0]);
    expect(() => validateLocalArtifacts('local_ppt_build', duplicates)).toThrow('重复');
    expect(() => validateLocalArtifacts('local_write', receipt())).toThrow('文本');
    expect(() => validateLocalArtifacts('local_ppt_inspect', receipt())).toThrow('不接受成果');
  });
});
