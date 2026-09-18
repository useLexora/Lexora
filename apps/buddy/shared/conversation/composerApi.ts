import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { sessionIdentitySchema } from '../runtime/apiValidation'
import { attachmentsResponseSchemas } from './attachmentApi'
import { BUDDY_ATTACHMENT_COUNT_LIMIT } from './attachmentPolicy'
import { buddyComposerDraftDiscardSchema, buddyComposerDraftOpenSchema, buddyComposerDraftSaveSchema, buddyComposerDraftSchema, buddyComposerDraftTargetSchema } from './composerDraft'
import { buddyComposerResourceAcceptSchema, buddyComposerResourceCompleteSchema, buddyComposerResourceSchema, buddyComposerResourceTargetSchema, buddyComposerSourceListResponseSchema, buddyComposerSourceListSchema, buddyComposerSourceSelectSchema, buddyComposerSpaceFileSelectSchema } from './composerResource'

export const composerResourceIdsSchema = z.array(sessionIdentitySchema)
  .max(BUDDY_ATTACHMENT_COUNT_LIMIT)
  .refine(ids => new Set(ids).size === ids.length)

export type LocalComposerDraft = DeepReadonly<z.infer<typeof buddyComposerDraftSchema>>

export type LocalComposerDraftOpen = z.input<typeof buddyComposerDraftOpenSchema>

export type LocalComposerDraftSave = z.input<typeof buddyComposerDraftSaveSchema>
export type LocalComposerDraftDiscard = z.input<typeof buddyComposerDraftDiscardSchema>

export const composerRequestSchemas = {
  composerDraftOpen: buddyComposerDraftOpenSchema,
  composerDraftSave: buddyComposerDraftSaveSchema,
  composerDraftTarget: buddyComposerDraftTargetSchema,
  composerResourceAccept: buddyComposerResourceAcceptSchema,
  composerResourceComplete: buddyComposerResourceCompleteSchema,
  composerResourceDraft: z.object({ draftId: sessionIdentitySchema }).strict(),
  composerResourceFileSelect: z.object({
    draftId: sessionIdentitySchema,
    referencedResourceIds: composerResourceIdsSchema.default([]),
  }).strict(),
  composerResourceTarget: buddyComposerResourceTargetSchema,
  composerSourceSelect: buddyComposerSourceSelectSchema.extend({
    referencedResourceIds: composerResourceIdsSchema.default([]),
  }).strict(),
  composerSpaceFileSelect: buddyComposerSpaceFileSelectSchema.extend({
    referencedResourceIds: composerResourceIdsSchema.default([]),
  }).strict(),
} as const

export const composerResponseSchemas = {
  composerDraft: buddyComposerDraftSchema,
  composerResource: buddyComposerResourceSchema,
  composerResources: z.array(buddyComposerResourceSchema),
  composerSourceList: buddyComposerSourceListResponseSchema,
} as const

export const composerResourcesRpc = {
  resolvePreview: { method: 'composerResources.resolvePreview', input: buddyComposerResourceTargetSchema, response: attachmentsResponseSchemas.attachmentPreview },
  accept: { method: 'composerResources.accept', input: composerRequestSchemas.composerResourceAccept, response: composerResponseSchemas.composerResources },
  complete: { method: 'composerResources.complete', input: composerRequestSchemas.composerResourceComplete, response: composerResponseSchemas.composerResource },
  fail: { method: 'composerResources.fail', input: composerRequestSchemas.composerResourceTarget, response: composerResponseSchemas.composerResource },
  retry: { method: 'composerResources.retry', input: composerRequestSchemas.composerResourceTarget, response: composerResponseSchemas.composerResource },
  list: { method: 'composerResources.list', input: composerRequestSchemas.composerResourceDraft, response: composerResponseSchemas.composerResources },
  listSources: { method: 'composerResources.listSources', input: buddyComposerSourceListSchema, response: composerResponseSchemas.composerSourceList },
  selectSpaceFile: { method: 'composerResources.selectSpaceFile', input: composerRequestSchemas.composerSpaceFileSelect, response: composerResponseSchemas.composerResource },
  selectSource: { method: 'composerResources.selectSource', input: composerRequestSchemas.composerSourceSelect, response: composerResponseSchemas.composerResource },
  registerFiles: { method: 'composerResources.registerFiles', input: composerRequestSchemas.composerResourceFileSelect.extend({ paths: z.array(z.string().min(1)).max(BUDDY_ATTACHMENT_COUNT_LIMIT) }).strict(), response: composerResponseSchemas.composerResources },
} as const satisfies Record<string, RuntimeRequestContract>

export const composerDraftsRpc = {
  find: { method: 'composerDrafts.find', input: composerRequestSchemas.composerDraftTarget, response: composerResponseSchemas.composerDraft.nullable() },
  discard: { method: 'composerDrafts.discard', input: buddyComposerDraftDiscardSchema, response: z.boolean() },
  list: { method: 'composerDrafts.list', input: z.object({}).strict(), response: z.array(buddyComposerDraftSchema) },
  open: { method: 'composerDrafts.open', input: composerRequestSchemas.composerDraftOpen, response: composerResponseSchemas.composerDraft },
  get: { method: 'composerDrafts.get', input: composerRequestSchemas.composerDraftTarget, response: composerResponseSchemas.composerDraft },
  save: { method: 'composerDrafts.save', input: composerRequestSchemas.composerDraftSave, response: composerResponseSchemas.composerDraft },
} as const satisfies Record<string, RuntimeRequestContract>
