INSERT INTO agent_tool_mounts(agent_id,tool_code)
SELECT agent_id,'artifact_compose' FROM agent_tool_mounts WHERE tool_code='artifact_write'
ON CONFLICT DO NOTHING;
