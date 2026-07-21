import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import type { Core, EventObject, NodeSingular, LayoutOptions } from 'cytoscape';
import { X, Search, ZoomIn, ZoomOut, Maximize2, Layers } from 'lucide-react';

type GraphProjection = {
  schemaVersion: number;
  scope: { type: string; id: string };
  graphVersion: string;
  elements: { data: Record<string, unknown> }[];
  filters: { nodeTypes: string[]; edgeTypes: string[] };
  constraints?: string;
};

type ProvenanceEntry = {
  sourceId: string; chunkId: string | null;
  locationJson: string | null; quoteHash: string | null;
  sourceFileName: string | null; chunkTextPreview: string | null;
};

type GraphViewerProps = {
  scopeType: 'project' | 'shared';
  scopeId: string;
  projectId: string;
  onClose: () => void;
};

const LAYOUTS = [
  { id: 'cose', label: '力导向' },
  { id: 'circle', label: '环形' },
  { id: 'grid', label: '网格' },
  { id: 'concentric', label: '同心圆' },
  { id: 'breadthfirst', label: '层次' },
] as const;

export function GraphViewer({ scopeType, scopeId, projectId, onClose }: GraphViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [projection, setProjection] = useState<GraphProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [activeNodeTypes, setActiveNodeTypes] = useState<Set<string>>(new Set());
  const [activeLayout, setActiveLayout] = useState('cose');
  const [selectedNode, setSelectedNode] = useState<{ id: string; label: string; nodeType: string; summary?: string; confidence: number } | null>(null);
  const [provenance, setProvenance] = useState<ProvenanceEntry[] | null>(null);
  const [provenanceLoading, setProvenanceLoading] = useState(false);

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        setLoading(true);
        const result = await window.kunqing?.knowledge.getGraphProjection({
          scopeType: scopeType === 'shared' ? 'shared' : 'group',
          scopeId,
          projectId,
          scopeType2: scopeType,
        }) as { ok: boolean; data?: GraphProjection } | undefined;
        if (result?.data) {
          setProjection(result.data);
          setActiveNodeTypes(new Set(result.data.filters.nodeTypes));
        } else {
          setError('图谱数据为空');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载图谱失败');
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [scopeType, scopeId, projectId]);

  useEffect(() => {
    if (!selectedNode) { setProvenance(null); return; }
    const fetchProvenance = async (): Promise<void> => {
      setProvenanceLoading(true);
      try {
        const result = await window.kunqing?.knowledge.getNodeProvenance({ targetType: 'node', targetId: selectedNode.id }) as { ok: boolean; data?: ProvenanceEntry[] } | undefined;
        setProvenance(result?.data ?? null);
      } catch {
        setProvenance(null);
      } finally {
        setProvenanceLoading(false);
      }
    };
    void fetchProvenance();
  }, [selectedNode]);

  const filteredElements = useMemo(() => {
    if (!projection) return [];
    const activeTypes = activeNodeTypes;
    return projection.elements.filter((el) => {
      const d = el.data;
      if (d.source !== undefined) return true;
      return activeTypes.has(d.nodeType as string);
    });
  }, [projection, activeNodeTypes]);

  const nodeTypes = useMemo(() => projection?.filters.nodeTypes ?? [], [projection]);

  const initCy = useCallback(() => {
    if (!containerRef.current || !projection) return;
    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }
    const cy = cytoscape({
      container: containerRef.current,
      elements: filteredElements,
      style: [
        { selector: 'node', style: { label: 'data(label)', 'background-color': '#4441cc', color: '#1a1c1f', 'font-size': '12px', 'text-valign': 'bottom', 'text-halign': 'center', 'padding-right': '4px', shape: 'round-rectangle', width: 'label' } as any },
        { selector: 'edge', style: { width: 1.5, 'line-color': '#c7c4d7', 'target-arrow-color': '#c7c4d7', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 0.7, 'font-size': '10px', color: '#777586' } },
        { selector: 'node:selected', style: { 'border-color': '#5e5ce6', 'border-width': 2 } },
        { selector: 'edge:selected', style: { 'line-color': '#5e5ce6', 'target-arrow-color': '#5e5ce6' } },
      ],
      layout: { name: activeLayout, animate: true } as unknown as LayoutOptions,
      zoomingEnabled: true,
      userZoomingEnabled: true,
      panningEnabled: true,
      userPanningEnabled: true,
      minZoom: 0.1,
      maxZoom: 4,
    });
    (cy as any).on('tap', 'node', (_evt: EventObject) => {
      const node = _evt.target as NodeSingular;
      setSelectedNode({
        id: node.id(),
        label: node.data('label'),
        nodeType: node.data('nodeType'),
        summary: node.data('summary'),
        confidence: node.data('confidence'),
      });
    });
    cy.on('tap', (_evt: EventObject) => {
      if (_evt.target === cy) setSelectedNode(null);
    });
    cyRef.current = cy;
  }, [projection, filteredElements, activeLayout]);

  useEffect(() => {
    if (projection) initCy();
    return () => { if (cyRef.current) { cyRef.current.destroy(); cyRef.current = null; } };
  }, [projection, initCy]);

  const handleLayoutChange = (layoutId: string): void => {
    setActiveLayout(layoutId);
    if (cyRef.current) {
      cyRef.current.layout({ name: layoutId, animate: true } as unknown as LayoutOptions).run();
    }
  };

  const toggleNodeType = (type: string): void => {
    setActiveNodeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const handleSearch = (value: string): void => {
    setSearch(value);
    const cy = cyRef.current;
    if (!cy) return;
    if (!value.trim()) {
      (cy.elements() as any).show();
      return;
    }
    const q = value.toLowerCase();
    cy.nodes().forEach((node) => {
      const label = String(node.data('label') ?? '').toLowerCase();
      if (label.includes(q)) {
        (node as any).show();
        (node.connectedEdges() as any).show();
      } else {
        (node as any).hide();
        (node.connectedEdges() as any).hide();
      }
    });
  };

  const zoomToFit = (): void => { cyRef.current?.fit(undefined, 50); };
  const zoomIn = (): void => { cyRef.current?.zoom(cyRef.current.zoom() * 1.3); };
  const zoomOut = (): void => { cyRef.current?.zoom(cyRef.current.zoom() / 1.3); };

  return (
    <div className="graph-viewer-overlay" role="presentation">
      <div className="graph-viewer">
        <header className="graph-viewer-header">
          <div className="graph-viewer-title">
            <h3>图谱可视化</h3>
            {projection && <span className="graph-viewer-meta">{projection.elements.filter((e) => !e.data.source).length} 节点 · {projection.elements.filter((e) => e.data.source).length} 边 · v{projection.graphVersion.slice(0, 10)}</span>}
          </div>
          <button type="button" className="icon-button" aria-label="关闭图谱" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="graph-viewer-toolbar">
          <div className="graph-viewer-search">
            <Search size={14} />
            <input placeholder="搜索节点…" value={search} onChange={(e) => handleSearch(e.target.value)} />
          </div>

          <div className="graph-viewer-controls">
            <div className="graph-viewer-filter-group">
              {nodeTypes.map((t) => (
                <button key={t} type="button" className={`graph-type-btn${activeNodeTypes.has(t) ? ' graph-type-btn--active' : ''}`} onClick={() => toggleNodeType(t)}>{t}</button>
              ))}
            </div>

            <div className="graph-viewer-layout-group">
              <Layers size={14} />
              <select value={activeLayout} onChange={(e) => handleLayoutChange(e.target.value)}>
                {LAYOUTS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </div>

            <div className="graph-viewer-zoom-group">
              <button type="button" className="icon-button" aria-label="缩小" onClick={zoomOut}><ZoomOut size={15} /></button>
              <button type="button" className="icon-button" aria-label="适应画布" onClick={zoomToFit}><Maximize2 size={15} /></button>
              <button type="button" className="icon-button" aria-label="放大" onClick={zoomIn}><ZoomIn size={15} /></button>
            </div>
          </div>
        </div>

        <div className="graph-viewer-body">
          <div className="graph-viewer-canvas" ref={containerRef}>
            {loading && <div className="graph-viewer-empty">加载图谱中…</div>}
            {error && <div className="graph-viewer-empty">{error}</div>}
            {projection?.constraints && <div className="graph-viewer-constraints">{projection.constraints}</div>}
          </div>

          {selectedNode && (
            <aside className="graph-viewer-detail">
              <h4>{selectedNode.label}</h4>
              <dl>
                <dt>类型</dt><dd>{selectedNode.nodeType}</dd>
                <dt>置信度</dt><dd>{Math.round(selectedNode.confidence * 100)}%</dd>
                {selectedNode.summary && <><dt>摘要</dt><dd>{selectedNode.summary}</dd></>}
              </dl>
              <div className="graph-viewer-provenance">
                <h4>来源</h4>
                {provenanceLoading ? (
                  <div className="graph-viewer-empty" style={{ padding: '8px 0', fontSize: '12px' }}>加载中…</div>
                ) : provenance && provenance.length > 0 ? (
                  provenance.map((p, i) => (
                    <div key={i} className="graph-viewer-provenance-item">
                      <div className="graph-viewer-provenance-file">{p.sourceFileName ?? '未知文件'}</div>
                      {p.chunkTextPreview && <div className="graph-viewer-provenance-text">{p.chunkTextPreview}</div>}
                      <div className="graph-viewer-provenance-meta">
                        {p.locationJson && <span>位置: {p.locationJson}</span>}
                        {p.quoteHash && <span>Hash: {p.quoteHash.slice(0, 16)}…</span>}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="graph-viewer-empty" style={{ padding: '8px 0', fontSize: '12px' }}>无来源记录</div>
                )}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
