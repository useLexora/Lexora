import { z } from 'zod'
import { buddyComposerDraftModelSelectionSchema } from '../conversation/composerDraft'
import { idSchema } from '../runtime/apiValidation'

const unique = (values: string[]) => new Set(values).size === values.length
const skillIdsSchema = z.array(idSchema).max(256).refine(unique)
const toolIdSchema = z.string().min(1).max(16384).refine((value) => {
  try {
    const identity: unknown = JSON.parse(value)
    return Array.isArray(identity) && identity.length === 3
      && identity.every(part => typeof part === 'string' && part.length > 0)
      && JSON.stringify(identity) === value
  }
  catch {
    return false
  }
})

export const buddyToolSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }).strict(),
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('selected'), ids: z.array(toolIdSchema).min(1).max(2048).refine(unique) }).strict(),
])
export const buddySkillSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }).strict(),
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('selected'), ids: skillIdsSchema.min(1) }).strict(),
])
export const buddyNpcConcurrencySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('limited'), limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ mode: z.literal('unlimited') }).strict(),
])

export const buddySettingsSchema = z.object({
  instructions: z.string().max(16000),
  model: buddyComposerDraftModelSelectionSchema.nullable(),
  tools: buddyToolSelectionSchema,
  skills: buddySkillSelectionSchema,
  requiredSkills: skillIdsSchema,
  npcIds: z.array(idSchema).max(256),
  npcConcurrency: buddyNpcConcurrencySchema,
  limits: z.object({ fileAccess: z.enum(['inherit', 'read_only']) }).strict(),
}).strict().refine(settings => settings.requiredSkills.every(id => settings.skills.mode === 'all'
  || (settings.skills.mode === 'selected' && settings.skills.ids.includes(id))), {
  path: ['requiredSkills'],
  message: 'Required skills must be included in the discoverable skill scope',
})

export type BuddySettings = z.infer<typeof buddySettingsSchema>
export const DEFAULT_BUDDY_SETTINGS: BuddySettings = {
  instructions: '',
  model: null,
  tools: { mode: 'all' },
  skills: { mode: 'all' },
  requiredSkills: [],
  npcIds: [],
  npcConcurrency: { mode: 'limited', limit: 5 },
  limits: { fileAccess: 'inherit' },
}
