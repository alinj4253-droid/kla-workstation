import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { toolReceiptSchema } from '@kla-workstation/contracts';

type Receipt = z.infer<typeof toolReceiptSchema>;
const pptMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Validate the entire batch before the receipt transaction inserts any file. */
export function validateLocalArtifacts(tool: string, receipt: Receipt) {
  if (receipt.artifact && receipt.artifacts?.length) throw new Error('单文件和多文件成果不能同时提交');
  const files = receipt.artifacts ?? (receipt.artifact ? [receipt.artifact] : []);
  if (!files.length) return [];
  if (receipt.status !== 'completed' || !receipt.approval.approved) throw new Error('失败或未经审批的调用不能上传成果');
  const ppt = ['local_ppt_build', 'local_ppt_render'].includes(tool);
  if (!ppt && !['local_write', 'local_code'].includes(tool)) throw new Error('此调用不接受成果');
  if (!ppt && (files.length !== 1 || files[0].contentEncoding !== 'utf8' || files[0].content.length > 1_000_000)) throw new Error('文本工具仅接受一份不超过 100 万字符的文本成果');
  const qc = receipt.result.qc as { ok?: boolean; blocked?: number } | undefined;
  if (ppt && (qc?.ok !== true || qc.blocked !== 0 || receipt.result.error || receipt.result.renderStatus === 'failed')) throw new Error('PPT 质检未通过，不能交付成果');
  const names = new Set<string>();
  let total = 0;
  return files.map(file => {
    if (names.has(file.fileName)) throw new Error('成果文件名重复');
    names.add(file.fileName);
    const bytes = Buffer.from(file.content, file.contentEncoding === 'base64' ? 'base64' : 'utf8');
    if (file.contentEncoding === 'base64' && bytes.toString('base64') !== file.content) throw new Error('成果 Base64 编码无效');
    total += bytes.length;
    if (bytes.length > 16 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new Error('成果超过单文件 16 MiB 或总计 32 MiB 限制');
    if (createHash('sha256').update(bytes).digest('hex') !== file.checksum) throw new Error('成果校验和不一致');
    if (ppt) {
      const extension = file.fileName.split('.').pop()?.toLowerCase();
      const valid = extension === 'pptx' ? file.mimeType === pptMime && bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))
        : extension === 'pdf' ? file.mimeType === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-'
        : extension === 'png' ? file.mimeType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        : extension === 'json' && file.mimeType === 'application/json';
      if (!valid) throw new Error('PPT 成果文件类型与内容不匹配');
      if (extension === 'json') JSON.parse(bytes.toString('utf8'));
      else if (file.contentEncoding !== 'base64') throw new Error('二进制成果必须使用 Base64');
    }
    return { ...file, sizeBytes: bytes.length };
  });
}
