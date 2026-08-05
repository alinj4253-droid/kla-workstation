import type Database from 'better-sqlite3';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectRoot, getStudioRoot } from './paths';

const safeJson = (value: unknown): string => JSON.stringify(value).replaceAll('<', '\\u003c');

function graphHtml(graph: { nodes: unknown[]; edges: unknown[] }): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>知识图谱</title><style>
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#20242c;background:#f7f8fa}header{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 20px;background:#fff;border-bottom:1px solid #e5e7eb}header strong{font-size:16px}.meta{color:#6b7280;font-size:12px}svg{display:block;width:100vw;height:calc(100vh - 56px)}line{stroke:#c7ccd5;stroke-width:1.2}.node circle{stroke:#fff;stroke-width:2}.node text{font-size:11px;fill:#30343b;pointer-events:none}.edge-label{font-size:9px;fill:#8a9099}.empty{padding:48px;text-align:center;color:#777}</style></head><body><header><strong>知识图谱</strong><span class="meta" id="meta"></span></header><svg id="graph"></svg><script>
const graph=${safeJson(graph)};const svg=document.getElementById('graph'),meta=document.getElementById('meta');meta.textContent=graph.nodes.length+' 个实体 · '+graph.edges.length+' 条关系';
const W=svg.clientWidth,H=svg.clientHeight;if(!graph.nodes.length){svg.outerHTML='<div class="empty">尚未生成知识图谱</div>'}else{const NS='http://www.w3.org/2000/svg',byId=new Map();graph.nodes.forEach((n,i)=>{n.x=W/2+Math.cos(i*2.4)*Math.min(W,H)*.32;n.y=H/2+Math.sin(i*2.4)*Math.min(W,H)*.32;n.vx=0;n.vy=0;byId.set(n.id,n)});const edgeEls=graph.edges.map(e=>{const line=document.createElementNS(NS,'line');svg.append(line);return{e,line}});const nodeEls=graph.nodes.map((n,i)=>{const g=document.createElementNS(NS,'g');g.classList.add('node');const c=document.createElementNS(NS,'circle');c.setAttribute('r','7');c.setAttribute('fill',['#2563eb','#0f9f75','#d97706','#dc4c64','#7c3aed'][i%5]);const t=document.createElementNS(NS,'text');t.setAttribute('x','11');t.setAttribute('y','4');t.textContent=n.canonicalName;g.append(c,t);svg.append(g);return{n,g}});for(let tick=0;tick<260;tick++){for(const a of graph.nodes){for(const b of graph.nodes){if(a===b)continue;const dx=a.x-b.x,dy=a.y-b.y,d2=Math.max(dx*dx+dy*dy,80),f=50/d2;a.vx+=dx*f;a.vy+=dy*f}a.vx+=(W/2-a.x)*.0008;a.vy+=(H/2-a.y)*.0008}for(const e of graph.edges){const a=byId.get(e.sourceNodeId),b=byId.get(e.targetNodeId);if(!a||!b)continue;const dx=b.x-a.x,dy=b.y-a.y,d=Math.max(Math.hypot(dx,dy),1),f=(d-110)*.0015;a.vx+=dx/d*f;a.vy+=dy/d*f;b.vx-=dx/d*f;b.vy-=dy/d*f}for(const n of graph.nodes){n.vx*=.86;n.vy*=.86;n.x=Math.max(16,Math.min(W-120,n.x+n.vx));n.y=Math.max(16,Math.min(H-16,n.y+n.vy))}}edgeEls.forEach(({e,line})=>{const a=byId.get(e.sourceNodeId),b=byId.get(e.targetNodeId);if(a&&b){line.setAttribute('x1',a.x);line.setAttribute('y1',a.y);line.setAttribute('x2',b.x);line.setAttribute('y2',b.y)}});nodeEls.forEach(({n,g})=>g.setAttribute('transform','translate('+n.x+' '+n.y+')'))}</script></body></html>`;
}

function wikiHtml(pages: Array<{ slug: string; title: string; bodyMd: string | null }>): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>知识 Wiki</title><style>
*{box-sizing:border-box}body{margin:0;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;color:#252932;background:#fff}.layout{display:grid;grid-template-columns:250px 1fr;height:100vh}aside{padding:18px;border-right:1px solid #e7e9ee;background:#f8f9fb;overflow:auto}input{width:100%;height:34px;border:1px solid #d9dde5;border-radius:6px;padding:0 10px;margin:12px 0}.item{display:block;width:100%;border:0;background:none;text-align:left;padding:8px;border-radius:5px;cursor:pointer}.item:hover,.item.active{background:#e9eefb;color:#1d4ed8}main{padding:30px 42px;overflow:auto;max-width:980px}pre{white-space:pre-wrap;font:inherit}h1{font-size:24px}</style></head><body><div class="layout"><aside><strong>知识 Wiki</strong><input id="q" placeholder="搜索条目"><div id="list"></div></aside><main><h1 id="title">选择一个条目</h1><pre id="body"></pre></main></div><script>
const pages=${safeJson(pages)};const list=document.getElementById('list'),q=document.getElementById('q'),title=document.getElementById('title'),body=document.getElementById('body');function render(filter=''){list.innerHTML='';pages.filter(p=>(p.title+' '+p.bodyMd).toLowerCase().includes(filter.toLowerCase())).forEach((p,i)=>{const b=document.createElement('button');b.className='item';b.textContent=p.title;b.onclick=()=>{document.querySelectorAll('.item').forEach(x=>x.classList.remove('active'));b.classList.add('active');title.textContent=p.title;body.textContent=p.bodyMd||''};list.append(b);if(i===0&&!body.textContent)b.click()})}q.oninput=()=>render(q.value);render();</script></body></html>`;
}

