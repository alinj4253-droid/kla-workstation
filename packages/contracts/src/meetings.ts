import { z } from 'zod';

/** 会议行（GET/POST /api/v1/meetings，数据库原始行透传）。 */
export const meetingSchema = z
  .object({
    id: z.string().min(1),
    identity_id: z.string().min(1),
    project_id: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    input_type: z.enum(['audio_upload', 'realtime']),
    status: z.string(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .passthrough();

export type Meeting = z.infer<typeof meetingSchema>;

export const createMeetingRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputType: z.enum(['audio_upload', 'realtime']),
  projectId: z.string().min(1).optional(),
});

export type CreateMeetingRequest = z.infer<typeof createMeetingRequestSchema>;

/** 会议转写片段（GET /meetings/{id} 的 segments、POST transcript 返回）。 */
export const meetingSegmentSchema = z
  .object({
    id: z.string().min(1),
    meeting_id: z.string().min(1),
    speaker: z.string(),
    content: z.string(),
    start_ms: z.number().int().nullable(),
    end_ms: z.number().int().nullable(),
    confidence: z.number().nullable(),
    created_at: z.string().datetime(),
  })
  .passthrough();

export type MeetingSegment = z.infer<typeof meetingSegmentSchema>;

/** GET /api/v1/meetings/{id}：会议详情 + 转写片段。 */
export const meetingDetailSchema = meetingSchema.extend({
  segments: z.array(meetingSegmentSchema),
});

export type MeetingDetail = z.infer<typeof meetingDetailSchema>;

export const addMeetingTranscriptRequestSchema = z.object({
  speaker: z.string().optional(),
  content: z.string().min(1),
  startMs: z.number().int().min(0).optional(),
  endMs: z.number().int().min(0).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export type AddMeetingTranscriptRequest = z.infer<typeof addMeetingTranscriptRequestSchema>;
