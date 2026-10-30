import type { EventSnapshot } from '../events/eventTypes'
import type { OcrServiceSave, OcrServiceStatus } from './ocrService.ts'
import { z } from 'zod'
import { ocrServiceConfigSchema } from './ocrService.ts'

export const imageTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model'), providerId: z.string().min(1).max(200), modelId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('plugin'), extensionId: z.string().min(1).max(160), modelId: z.string().min(1).max(80) }).strict(),
])
export type ImageTarget = z.infer<typeof imageTargetSchema>
export const imageSourceSchema = z.object({
  target: z.union([imageTargetSchema, z.object({ kind: z.literal('ocr'), api: z.literal('paddleocr') }).strict()]),
  requestId: z.uuid(),
  attempt: z.number().int().min(1).max(6),
  title: z.string().min(1).max(256),
  owner: z.string().min(1).max(256),
}).strict()
export type ImageSource = z.infer<typeof imageSourceSchema>
export const imagePolicySchema = z.object({
  mode: z.enum(['auto', 'selected', 'native']).default('native'),
  target: imageTargetSchema.nullable().default(null),
  fallbacks: z.array(imageTargetSchema).max(4).default([]),
}).strict().superRefine((value, context) => {
  if (value.mode === 'selected' && !value.target)
    context.addIssue({ code: 'custom', message: 'Select an image model' })
  const keys = [...value.mode === 'auto' ? [] : [value.target], ...value.fallbacks].filter(Boolean).map(value => JSON.stringify(value))
  if (new Set(keys).size !== keys.length)
    context.addIssue({ code: 'custom', message: 'Duplicate image model' })
})
export type ImagePolicy = z.infer<typeof imagePolicySchema>

export function imagePolicyTargets(policy: ImagePolicy): ImageTarget[] {
  const targets = [policy.target, ...policy.fallbacks].filter((target): target is ImageTarget => target !== null)
  return [...new Map(targets.map(target => [JSON.stringify(target), target])).values()]
}
export const imageReadingOperationSchema = z.enum(['understand', 'extract', 'document'])
export type ImageReadingOperation = z.infer<typeof imageReadingOperationSchema>
export type ImageOperation = ImageReadingOperation | 'generate' | 'edit'
export const imageOperations = ['understand', 'extract', 'document', 'generate', 'edit'] as const
export const imageReadingSupportSchema = z.object({ operations: z.array(imageReadingOperationSchema).min(1).max(3) }).strict()

export function isOcrReadingSupport(support: { operations: readonly string[] }): boolean {
  return support.operations.includes('extract') && !support.operations.includes('understand')
}
export const imagePreferencesSchema = z.object({
  understand: imagePolicySchema.optional(),
  ocrEnabled: z.boolean().optional(),
  ocrService: ocrServiceConfigSchema.optional(),
  extract: imagePolicySchema.optional(),
  document: imagePolicySchema.optional(),
  generate: imagePolicySchema.optional(),
  edit: imagePolicySchema.optional(),
}).strict()
export type ImagePreferences = z.infer<typeof imagePreferencesSchema>
export type ImagePreferencesSnapshot = EventSnapshot<ImagePreferences>

export function isSeparateOcrEnabled(preferences: ImagePreferencesSnapshot): boolean {
  return preferences.ocrEnabled ?? Boolean(preferences.extract)
}

export function resolveImagePolicy(preferences: ImagePreferencesSnapshot, operation: ImageOperation): ImagePolicy {
  const inherited = operation === 'edit' ? preferences.generate : operation === 'extract' || operation === 'document' ? preferences.understand : undefined
  const selected = operation === 'extract' && preferences.ocrEnabled === false ? undefined : preferences[operation]
  return imagePolicySchema.parse(selected ?? inherited ?? {})
}
export const imageOutputOptionsSchema = z.object({
  size: z.string().regex(/^(?:auto|[1-9]\d{1,3}x[1-9]\d{1,3})$/).default('auto'),
  quality: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
  background: z.enum(['auto', 'opaque', 'transparent']).default('auto'),
}).strict()
export type ImageOutputOptions = z.infer<typeof imageOutputOptionsSchema>
export const imageSupportSchema = z.object({
  operations: z.array(z.enum(['generate', 'edit'])).min(1).max(2),
  maxReferenceImages: z.number().int().min(0).max(16),
  sizes: z.array(imageOutputOptionsSchema.shape.size).min(1).max(32),
  qualities: z.array(imageOutputOptionsSchema.shape.quality).min(1).max(4),
  backgrounds: z.array(imageOutputOptionsSchema.shape.background).min(1).max(3),
}).strict().refine(value => !value.operations.includes('edit') || value.maxReferenceImages > 0, 'Editing requires reference images')
export type ImageSupport = z.infer<typeof imageSupportSchema>
export const imageCandidateSchema = z.object({
  target: imageTargetSchema,
  title: z.string(),
  owner: z.string(),
  managementPage: z.boolean(),
  available: z.boolean(),
  support: imageSupportSchema,
}).strict()
export type ImageCandidate = z.infer<typeof imageCandidateSchema>
export const imageReadingCandidateSchema = imageCandidateSchema.extend({ support: imageReadingSupportSchema })
export type ImageReadingCandidate = z.infer<typeof imageReadingCandidateSchema>
export const imageCatalogSchema = z.object({ candidates: z.array(imageCandidateSchema), readingCandidates: z.array(imageReadingCandidateSchema).default([]), preferences: imagePreferencesSchema }).strict()
export type ImageCatalog = z.infer<typeof imageCatalogSchema>
export const imageRpc = { catalog: 'images.catalog', preferences: 'host.images.preferences' } as const
export const IMAGE_IPC = { catalog: 'lexora:images:catalog', save: 'lexora:images:save' } as const
export interface ImageApi {
  catalog: () => Promise<ImageCatalog>
  save: (preferences: ImagePreferences) => Promise<void>
  ocrStatus: () => Promise<OcrServiceStatus>
  saveOcr: (input: OcrServiceSave) => Promise<OcrServiceStatus>
}
