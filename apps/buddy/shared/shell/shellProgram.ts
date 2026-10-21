import { z } from 'zod'

export const shellDialectSchema = z.enum(['bash', 'zsh', 'sh', 'powershell', 'cmd'])
export type ShellDialect = z.infer<typeof shellDialectSchema>

export const shellProgramSchema = z.object({
  dialect: shellDialectSchema,
  executable: z.string().min(1).max(4096).refine(value => /^(?:\/|[a-z]:[\\/])/i.test(value) && !value.includes('\0')),
}).strict()
export type ShellProgram = z.infer<typeof shellProgramSchema>

export const shellCandidateIdSchema = z.enum(['bash', 'git-bash', 'zsh', 'sh', 'powershell7', 'powershell51', 'cmd'])
export type ShellCandidateId = z.infer<typeof shellCandidateIdSchema>

export const shellCandidateSchema = z.object({
  id: shellCandidateIdSchema,
  label: z.string(),
  dialect: shellDialectSchema,
  executable: z.string(),
  version: z.string(),
  available: z.boolean(),
  reason: z.string().optional(),
}).strict()
export type ShellCandidate = z.infer<typeof shellCandidateSchema>
