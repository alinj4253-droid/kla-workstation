import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle, RefreshCw } from 'lucide-react';
import { klaApi } from '../api/client';
import type { RoomArtifact } from './CollaborationViews';

type Previewer = ReturnType<typeof import('pptx-preview').init>;
const maxPreviewBytes = 64 * 1024 * 1024;

/** Renders the actual authenticated PPTX bytes; no public Office upload needed. */
export function PptxPreview({ artifact, pdf, onSelect }: { artifact: RoomArtifact; pdf?: RoomArtifact; onSelect: (id: string) => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<Previewer | null>(null);
  const [scale, setScale] = useState(0.3);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const fit = () => setScale(Math.max(0.05, element.clientWidth / 1280));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let previewer: Previewer | undefined;
    element.replaceChildren();
    setLoading(true); setError(''); setPage(0); setTotal(0);
    void (async () => {
      if (artifact.sizeBytes > maxPreviewBytes) throw new Error('文件超过 64 MB，请下载后打开。');
      let bytes: ArrayBuffer;
      if (artifact.storageKey || artifact.sourceKind === 'file') {
        const result = await klaApi.download(artifact.sourceKind === 'file' ? `/v1/files/${artifact.id}/content` : `/v1/artifacts/${artifact.id}/content`);
        if (!result.ok) throw new Error(result.message);
        if (result.blob.size > maxPreviewBytes) throw new Error('文件超过 64 MB，请下载后打开。');
        bytes = await result.blob.arrayBuffer();
      } else if (artifact.contentEncoding === 'base64' && artifact.content) {
        bytes = Uint8Array.from(atob(artifact.content), character => character.charCodeAt(0)).buffer;
      } else throw new Error('PPTX 文件内容不可用，请重新打开成果。');
      if (disposed) return;
      const { init } = await import('pptx-preview');
      if (disposed) return;
      previewer = init(element, { width: 1280, height: 720, mode: 'slide' });
      renderer.current = previewer;
      await previewer.load(bytes);
      if (disposed) { element.replaceChildren(); return; }
      if (!previewer.slideCount) throw new Error('此演示文稿没有可预览的幻灯片。');
      previewer.renderSingleSlide(0);
      setTotal(previewer.slideCount);
    })().catch((cause: unknown) => {
      if (!disposed) { element.replaceChildren(); setError(cause instanceof Error ? cause.message : 'PPTX 预览失败'); }
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; renderer.current = null; previewer?.destroy(); element.replaceChildren(); };
  }, [artifact.id, artifact.content, artifact.contentEncoding, artifact.storageKey, artifact.sourceKind, artifact.sizeBytes, revision]);

  const go = (next: number) => {
    if (loading || error || !renderer.current || next < 0 || next >= total) return;
    try { renderer.current.renderSingleSlide(next); setPage(next); }
    catch { setError('此页渲染失败，请重试或下载查看。'); }
  };
  return <div className="ws-pptx-preview" aria-label={`PPTX 预览：${artifact.name}`} tabIndex={0} onKeyDown={event => {
    if (['ArrowLeft', 'PageUp', 'ArrowRight', 'PageDown'].includes(event.key)) { event.preventDefault(); go(page + (['ArrowLeft', 'PageUp'].includes(event.key) ? -1 : 1)); }
  }}>
    <div className="ws-pptx-viewport" ref={viewport} style={{ height: 720 * scale }}>
      <div className="ws-pptx-renderer" ref={host} style={{ transform: `scale(${scale})` }} />
      {loading && <div className="ws-pptx-overlay" role="status"><LoaderCircle size={20} />正在解析幻灯片…</div>}
      {error && <div className="ws-pptx-overlay" role="alert"><span>无法预览 PPTX</span><small>{error}</small><button onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} />重试</button></div>}
    </div>
    <div className="ws-pptx-controls"><button aria-label="上一页幻灯片" disabled={loading || Boolean(error) || page === 0} onClick={() => go(page - 1)}><ChevronLeft size={16} /></button><span aria-live="polite">{total ? `${page + 1} / ${total}` : '幻灯片预览'}</span><button aria-label="下一页幻灯片" disabled={loading || Boolean(error) || page >= total - 1} onClick={() => go(page + 1)}><ChevronRight size={16} /></button></div>
    {pdf && <button className="ws-pptx-pdf" onClick={() => onSelect(pdf.id)}>查看实际渲染的 PDF 预览</button>}
    <small className="ws-pptx-hint">只读预览 · 字体、动画或复杂图表的效果以 PowerPoint / WPS 为准</small>
  </div>;
}
