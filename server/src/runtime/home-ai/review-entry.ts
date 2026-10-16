import type { Pool } from 'pg';
import { homeAiReviewEntrySchema } from '@kla-workstation/contracts';

/** Read-only presentation metadata. Installation and room membership remain authoritative. */
export async function readHomeAiReviewEntry(pool:Pool, scope:{identityId:string;conversationId:string}) {
  const {rows}=await pool.query(`WITH eligible AS (
    SELECT a.id FROM conversation_agents ca JOIN agents a ON a.id=ca.agent_id
    JOIN agent_market_installations m ON m.agent_id=a.id AND m.identity_id=a.identity_id
    WHERE ca.conversation_id=$2 AND a.identity_id=$1 AND a.enabled
      AND m.template_code='home_ai_diagnosis'
  ), steps AS (
    SELECT s.id,s.assigned_agent_id,s.status,r.id AS run_id,r.status AS run_status
    FROM conversation_run_steps s JOIN conversation_runs r ON r.id=s.run_id
    JOIN conversations c ON c.id=r.conversation_id JOIN projects p ON p.id=c.project_id
    LEFT JOIN messages trigger ON trigger.id=r.trigger_message_id
    WHERE r.conversation_id=$2 AND s.assigned_agent_id IN (SELECT id FROM eligible)
      AND COALESCE(r.trigger_identity_id,trigger.sender_identity_id,p.owner_identity_id)=$1
  ), replies AS (
    SELECT m.id,m.created_at FROM messages m
    WHERE m.conversation_id=$2 AND m.sender_type='agent'
      AND COALESCE(m.metadata->'delivery'->'delivery'->>'audience','user')<>'agent'
      AND (m.metadata ? 'delivery' OR (COALESCE(m.metadata->>'recipient','')<>'coordinator'
        AND COALESCE(m.metadata->>'kind','')<>'delegation'))
      AND EXISTS(SELECT 1 FROM steps s WHERE m.metadata->>'runId'=s.run_id::text
        AND (m.metadata->>'runStepId'=s.id::text OR m.metadata->>'agentId'=s.assigned_agent_id::text))
  ) SELECT EXISTS(SELECT 1 FROM eligible) AS eligible,
    (EXISTS(SELECT 1 FROM replies) OR EXISTS(
      SELECT 1 FROM runtime_tool_calls t JOIN steps s ON s.id=t.step_id
      WHERE t.identity_id=$1 AND t.status='completed' AND left(t.tool_name,8)='home_ai_'
    )) AS active,
    EXISTS(SELECT 1 FROM steps WHERE run_status IN ('queued','running','waiting_device','waiting_tool','waiting_approval')
      AND status IN ('running','waiting_device','waiting_tool','waiting_approval')) AS processing,
    (SELECT id FROM replies ORDER BY created_at DESC,id DESC LIMIT 1) AS "anchorMessageId"`, [scope.identityId,scope.conversationId]);
  return homeAiReviewEntrySchema.parse(rows[0]);
}
