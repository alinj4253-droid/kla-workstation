import type { Pool } from 'pg';
import type { MemoryBrowserAgent, MemoryBrowserEntry, MemoryBrowserPage, MemoryBrowserQuery, MemoryBrowserScopes } from '@kla-workstation/contracts';
import { shortTermTimeWeight } from '@kla-workstation/contracts';
import { shortTermRetainedUntil } from './short-term.js';

// All branches are scoped by the server-resolved identity. Metadata IDs are compared
// as text, so malformed or historical metadata cannot cause UUID cast failures.
// Historical browsing is independent from the bounded/weighted conversation context.
const entriesCte = `WITH owned_projects AS (
  SELECT DISTINCT p.id,p.name FROM projects p
  JOIN project_members pm ON pm.project_id=p.id AND pm.identity_id=$1
  JOIN conversation_members cm ON cm.project_id=p.id AND cm.identity_id=$1
  JOIN identities i ON i.id=$1 AND i.status='active'
  WHERE (p.organization_id IS NULL AND i.type='personal' AND p.owner_identity_id=i.id
    OR p.organization_id=i.organization_id AND i.type='enterprise')
), owned_conversations AS (
  SELECT c.id,c.name,c.project_id,p.name AS project_name
  FROM conversations c JOIN owned_projects p ON p.id=c.project_id
  JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.identity_id=$1
), stored AS (
  SELECT 'memory:' || m.id::text AS id,m.content,m.kind,
    CASE WHEN m.kind IN ('short_term','short-term','task_summary','task_context') THEN 'short_term' ELSE 'long_term' END AS term,
    'stored_memory'::text AS source,p.id::text AS project_id,p.name AS project_name,
    c.id::text AS conversation_id,c.name AS conversation_name,
    CASE WHEN a.id IS NOT NULL THEN a.id::text
      WHEN COALESCE(m.metadata->>'agentName',m.metadata->>'sourceAgentName') IS NOT NULL
      THEN 'name:' || COALESCE(m.metadata->>'agentName',m.metadata->>'sourceAgentName')
      ELSE 'unattributed' END AS agent_key,
    COALESCE(a.name,m.metadata->>'agentName',m.metadata->>'sourceAgentName','未标注智能体') AS agent_name,
    false AS shared,COALESCE(m.metadata->>'sourceMessageId',m.metadata->>'messageId') AS source_message_id,
    m.created_at,m.updated_at,m.expires_at,m.last_reinforced_at,m.retained_until
  FROM memories m JOIN workspaces w ON w.id=m.workspace_id AND w.identity_id=$1
  LEFT JOIN owned_conversations c ON c.id::text=COALESCE(m.metadata->>'conversationId',m.metadata->>'chatId')
  LEFT JOIN owned_projects p ON p.id::text=COALESCE(c.project_id::text,w.project_id::text,m.metadata->>'projectId')
  LEFT JOIN LATERAL (
    SELECT id,name FROM agents
    WHERE (identity_id=$1 OR (identity_id IS NULL AND type='official'))
      AND (id::text=COALESCE(m.metadata->>'agentId',m.metadata->>'sourceAgentId')
        OR name=COALESCE(m.metadata->>'agentName',m.metadata->>'sourceAgentName'))
    ORDER BY (id::text=COALESCE(m.metadata->>'agentId',m.metadata->>'sourceAgentId')) DESC NULLS LAST,id LIMIT 1
  ) a ON true
  WHERE (m.expires_at IS NULL OR m.expires_at>now())
    AND (m.retained_until IS NULL OR m.retained_until>now())
    AND c.id IS NOT NULL
    AND (w.project_id IS NULL OR p.id=w.project_id)
    AND (m.metadata->>'projectId' IS NULL OR p.id::text=m.metadata->>'projectId')
), recent_messages AS (
  SELECT m.*,c.project_id,c.project_name,c.name AS conversation_name,
    m.created_at AS last_reinforced_at
  FROM messages m JOIN owned_conversations c ON c.id=m.conversation_id
  WHERE m.created_at>now()-interval '365 days' AND m.sender_type IN ('user','agent')
), context AS (
  SELECT 'message:' || m.id::text AS id,m.text AS content,'conversation_context'::text AS kind,
    'short_term'::text AS term,'conversation_context'::text AS source,
    m.project_id::text,m.project_name,m.conversation_id::text,m.conversation_name,
    CASE WHEN m.sender_type='user' THEN 'shared'
      WHEN a.id IS NOT NULL THEN a.id::text ELSE 'name:' || COALESCE(m.sender_name,'未标注智能体') END AS agent_key,
    CASE WHEN m.sender_type='user' THEN '共享对话上下文'
      ELSE COALESCE(a.name,m.sender_name,'未标注智能体') END AS agent_name,
    m.sender_type='user' AS shared,m.id::text AS source_message_id,
    m.created_at,m.created_at AS updated_at,NULL::timestamptz AS expires_at,
    m.last_reinforced_at,m.created_at+interval '365 days' AS retained_until
  FROM recent_messages m
  LEFT JOIN LATERAL (
    SELECT id,name FROM agents
    WHERE (identity_id=$1 OR (identity_id IS NULL AND type='official'))
      AND (id::text=m.metadata->>'agentId' OR name=m.sender_name)
    ORDER BY (id::text=m.metadata->>'agentId') DESC NULLS LAST,id LIMIT 1
  ) a ON true
), entries AS (SELECT * FROM stored UNION ALL SELECT * FROM context)`;

