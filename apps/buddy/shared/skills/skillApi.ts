import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { directoryPageSchema, filePreviewSchema } from '../files/filePreview'
import { idSchema, validationResponseSchemas } from '../runtime/apiValidation'

export const skillReferenceSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  revision: z.string().min(1),
  packageRevision: z.string().min(1).optional(),
}).strict()
export type SkillReference = z.infer<typeof skillReferenceSchema>

export const skillOriginSchema = z.object({
  kind: z.enum(['directory', 'github', 'application']),
  location: z.string().min(1).max(4096),
  ref: z.string().max(256).optional(),
  subdirectory: z.string().max(1024).optional(),
  commit: z.string().max(64).optional(),
}).strict()
export type SkillOrigin = z.infer<typeof skillOriginSchema>

export const skillSchema = z.object({
  id: idSchema,
  description: z.string(),
  enabled: z.boolean(),
  name: z.string().min(1),
  source: z.enum(['directory', 'global', 'space']),
  spaceId: idSchema.nullable(),
  managedBy: z.enum(['application', 'user', 'external', 'directory']),
  status: z.enum(['available', 'manual_only', 'disabled', 'shadowed', 'invalid']),
  shadowedBy: idSchema.nullable(),
  revision: z.string(),
  referenceRevision: z.string().optional(),
  filePath: z.string(),
  origin: skillOriginSchema.nullable(),
  canUpdate: z.boolean(),
  canRemove: z.boolean(),
  busy: z.boolean(),
}).strict()
export type LocalSkill = DeepReadonly<z.infer<typeof skillSchema>>

export const skillDiagnosticSchema = z.object({
  code: z.enum([
    'SKILL_INVALID',
    'SKILL_NAME_COLLISION',
    'SKILL_PATH_OUTSIDE_SOURCE',
    'SKILL_SOURCE_UNREADABLE',
  ]),
  message: z.string(),
  path: z.string().optional(),
}).strict()

export type LocalSkillCatalog = DeepReadonly<z.infer<typeof skillsResponseSchemas.skills>>

const scopeSchema = z.object({ spaceId: idSchema.nullable() }).strict()
const targetSchema = scopeSchema.extend({ id: idSchema })
const fileTargetSchema = targetSchema.extend({ path: z.string().max(4096) })
const directoryRequestSchema = fileTargetSchema.extend({ cursor: z.string().max(512).optional() })
export type SkillFileTarget = z.infer<typeof fileTargetSchema>
export type SkillDirectoryRequest = z.infer<typeof directoryRequestSchema>
const previewInputSchema = scopeSchema.extend({ source: skillOriginSchema, updateId: idSchema.optional() })
export type SkillPreviewInput = z.infer<typeof previewInputSchema>

const previewSchema = z.object({
  id: idSchema,
  spaceId: idSchema.nullable(),
  updateId: idSchema.nullable(),
  source: skillOriginSchema,
  candidates: z.array(z.object({
    id: idSchema,
    name: z.string(),
    description: z.string(),
    revision: z.string(),
    fileCount: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    replacesId: idSchema.nullable(),
    blocked: z.boolean(),
  }).strict()),
  diagnostics: z.array(skillDiagnosticSchema),
}).strict()
export type SkillInstallPreview = DeepReadonly<z.infer<typeof previewSchema>>
export const skillReviewRequested = { method: 'skills.reviewRequested', params: previewSchema } as const

export const skillsRequestSchemas = {
  skillScope: scopeSchema.extend({ metadataOnly: z.boolean().optional() }),
  target: targetSchema,
  file: fileTargetSchema,
  directory: directoryRequestSchema,
  preview: previewInputSchema,
  install: z.object({ previewId: idSchema, candidateIds: z.array(idSchema).min(1).max(100) }).strict(),
  discard: z.object({ previewId: idSchema }).strict(),
  setEnabled: targetSchema.extend({ enabled: z.boolean(), revision: z.string() }),
  remove: targetSchema.extend({ revision: z.string() }),
} as const

export const skillsResponseSchemas = {
  skills: z.object({
    revision: z.string(),
    diagnostics: z.array(skillDiagnosticSchema),
    skills: z.array(skillSchema),
  }).strict(),
  detail: z.object({
    skill: skillSchema,
    content: z.string(),
    body: z.string(),
    metadata: z.array(z.object({ name: z.string(), value: z.string() }).strict()),
    compatibility: z.string().nullable(),
  }).strict(),
  preview: previewSchema,
} as const
export type SkillDetail = DeepReadonly<z.infer<typeof skillsResponseSchemas.detail>>

export const skillsRpc = {
  list: { method: 'skills.list', input: skillsRequestSchemas.skillScope, response: skillsResponseSchemas.skills },
  get: { method: 'skills.get', input: targetSchema, response: skillsResponseSchemas.detail },
  listFiles: { method: 'skills.listFiles', input: directoryRequestSchema, response: directoryPageSchema },
  readFile: { method: 'skills.readFile', input: fileTargetSchema, response: filePreviewSchema },
  locateFile: { method: 'skills.locateFile', input: fileTargetSchema, response: z.object({ path: z.string() }).strict() },
  preview: { method: 'skills.preview', input: previewInputSchema, response: previewSchema },
  install: { method: 'skills.install', input: skillsRequestSchemas.install, response: skillsResponseSchemas.skills },
  discard: { method: 'skills.discard', input: skillsRequestSchemas.discard, response: validationResponseSchemas.mutation },
  setEnabled: { method: 'skills.setEnabled', input: skillsRequestSchemas.setEnabled, response: skillsResponseSchemas.skills },
  remove: { method: 'skills.remove', input: skillsRequestSchemas.remove, response: skillsResponseSchemas.skills },
} as const satisfies Record<string, RuntimeRequestContract>

export const skillChangedSchema = scopeSchema.extend({
  sourceId: z.uuid(),
  sequence: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
  type: z.enum(['installation', 'catalog']),
  mode: z.enum(['discovery', 'management']).optional(),
}).strict()
export type SkillChangeNotice = Readonly<z.infer<typeof skillChangedSchema>>

export function isSkillAvailable(skill: Pick<LocalSkill, 'status'>): boolean {
  return skill.status === 'available' || skill.status === 'manual_only'
}
