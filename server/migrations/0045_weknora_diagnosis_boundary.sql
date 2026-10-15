-- Capability upgrades run once per installation; never recreate revoked mounts.
ALTER TABLE agent_market_installations ADD COLUMN IF NOT EXISTS knowledge_binding_version integer NOT NULL DEFAULT 0;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS source_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS agent_private boolean NOT NULL DEFAULT false;
ALTER TABLE conversation_run_steps ADD COLUMN IF NOT EXISTS knowledge_private boolean NOT NULL DEFAULT false;

-- Legacy diagnosis results are untrusted for cross-agent sharing, even before
-- the first WeKnora query. Keep user access and the original content intact.
UPDATE conversation_run_steps st SET knowledge_private=true
FROM conversation_runs r, conversations c, projects p, agent_market_installations i
WHERE r.id=st.run_id AND c.id=r.conversation_id AND p.id=c.project_id AND i.identity_id=p.owner_identity_id
  AND i.agent_id=st.assigned_agent_id AND i.template_code='home_ai_diagnosis';
UPDATE artifacts a SET source_agent_id=st.assigned_agent_id,agent_private=st.knowledge_private
FROM runtime_tool_calls t, conversation_run_steps st
WHERE a.tool_call_id=t.id AND t.step_id=st.id;
-- Older multi-file receipts may only link the first artifact to a call. Their
-- Recover those origins from the server-created receipt rather than isolating
-- unrelated user and ordinary-agent artifacts in the same conversation.
UPDATE artifacts a SET source_agent_id=st.assigned_agent_id,agent_private=st.knowledge_private
FROM runtime_tool_calls t, conversation_run_steps st, conversation_runs r
WHERE a.source_agent_id IS NULL AND t.step_id=st.id AND st.run_id=r.id
  AND a.conversation_id=r.conversation_id AND a.identity_id=t.identity_id
  AND (t.tool_name LIKE 'local_%' OR t.tool_name IN ('artifact_write','artifact_compose'))
  AND (t.result->>'artifactId'=a.id::text OR t.result->'artifactIds' ? a.id::text);
UPDATE artifacts a SET agent_private=true
WHERE a.source_agent_id IS NULL AND EXISTS (
  SELECT 1 FROM conversation_run_steps st JOIN conversation_runs r ON r.id=st.run_id
  WHERE st.knowledge_private AND r.conversation_id=a.conversation_id
    AND st.result->'artifactIds' ? a.id::text
);

-- Prevent legacy name-only context fallback after the user renames an agent.
UPDATE messages m SET metadata=metadata||'{"diagnosisPrivate":true}'::jsonb
WHERE m.sender_type='agent' AND EXISTS (
  SELECT 1 FROM conversation_run_steps st JOIN conversation_runs r ON r.id=st.run_id
  WHERE st.knowledge_private AND r.conversation_id=m.conversation_id
    AND (m.metadata->>'agentId'=st.assigned_agent_id::text
      OR (m.metadata->>'agentId' IS NULL AND m.sender_name=st.agent_snapshot->>'name'))
);
UPDATE memories m SET metadata=metadata||'{"diagnosisPrivate":true}'::jsonb
WHERE EXISTS (
  SELECT 1 FROM conversation_run_steps st JOIN conversation_runs r ON r.id=st.run_id
  WHERE st.knowledge_private AND COALESCE(m.metadata->>'conversationId',m.metadata->>'chatId')=r.conversation_id::text
    AND (COALESCE(m.metadata->>'agentId',m.metadata->>'sourceAgentId')=st.assigned_agent_id::text
      OR (COALESCE(m.metadata->>'agentId',m.metadata->>'sourceAgentId') IS NULL
        AND COALESCE(m.metadata->>'agentName',m.metadata->>'sourceAgentName')=st.agent_snapshot->>'name'))
);
