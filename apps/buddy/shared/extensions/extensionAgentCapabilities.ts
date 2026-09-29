import type { ExtensionManifest } from './extensionManifest'
import { z } from 'zod'
import { extensionModelSelectionSchema } from './extensionSettings'

interface RequestLimits { calls: number, concurrent: number, error: string }
function capability<I extends z.ZodType, O extends z.ZodType>(input: I, output: O, permitted: (permissions: ExtensionManifest['permissions']) => boolean, limits: RequestLimits | null = null) {
  return { input, output, permitted, limits }
}

export const extensionAgentCapabilities = {
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
