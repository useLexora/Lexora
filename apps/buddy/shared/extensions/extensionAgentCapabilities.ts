import type { ExtensionManifest } from './extensionManifest'
import { z } from 'zod'
import { referenceLocatorSchema } from '../conversation/referenceMaterial.ts'
import { extensionAgentPrivateResourceSchema, extensionAgentPublishedArtifactSchema, extensionArtifactNameSchema } from './extensionAgentResources.ts'
import { extensionModelSelectionSchema } from './extensionSettings.ts'

interface RequestLimits { calls: number, concurrent: number, error: string }
function capability<I extends z.ZodType, O extends z.ZodType>(input: I, output: O, permitted: (permissions: ExtensionManifest['permissions']) => boolean, limits: RequestLimits | null = null) {
  return { input, output, permitted, limits }
}

export const extensionAgentCapabilities = {
  'task.scope': capability(z.null(), z.object({ taskId: z.string(), branchId: z.string(), runId: z.string() }).strict(), permissions => permissions.agent),
  'artifacts.publish': capability(z.object({ resource: extensionAgentPrivateResourceSchema, name: extensionArtifactNameSchema.optional() }).strict(), extensionAgentPublishedArtifactSchema, permissions => permissions.agent, { calls: 8, concurrent: 1, error: 'EXTENSION_ARTIFACT_LIMIT' }),
  'results.addImage': capability(z.object({ resource: extensionAgentPrivateResourceSchema }).strict(), z.null(), permissions => permissions.agent, { calls: 4, concurrent: 1, error: 'EXTENSION_IMAGE_LIMIT' }),
  'references.list': capability(z.null(), z.object({
    items: z.array(z.object({ referenceId: z.string().uuid(), sourceMessageId: z.string().min(1).max(128), title: z.string().max(512), excerpt: z.string().max(512) }).strict()).max(100),
    truncated: z.boolean(),
  }).strict(), permissions => permissions.references),
  'references.resolve': capability(z.object({
    referenceId: z.string().uuid(),
    sourceMessageId: z.string().min(1).max(128).optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(32768).optional(),
  }).strict(), z.object({
    referenceId: z.string().uuid(),
    sourceMessageId: z.string().min(1).max(128),
    title: z.string().max(512),
    text: z.string().max(32768),
    textLength: z.number().int().nonnegative(),
    textDigest: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    locator: referenceLocatorSchema.nullable(),
    scope: z.object({ taskId: z.string(), branchId: z.string() }).strict(),
  }).strict(), permissions => permissions.references),
  'task.get': capability(z.null(), z.object({ id: z.string(), title: z.string().nullable(), titleSource: z.enum(['legacy', 'manual', 'fallback', 'generated']) }).strict(), permissions => permissions.tasks !== 'none'),
  'task.messages': capability(z.null(), z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(2000) }).strict()).max(16), permissions => permissions.taskMessages),
  'task.rename': capability(z.object({ title: z.string().trim().min(1).max(80).refine(value => [...value].every(character => character.charCodeAt(0) >= 32)) }).strict(), z.object({ applied: z.boolean() }).strict(), permissions => permissions.tasks === 'title'),
  'models.generateText': capability(z.object({
    model: extensionModelSelectionSchema.nullable().default(null),
    system: z.string().max(8192).default(''),
    prompt: z.string().min(1).max(32768),
    maxTokens: z.number().int().min(16).max(4096).default(256),
  }).strict(), z.object({ text: z.string(), model: extensionModelSelectionSchema }).strict(), permissions => permissions.models, { calls: 4, concurrent: 1, error: 'EXTENSION_MODEL_LIMIT' }),
} as const

export type ExtensionAgentMethod = keyof typeof extensionAgentCapabilities
export const extensionAgentMethodSchema = z.enum(Object.keys(extensionAgentCapabilities) as ExtensionAgentMethod[])
