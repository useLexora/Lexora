import { z } from 'zod'
import { productIdentitySchema } from '../productProtocol/identity'
import { buddyUserContentV1Schema } from './buddyUserContent'
import { buddyComposerDraftExecutionConfigSchema, buddyComposerDraftModelSelectionSchema, buddyDraftParticipantsSchema } from './composerDraft'

export const draftRecoveryOwnerSchema = productIdentitySchema.pick({ serviceId: true, profileId: true, dataGeneration: true, deviceId: true })
export const draftRecoverySnapshotSchema = z.object({
  targetKey: z.string().min(1).max(1024),
  draftId: z.string().min(1).max(128),
  editorSessionId: z.uuid(),
  editVersion: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative().nullable(),
  slotRevision: z.number().int().nonnegative().optional(),
  confirmedSnapshot: z.string().max(4 * 1024 * 1024).nullable(),
  content: buddyUserContentV1Schema,
  approvalPolicy: buddyComposerDraftExecutionConfigSchema.unwrap().shape.approvalPolicy,
  executionProfile: buddyComposerDraftExecutionConfigSchema.unwrap().shape.executionProfile,
  modelSelection: buddyComposerDraftModelSelectionSchema.nullable(),
  participants: buddyDraftParticipantsSchema.nullable().optional(),
}).strict()
export const draftRecoveryRecordSchema = z.object({
  owner: draftRecoveryOwnerSchema,
  sequence: z.number().int().nonnegative(),
  snapshot: draftRecoverySnapshotSchema,
}).strict()
export const draftRecoveryRemovalSchema = z.object({
  owner: draftRecoveryOwnerSchema,
  editorSessionId: z.uuid(),
  sequence: z.number().int().nonnegative(),
}).strict()
export const draftRecoveryLoadSchema = z.object({ owner: draftRecoveryOwnerSchema.nullable(), records: z.array(draftRecoveryRecordSchema).max(1000) }).strict()
export type DraftRecoveryOwner = z.infer<typeof draftRecoveryOwnerSchema>
export type DraftRecoverySnapshot = z.infer<typeof draftRecoverySnapshotSchema>
export type DraftRecoveryRecord = z.infer<typeof draftRecoveryRecordSchema>
export interface DraftRecoveryApi {
  load: () => Promise<z.infer<typeof draftRecoveryLoadSchema>>
  write: (record: DraftRecoveryRecord) => Promise<void>
  remove: (input: z.infer<typeof draftRecoveryRemovalSchema>) => Promise<void>
}
export function sameDraftRecoveryOwner(left: DraftRecoveryOwner, right: DraftRecoveryOwner): boolean {
  return left.serviceId === right.serviceId && left.profileId === right.profileId && left.dataGeneration === right.dataGeneration && left.deviceId === right.deviceId
}
