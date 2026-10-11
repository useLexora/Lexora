import type { ResolvedTheme } from './resolveTheme'
import type { ThemeDescriptor, ThemeDocument } from './themeDocument.ts'
import type { ThemePreference } from './themePreferences.ts'
import { z } from 'zod'
import { themeAppearanceSchema, themeColorSchema, themeContributionSchema, themeDocumentSchema, themeImageSchema } from './themeDocument.ts'
import { themeIdSchema, themePreferenceSchema } from './themePreferences.ts'

export const themeTransportSchema = z.json().refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16 * 1024 * 1024, 'Theme data is too large')

export const THEME_IPC = { request: 'lexora:themes:request', changed: 'lexora:themes:changed', initial: 'lexora:themes:initial' } as const
const assetsSchema = z.record(themeImageSchema, z.string().max(6 * 1024 * 1024).regex(/^[A-Z0-9+/]*={0,2}$/i)).refine(value => Object.keys(value).length <= 16)
export const themeArchiveSchema = z.object({
  schemaVersion: z.literal(1),
  label: themeContributionSchema.shape.label,
  appearance: themeAppearanceSchema,
  document: themeDocumentSchema,
  assets: assetsSchema.default({}),
}).strict()
export type ThemeArchiveInput = z.input<typeof themeArchiveSchema>
export type ThemeArchive = z.infer<typeof themeArchiveSchema>
export const themeRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('get'), id: themeIdSchema }).strict(),
  z.object({ action: z.literal('active') }).strict(),
  z.object({ action: z.literal('describe') }).strict(),
  z.object({ action: z.literal('validate'), document: z.unknown() }).strict(),
  z.object({ action: z.literal('resolve'), appearance: themeAppearanceSchema, document: themeDocumentSchema, overrides: z.record(z.string(), themeColorSchema).optional() }).strict(),
  z.object({ action: z.literal('save'), id: themeIdSchema.optional(), archive: themeArchiveSchema }).strict(),
  z.object({ action: z.literal('remove'), id: themeIdSchema }).strict(),
  z.object({ action: z.literal('preference'), preference: themePreferenceSchema }).strict(),
  z.object({ action: z.literal('beginPreview'), archive: themeArchiveSchema }).strict(),
  z.object({ action: z.literal('updatePreview'), token: z.string().uuid(), revision: z.number().int().min(0), archive: themeArchiveSchema }).strict(),
  z.object({ action: z.literal('commitPreview'), token: z.string().uuid(), revision: z.number().int().min(0) }).strict(),
  z.object({ action: z.literal('cancelPreview'), token: z.string().uuid() }).strict(),
  z.object({ action: z.literal('export'), id: themeIdSchema }).strict(),
  z.object({ action: z.literal('import'), content: z.string().max(16 * 1024 * 1024) }).strict(),
])
export type ThemeRequest = z.input<typeof themeRequestSchema>
export interface ThemeSnapshot {
  revision: number
  preference: ThemePreference
  active: ResolvedTheme
  themes: ThemeDescriptor[]
  unavailable: string | null
  preview: boolean
}
export interface ThemeRecord { descriptor: ThemeDescriptor, document: ThemeDocument }
export interface ThemePreview { token: string, revision: number }
export interface ThemeValidation { valid: boolean, diagnostics: Array<{ path: string, message: string }> }
export interface ThemeApi {
  request: (input: ThemeRequest) => Promise<unknown>
  onDidChange: (listener: (snapshot: ThemeSnapshot) => void) => () => void
  initial: ThemeSnapshot
}
