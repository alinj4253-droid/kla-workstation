import { z } from 'zod';

export const createTaskRequestSchema = z.object({
  title: z.string().trim().min(1, '请输入任务名称').max(200, '任务名称不能超过 200 字'),
}).strict();

export const taskDtoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: z.string(),
  result: z.record(z.unknown()).nullable(),
  created_at: z.string().datetime(),
});

export const updateTaskRequestSchema = z.object({ status: z.enum(['pending', 'completed']) }).strict();
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;

export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type TaskDto = z.infer<typeof taskDtoSchema>;