export async function materializeKnowledgeArtifacts(db: Database.Database, scopeType: string, scopeId: string): Promise<void> {
  const root = scopeType === 'shared' ? join(getStudioRoot(), 'shared-knowledge') : getProjectRoot(scopeId);
  const nodes = db.prepare(
    'SELECT id, node_type as nodeType, canonical_name as canonicalName, summary, confidence FROM knowledge_nodes WHERE scope_type = ? AND scope_id = ?',
  ).all(scopeType, scopeId) as unknown[];
  const edges = db.prepare(
    'SELECT id, source_node_id as sourceNodeId, target_node_id as targetNodeId, edge_type as edgeType, confidence FROM knowledge_edges WHERE scope_type = ? AND scope_id = ?',
  ).all(scopeType, scopeId) as unknown[];
  const pages = db.prepare(
    'SELECT slug, title, body_md as bodyMd FROM wiki_pages WHERE scope_type = ? AND scope_id = ? ORDER BY title',
  ).all(scopeType, scopeId) as Array<{ slug: string; title: string; bodyMd: string | null }>;
  const documents = db.prepare(
    `SELECT p.source_id as sourceId, f.name as fileName, p.summary, p.keywords_json as keywordsJson,
            p.tags_json as tagsJson, p.language, p.metadata_json as metadataJson
     FROM knowledge_document_profiles p JOIN knowledge_sources s ON s.id = p.source_id
     LEFT JOIN files f ON f.id = s.file_id WHERE s.scope_type = ? AND s.scope_id = ? AND s.status = 'ready'`,
  ).all(scopeType, scopeId) as unknown[];
  const graphDir = join(root, 'graph-visualization');
  const wikiDir = join(root, 'knowledge', 'wiki');
  const knowledgeDir = join(root, 'knowledge');
  await Promise.all([mkdir(graphDir, { recursive: true }), mkdir(wikiDir, { recursive: true }), mkdir(knowledgeDir, { recursive: true })]);
  await Promise.all([
    writeFile(join(graphDir, 'knowledge-graph.html'), graphHtml({ nodes, edges }), 'utf8'),
    writeFile(join(graphDir, 'knowledge-graph.json'), JSON.stringify({ nodes, edges }, null, 2), 'utf8'),
    writeFile(join(wikiDir, 'index.html'), wikiHtml(pages), 'utf8'),
    writeFile(join(knowledgeDir, 'knowledge-index.json'), JSON.stringify({ documents, generatedAt: new Date().toISOString() }, null, 2), 'utf8'),
  ]);
}
