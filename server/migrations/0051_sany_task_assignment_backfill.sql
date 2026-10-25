-- 为 0050 之前已存在的任务补齐派发记录（assignment）：
-- 每个任务一条，关联到责任单元对应的 owner 成员，保证任务收束链路（提交 / 退回 / 通过 / 收束）可用。
-- 已有 assignment 的任务不受影响（NOT EXISTS 保护）。

INSERT INTO sany_task_assignments (project_id, task_id, member_id, assignee_identity_id, assigned_by_identity_id, status, individual_note, assigned_at)
SELECT p.id, t.id, m.id, m.identity_id, p.owner_identity_id,
  CASE
    WHEN t.status = '已提交' THEN 'submitted'
    WHEN t.status IN ('已通过', '已收束') THEN 'accepted'
    WHEN t.status = '已退回' THEN 'returned'
    WHEN t.status IN ('分析中', '校验中', '待补充') THEN 'in_progress'
    ELSE 'assigned'
  END,
  t.individual_note,
  COALESCE(t.assigned_at::timestamptz, now())
FROM sany_tasks t
JOIN sany_projects p ON p.id = t.project_id
JOIN sany_members m ON m.project_id = p.id AND m.role = 'owner' AND m.name = t.owner_name AND m.unit = t.unit
WHERE NOT EXISTS (SELECT 1 FROM sany_task_assignments a WHERE a.task_id = t.id)
ORDER BY t.sort_order;
