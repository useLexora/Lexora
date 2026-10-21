import { z } from 'zod'
import { shellCandidateIdSchema, shellCandidateSchema } from '../shell/shellProgram.ts'
import { extensionSettingIdSchema, extensionSettingKeySchema } from './extensionSettings.ts'

export const extensionShellContributionSchema = z.object({
  settingsGroup: extensionSettingIdSchema.optional(),
  candidates: z.array(z.object({
    id: shellCandidateIdSchema,
    enabled: extensionSettingKeySchema,
    executable: extensionSettingKeySchema,
    priority: extensionSettingKeySchema,
  }).strict()).min(1).max(7),
}).strict().superRefine(({ candidates }, context) => {
  if (new Set(candidates.map(candidate => candidate.id)).size !== candidates.length)
    context.addIssue({ code: 'custom', message: 'Shell candidates must be unique' })
  const keys = candidates.flatMap(candidate => [candidate.enabled, candidate.executable, candidate.priority])
  if (new Set(keys).size !== keys.length)
    context.addIssue({ code: 'custom', message: 'Shell settings must be distinct' })
})

export type ExtensionShellContribution = z.infer<typeof extensionShellContributionSchema>

export const extensionShellDescriptorSchema = z.object({
  extensionId: z.string().min(1).max(120),
  revision: z.string().min(1),
  configurationRevision: z.string().min(1),
  candidates: z.array(shellCandidateSchema).max(7),
  preferred: z.array(shellCandidateIdSchema).max(7),
}).strict()
export type ExtensionShellDescriptor = z.infer<typeof extensionShellDescriptorSchema>

export const extensionShellRpc = {
  list: 'host.extensions.shells.list',
  changed: 'host.extensions.shells.changed',
} as const
