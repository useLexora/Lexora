import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { idSchema, timestampSchema, validationRequestSchemas } from '../runtime/apiValidation'
import { buddySettingsSchema } from './buddySettings'

export const BUILTIN_BUDDY_ID = 'default'
export const BUDDY_AVATAR_MAX_BYTES = 2 * 1024 * 1024
export const BUDDY_AVATAR_PRESET_IDS = ['actor-lexora', 'actor-classic', 'actor-claude', 'actor-deepseek', 'actor-chatgpt', 'npc-slate', 'npc-lilac'] as const
export const buddyAvatarImageSchema = z.string().max(Math.ceil(BUDDY_AVATAR_MAX_BYTES / 3) * 4 + 32).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/)
export const buddyAvatarSchema = z.union([z.templateLiteral(['preset:', z.enum(BUDDY_AVATAR_PRESET_IDS)]), buddyAvatarImageSchema]).nullable()

export const buddySchema = z.object({
  id: idSchema,
  kind: z.enum(['actor', 'npc']),
  enabled: z.boolean(),
  name: z.string().trim().min(1).max(80),
  avatar: buddyAvatarSchema,
  customAvatars: z.array(buddyAvatarImageSchema),
  description: z.string().trim().max(500),
  deletedAt: timestampSchema.nullable(),
  settings: buddySettingsSchema,
  revision: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict()

export const buddyTargetSchema = z.object({ buddyId: idSchema }).strict()
export const buddyMutationSchema = buddyTargetSchema.extend({ expectedRevision: z.number().int().positive() }).strict()
export const buddyCreateSchema = z.object({
  kind: buddySchema.shape.kind.optional(),
  name: buddySchema.shape.name,
  avatar: buddyAvatarSchema.optional(),
  customAvatars: buddySchema.shape.customAvatars.optional(),
  description: buddySchema.shape.description.optional(),
}).strict()
export const buddyUpdateSchema = buddyMutationSchema.extend({
  enabled: z.boolean().optional(),
  settings: buddySettingsSchema.optional(),
  name: buddySchema.shape.name.optional(),
  avatar: buddyAvatarSchema.optional(),
  customAvatars: buddySchema.shape.customAvatars.optional(),
  description: buddySchema.shape.description.optional(),
}).strict().refine(input => input.enabled !== undefined || input.name !== undefined || input.avatar !== undefined || input.customAvatars !== undefined || input.description !== undefined || input.settings !== undefined)
export const buddyCatalogSchema = z.object({
  buddies: z.array(buddySchema),
  defaultBuddyId: idSchema,
  revision: z.number().int().positive(),
}).strict()
export const buddyDefaultUpdateSchema = buddyTargetSchema.extend({ expectedCatalogRevision: z.number().int().positive() }).strict()

export const buddyToolOptionSchema = z.object({
  id: z.string().min(1).max(16384),
  name: z.string().min(1),
  title: z.string().min(1),
  source: z.object({ kind: z.enum(['builtin', 'mcp', 'plugin']), id: z.string().min(1), title: z.string().min(1) }).strict(),
}).strict()
export type BuddyToolOption = DeepReadonly<z.infer<typeof buddyToolOptionSchema>>

export type LocalBuddy = DeepReadonly<z.infer<typeof buddySchema>>
export type BuddyCatalog = DeepReadonly<z.infer<typeof buddyCatalogSchema>>
export type BuddyCreate = z.infer<typeof buddyCreateSchema>
export type BuddyMutation = z.infer<typeof buddyMutationSchema>
export type BuddyDefaultUpdate = z.infer<typeof buddyDefaultUpdateSchema>
export type BuddyUpdate = z.infer<typeof buddyUpdateSchema>

export const buddiesRpc = {
  toolOptions: { method: 'buddies.toolOptions', input: validationRequestSchemas.empty, response: z.array(buddyToolOptionSchema) },
  list: { method: 'buddies.list', input: validationRequestSchemas.empty, response: buddyCatalogSchema },
  get: { method: 'buddies.get', input: buddyTargetSchema, response: buddySchema },
  create: { method: 'buddies.create', input: buddyCreateSchema, response: buddySchema },
  delete: { method: 'buddies.delete', input: buddyMutationSchema, response: buddySchema },
  resetProfile: { method: 'buddies.resetProfile', input: buddyMutationSchema, response: buddySchema },
  setDefault: { method: 'buddies.setDefault', input: buddyDefaultUpdateSchema, response: buddyCatalogSchema },
  update: { method: 'buddies.update', input: buddyUpdateSchema, response: buddySchema },
} as const satisfies Record<string, RuntimeRequestContract>

export const buddiesChanged = {
  method: 'buddies.changed',
  params: z.object({ buddyId: idSchema, catalogRevision: z.number().int().positive() }).strict(),
} as const
