-- The built-in local executor must expose local tools by default. User-created
-- agents and the coordinator keep their explicitly configured execution mode.
UPDATE agents
SET execution_location = 'local', device_id = NULL, version = version + 1
WHERE name = '本地执行智能体'
  AND type = 'official'
  AND execution_location <> 'local';
