import { createHash } from 'node:crypto'
import { z } from 'zod'
import { buddySchema } from '../../../shared/buddies/buddyApi'
import { buddySettingsSchema } from '../../../shared/buddies/buddySettings'
import { buddyComposerDraftModelSelectionSchema } from '../../../shared/conversation/composerDraft'
import { idSchema } from '../../../shared/runtime/apiValidation'

export const buddyExecutionDefinitionSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  kind: z.enum(['actor', 'npc']),
  name: buddySchema.shape.name.optional(),
  description: buddySchema.shape.description.optional(),
  revision: z.number().int().positive(),
  settings: buddySettingsSchema,
  model: buddyComposerDraftModelSelectionSchema,
  modelSource: z.enum(['application', 'definition', 'conversation', 'input', 'caller']),
}).strict()

export const buddyConfigurationSnapshotSchema = buddyExecutionDefinitionSchema.omit({ model: true, modelSource: true })
export type BuddyConfigurationSnapshot = z.infer<typeof buddyConfigurationSnapshotSchema>

export type BuddyExecutionDefinition = z.infer<typeof buddyExecutionDefinitionSchema>
export type BuddyExecutionIdentity = Readonly<Pick<BuddyExecutionDefinition, 'id' | 'kind' | 'name' | 'description'>>

export function buddyExecutionFingerprint(definition: BuddyExecutionDefinition): string {
  return createHash('sha256').update(JSON.stringify({
    id: definition.id,
    kind: definition.kind,
    settings: definition.settings,
  })).digest('hex')
}
