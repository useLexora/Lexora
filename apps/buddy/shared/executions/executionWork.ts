import { z } from 'zod'

const withinBytes = (limit: number) => (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length <= limit

const text = z.string().trim().min(1).max(8000)
export const executionBriefSchema = z.object({
  objective: text,
  deliverables: z.array(text).max(16).default([]),
  constraints: z.array(text).max(16).default([]),
  acceptance: z.array(text).max(16).default([]),
}).strict().refine(withinBytes(8192), 'Keep the serialized brief within 8 KiB')

export const executionSubmissionSchema = z.object({
  summary: text,
  evidence: z.array(text).max(32),
  limitations: z.array(text).max(16),
}).strict().refine(withinBytes(8192), 'Keep the serialized submission within 8 KiB')

export const executionReviewSchema = z.object({
  verdict: z.enum(['accepted', 'rework', 'blocked']),
  reason: text,
  evidence: z.array(text).max(32),
}).strict().refine(withinBytes(4096), 'Keep the serialized review within 4 KiB')

export const executionContextModeSchema = z.enum(['isolated', 'conversation'])
export const executionWorkSchema = z.object({
  runId: z.string().min(1),
  workId: z.string().min(1),
  previousRunId: z.string().min(1).nullable(),
  contextMode: executionContextModeSchema,
  contextSourceIds: z.array(z.string().min(1)).max(64),
  brief: executionBriefSchema.nullable(),
  submission: executionSubmissionSchema.nullable(),
  review: executionReviewSchema.nullable(),
}).strict()

export type ExecutionContextMode = z.infer<typeof executionContextModeSchema>
export type ExecutionBrief = z.infer<typeof executionBriefSchema>
export type ExecutionSubmission = z.infer<typeof executionSubmissionSchema>
export type ExecutionReview = z.infer<typeof executionReviewSchema>

export function renderExecutionBrief(brief: ExecutionBrief): string {
  return [
    brief.objective,
    ...([['Deliverables', brief.deliverables], ['Constraints', brief.constraints], ['Acceptance criteria', brief.acceptance]] as const)
      .filter(([, values]) => values.length)
      .map(([heading, values]) => `${heading}:\n${values.map(value => `- ${value}`).join('\n')}`),
  ].join('\n\n')
}
