import { z } from 'zod'
import { extensionPathSchema } from './extensionPath.ts'

export const extensionSkillContributionSchema = z.object({
  id: z.string().min(1).max(180).regex(/^[a-z][a-z0-9.-]+$/),
  path: extensionPathSchema.refine(path => path.endsWith('/SKILL.md'), 'Expected a packaged skill directory containing SKILL.md'),
}).strict()

export type ExtensionSkillContribution = z.infer<typeof extensionSkillContributionSchema>

export const extensionSkillDescriptorSchema = z.object({
  extensionId: z.string().min(1),
  extensionName: z.string().min(1),
  revision: z.string().min(1),
  root: z.string().min(1),
  enabled: z.boolean(),
  skills: z.array(extensionSkillContributionSchema),
  hashes: z.record(extensionPathSchema, z.string().regex(/^[a-f0-9]{64}$/)),
}).strict()

export type ExtensionSkillDescriptor = z.infer<typeof extensionSkillDescriptorSchema>

export const extensionSkillsRpc = {
  list: 'extensions.skills.list',
  changed: 'extensions.skills.changed',
} as const

export function extensionSkillRoots(skills: readonly ExtensionSkillContribution[]): string[] {
  return skills.map(skill => skill.path.slice(0, -'SKILL.md'.length))
}