type EntryRow = {
  id: string; content: string; term: MemoryBrowserEntry['term']; kind: string;
  source: MemoryBrowserEntry['source']; project_id: string | null; project_name: string | null;
  conversation_id: string | null; conversation_name: string | null; agent_key: string;
  agent_name: string; shared: boolean; source_message_id: string | null;
  created_at: Date; updated_at: Date; expires_at: Date | null; last_reinforced_at: Date; retained_until: Date | null;
};
const iso = (value: Date | string) => new Date(value).toISOString();
const mapEntry = (row: EntryRow): MemoryBrowserEntry => ({
  id: row.id, content: row.content, term: row.term, kind: row.kind, source: row.source,
  projectId: row.project_id, projectName: row.project_name,
  conversationId: row.conversation_id, conversationName: row.conversation_name,
  agentKey: row.agent_key, agentName: row.agent_name, shared: row.shared,
  sourceMessageId: row.source_message_id, createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at), expiresAt: row.expires_at ? iso(row.expires_at) : null,
  reinforcedAt: iso(row.last_reinforced_at ?? row.created_at),
  retainedUntil: row.term === 'short_term' ? (row.retained_until ? iso(row.retained_until) : shortTermRetainedUntil(iso(row.created_at))) : null,
  timeWeight: row.term === 'short_term' ? shortTermTimeWeight(row.last_reinforced_at ?? row.created_at) : null,
});

export class MemoryBrowserRepository {
  constructor(private readonly pool: Pool) {}

  async scopes(identityId: string): Promise<MemoryBrowserScopes> {
    const [projects, conversations, sources, totals] = await Promise.all([
      this.pool.query<{ id: string; name: string }>(`SELECT DISTINCT p.id,p.name,p.created_at FROM projects p
        JOIN project_members pm ON pm.project_id=p.id AND pm.identity_id=$1
        JOIN conversation_members cm ON cm.project_id=p.id AND cm.identity_id=$1
        JOIN identities i ON i.id=$1 AND i.status='active'
        WHERE (p.organization_id IS NULL AND i.type='personal' AND p.owner_identity_id=i.id
          OR p.organization_id=i.organization_id AND i.type='enterprise') ORDER BY p.created_at DESC,p.id`, [identityId]),
      this.pool.query<{ id: string; name: string; project_id: string }>(`SELECT c.id,c.name,c.project_id FROM conversations c
        JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.identity_id=$1
        JOIN project_members pm ON pm.project_id=cm.project_id AND pm.identity_id=$1
        JOIN projects p ON p.id=c.project_id JOIN identities i ON i.id=$1 AND i.status='active'
        WHERE (p.organization_id IS NULL AND i.type='personal' AND p.owner_identity_id=i.id
          OR p.organization_id=i.organization_id AND i.type='enterprise') ORDER BY c.created_at DESC,c.id`, [identityId]),
      this.pool.query<{ project_id: string | null; conversation_id: string | null; agent_key: string; agent_name: string }>(`${entriesCte}
        SELECT DISTINCT project_id,conversation_id,agent_key,agent_name FROM entries WHERE NOT shared
        UNION SELECT c.project_id::text,ca.conversation_id::text,a.id::text,a.name
        FROM conversation_agents ca JOIN owned_conversations c ON c.id=ca.conversation_id
        JOIN agents a ON a.id=ca.agent_id WHERE a.identity_id=$1 OR (a.identity_id IS NULL AND a.type='official')`, [identityId]),
      this.pool.query<{ long_term: number; short_term: number; latest: Date | null }>(`${entriesCte}
        SELECT count(*) FILTER(WHERE term='long_term')::int AS long_term,
          count(*) FILTER(WHERE term='short_term')::int AS short_term,max(updated_at) AS latest FROM entries`, [identityId]),
    ]);
    const uniqueAgents = (rows: typeof sources.rows): MemoryBrowserAgent[] => Array.from(new Map(rows.map(row => [row.agent_key, { key: row.agent_key, name: row.agent_name }])).values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const summary = totals.rows[0];
    return {
      projects: projects.rows.map(row => ({ ...row, agents: uniqueAgents(sources.rows.filter(source => source.project_id === row.id)) })),
      conversations: conversations.rows.map(row => ({ id: row.id, name: row.name, projectId: row.project_id, agents: uniqueAgents(sources.rows.filter(source => source.conversation_id === row.id)) })),
      agents: uniqueAgents(sources.rows),
      counts: { longTerm: summary?.long_term ?? 0, shortTerm: summary?.short_term ?? 0 },
      latestUpdatedAt: summary?.latest ? iso(summary.latest) : null,
    };
  }

  async entries(identityId: string, query: MemoryBrowserQuery): Promise<MemoryBrowserPage> {
    const filtered = `${entriesCte}, filtered AS (SELECT * FROM entries
      WHERE ($2::text IS NULL OR project_id=$2) AND ($3::text IS NULL OR conversation_id=$3)
        AND ($4::text IS NULL OR agent_key=$4 OR (shared AND term='short_term')) AND term=$5
        AND ($8::timestamptz IS NULL OR created_at>=$8) AND ($9::timestamptz IS NULL OR created_at<=$9))`;
    // One statement gives total and page from the same database snapshot, including an empty page.
    const result = await this.pool.query<{ total: number; items: EntryRow[] }>(`${filtered}
      SELECT (SELECT count(*)::int FROM filtered) AS total,
        COALESCE((SELECT jsonb_agg(row_to_json(e)) FROM (
          SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT $6 OFFSET $7
        ) e),'[]'::jsonb) AS items`, [identityId, query.projectId ?? null, query.conversationId ?? null, query.agentKey ?? null, query.term, query.pageSize, (query.page - 1) * query.pageSize, query.from ?? null, query.to ?? null]);
    return { items: (result.rows[0]?.items ?? []).map(mapEntry), page: { page: query.page, pageSize: query.pageSize, total: result.rows[0]?.total ?? 0 } };
  }
}
