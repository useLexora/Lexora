import type { LoadedSkill } from './skillFiles'
import { basename } from 'node:path'
import { parseFrontmatter } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'

const metadataSchema = z.object({
  'name': z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  'description': z.string().trim().min(1).max(1024),
  'license': z.string().optional(),
  'compatibility': z.string().max(500).optional(),
  'metadata': z.record(z.string(), z.string()).optional(),
  'allowed-tools': z.string().optional(),
  'disable-model-invocation': z.boolean().optional(),
}).loose()

export function validateSkillForAuthoring(skill: LoadedSkill): string[] {
  const diagnostics: string[] = []
  const { frontmatter } = parseFrontmatter<Record<string, unknown>>(skill.content)
  const parsed = metadataSchema.safeParse(frontmatter)
  if (!parsed.success)
    diagnostics.push(...parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`))
  if (skill.name !== basename(skill.baseDirectory))
    diagnostics.push('The directory name must match the declared skill name.')
  if (!skill.body)
    diagnostics.push('SKILL.md must include instructions after the frontmatter.')
  return diagnostics
}
