import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { idSchema, nullableTimestampSchema, timestampSchema, validationRequestSchemas, validationResponseSchemas } from '../runtime/apiValidation'
import { spaceIconColorSchema, spaceIconSchema } from './spaceAppearance'

export const spaceDirectorySchema = z.object({
  accessGrantedAt: timestampSchema,
  canonicalRoot: z.string().min(1),
  createdAt: timestampSchema,
  id: idSchema,
  revision: z.number().int().positive(),
  revokedAt: nullableTimestampSchema,
  root: z.string().min(1),
  spaceId: idSchema,
  updatedAt: timestampSchema,
}).strict()

export const spacePrimaryDirectorySchema = spaceDirectorySchema.safeExtend({
  resourcesTrustedAt: timestampSchema,
}).strict()

export const spaceSchema = z.object({
  activeRunCount: z.number().int().nonnegative(),
  icon: spaceIconSchema,
  iconColor: spaceIconColorSchema,
  additionalDirectories: z.array(spaceDirectorySchema).max(32),
  createdAt: timestampSchema,
  id: idSchema,
  memoryScope: z.enum(['personal_and_space', 'space_only']),
  name: z.string().min(1),
  primaryDirectory: spacePrimaryDirectorySchema.nullable(),
  revokedAt: nullableTimestampSchema,
  updatedAt: timestampSchema,
}).strict().refine(space => (
  space.additionalDirectories.length + Number(Boolean(space.primaryDirectory)) <= 32
), { path: ['additionalDirectories'] })

export const spaceFileSchema = z.object({
  directoryId: idSchema,
  kind: z.enum(['file', 'directory']).optional(),
  name: z.string().min(1),
  path: z.string().min(1),
  relativePath: z.string().min(1),
  root: z.string().min(1),
}).strict()

export const spaceDirectoryInputSchema = z.object({
  id: idSchema.nullable(),
  root: z.string().min(1),
}).strict()

export const spacePrimaryDirectoryInputSchema = spaceDirectoryInputSchema

export type LocalSpace = DeepReadonly<z.infer<typeof spaceSchema>>

export type LocalSpaceAdditionalDirectory = DeepReadonly<z.infer<typeof spaceDirectorySchema>>

export type LocalSpaceCreateInput = z.infer<typeof spacesRequestSchemas.spaceCreate>

export type LocalSpaceFile = DeepReadonly<z.infer<typeof spaceFileSchema>>

export type LocalSpacePrimaryDirectory = DeepReadonly<z.infer<typeof spacePrimaryDirectorySchema>>

export type LocalSpaceUpdateInput = z.infer<typeof spacesRequestSchemas.spaceUpdate>

export const spacesRequestSchemas = {
  spaceFileSearch: z.object({
    spaceId: idSchema,
    query: z.string().max(512),
    deepSearch: z.boolean().optional(),
  }).strict(),
  spaceCreate: z.object({
    icon: spaceIconSchema.optional(),
    iconColor: spaceIconColorSchema.optional(),
    memoryScope: z.enum(['personal_and_space', 'space_only']),
    name: z.string().trim().min(1).max(80),
    primaryDirectory: spacePrimaryDirectoryInputSchema.nullable(),
  }).strict(),
  spaceId: z.object({ spaceId: idSchema }).strict(),
  spaceUpdate: z.object({
    icon: spaceIconSchema.optional(),
    iconColor: spaceIconColorSchema.optional(),
    memoryScope: z.enum(['personal_and_space', 'space_only']),
    name: z.string().trim().min(1).max(80),
    primaryDirectory: spacePrimaryDirectoryInputSchema.nullable(),
    spaceId: idSchema,
  }).strict(),
} as const

export const spacesResponseSchemas = {
  optionalSpace: spaceSchema.nullable(),
  space: spaceSchema,
  spaceFiles: z.array(spaceFileSchema),
  spaces: z.array(spaceSchema),
} as const

export const spacesRpc = {
  create: { method: 'spaces.create', input: spacesRequestSchemas.spaceCreate.extend({ primaryDirectorySelectionVerified: z.boolean() }).strict(), response: spacesResponseSchemas.space },
  delete: { method: 'spaces.delete', input: spacesRequestSchemas.spaceId, response: validationResponseSchemas.mutation },
  list: { method: 'spaces.list', input: validationRequestSchemas.limit, response: spacesResponseSchemas.spaces },
  searchFiles: { method: 'spaces.searchFiles', input: spacesRequestSchemas.spaceFileSearch, response: spacesResponseSchemas.spaceFiles },
  update: { method: 'spaces.update', input: spacesRequestSchemas.spaceUpdate.extend({ primaryDirectorySelectionVerified: z.boolean() }).strict(), response: spacesResponseSchemas.space },
} as const satisfies Record<string, RuntimeRequestContract>

export const spaceChangeNoticeSchema = z.object({
  sourceId: z.uuid(),
  revision: z.number().int().positive(),
  spaceId: idSchema,
  kind: z.enum(['created', 'updated', 'directory-granted', 'deleted']),
}).strict()
export type SpaceChangeNotice = z.infer<typeof spaceChangeNoticeSchema>
export const spaceChanged = { method: 'spaces.changed', params: spaceChangeNoticeSchema } as const
