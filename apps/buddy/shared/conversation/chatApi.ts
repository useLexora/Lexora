import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { runSchema, runsRequestSchemas, runsResponseSchemas } from '../runs/runApi'
import { idSchema, sessionIdentitySchema } from '../runtime/apiValidation'
import { skillReferenceSchema } from '../skills/skillApi'
import { buddyComposerDraftSendSchema } from './composerDraft'

export const _contextItemSchema = z.object({
  kind: z.enum(['file', 'skill', 'slashCommand', 'sessionReference']),
  title: z.string().max(80).optional(),
  value: z.string().min(1),
  skill: skillReferenceSchema.optional(),
}).strict()

export const turnStartSchema = z.object({
  branchId: idSchema,
  conversationId: idSchema,
  draftReceipt: z.object({
    committedRevision: z.number().int().positive(),
    draftId: sessionIdentitySchema,
    sourceRevision: z.number().int().nonnegative(),
  }).strict().nullable(),
  run: runSchema,
  runId: idSchema,
}).strict()

export const chatCommandSchema = buddyComposerDraftSendSchema

export type LocalChatCommandRequest = z.infer<typeof chatCommandSchema>

export type LocalPromptContextItem = z.infer<typeof _contextItemSchema>

export type LocalStartTurnRequest = z.infer<typeof chatRequestSchemas.startTurn>

export type LocalTurnStart = DeepReadonly<z.infer<typeof turnStartSchema>>

export const chatRequestSchemas = {
  chatCommand: chatCommandSchema,
  editUserMessage: z.object({
    conversationId: idSchema,
    draftId: sessionIdentitySchema,
    expectedRevision: z.number().int().nonnegative(),
    requestId: z.string().min(1).max(128),
    userMessageId: idSchema,
  }).strict(),
  regenerateAssistant: z.object({
    conversationId: idSchema,
    requestId: z.string().min(1).max(128),
    sourceRunId: idSchema,
  }).strict(),
  startTurn: buddyComposerDraftSendSchema,
} as const

export const chatResponseSchemas = {
  turnStart: turnStartSchema,
} as const

export const chatRpc = {
  startTurn: { method: 'chat.startTurn', input: chatRequestSchemas.startTurn, response: chatResponseSchemas.turnStart },
  editUserMessage: { method: 'chat.editUserMessage', input: chatRequestSchemas.editUserMessage, response: chatResponseSchemas.turnStart },
  executeCommand: { method: 'chat.executeCommand', input: chatRequestSchemas.chatCommand, response: chatResponseSchemas.turnStart },
  regenerateAssistant: { method: 'chat.regenerateAssistant', input: chatRequestSchemas.regenerateAssistant, response: chatResponseSchemas.turnStart },
  cancel: { method: 'chat.cancel', input: runsRequestSchemas.runId, response: runsResponseSchemas.run },
} as const satisfies Record<string, RuntimeRequestContract>
