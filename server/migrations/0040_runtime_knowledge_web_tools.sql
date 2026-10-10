-- Add the newly available server tools to the built in local worker while
-- retaining existing user managed mounts.
INSERT INTO agent_tool_mounts(agent_id, tool_code)
SELECT a.id, v.code
FROM agents a
JOIN (VALUES ('knowledge_ocr'), ('web_search')) v(code) ON true
WHERE a.name='本地执行智能体' AND a.type='official'
ON CONFLICT DO NOTHING;

INSERT INTO agent_skill_mounts(agent_id, skill_code)
SELECT a.id, v.code
FROM agents a
JOIN (VALUES ('knowledge_research'), ('web_research')) v(code) ON true
WHERE a.name='PPT助手' AND a.type='official'
ON CONFLICT DO NOTHING;
