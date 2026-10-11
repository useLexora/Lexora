import { z } from 'zod'
import { extensionPathSchema } from '../extensions/extensionPath.ts'
import { themeIdSchema } from './themePreferences.ts'
import { semanticColorTokens } from './themeTokens.ts'

export const themeColorSchema = z.string().regex(/^#[\da-f]{6}(?:[\da-f]{2})?$/i, 'Expected #RRGGBB or #RRGGBBAA')
export const themeAppearanceSchema = z.enum(['light', 'dark'])
export const themeImageSchema = extensionPathSchema.refine(value => /\.(?:png|jpe?g|webp|svg)$/i.test(value), 'Expected a package image')
export const themeAnchorSchema = z.enum(['app.sidebar', 'workbench.sidebar', 'workbench.pane', 'composer.input'])
const localizedText = z.object({ 'zh-CN': z.string().max(160), 'en-US': z.string().max(160) }).strict()

export const themeContributionSchema = z.object({
  id: themeIdSchema,
  label: z.string().min(1).max(100),
  appearance: themeAppearanceSchema,
  path: extensionPathSchema.refine(value => value.endsWith('.json')),
}).strict()
export type ThemeContribution = z.infer<typeof themeContributionSchema>

export const themeColorNames = Object.keys(semanticColorTokens) as Array<keyof typeof semanticColorTokens>
export type ThemeColorName = typeof themeColorNames[number]

const materialSchema = z.object({
  anchor: themeAnchorSchema,
  image: themeImageSchema.optional(),
  color: themeColorSchema.optional(),
  gradient: z.object({
    angle: z.number().min(0).max(360),
    stops: z.array(z.object({ color: themeColorSchema, at: z.number().min(0).max(100) }).strict()).min(2).max(8),
  }).strict().optional(),
  opacity: z.number().min(0).max(1).default(1),
  imageOpacity: z.number().min(0).max(1).default(1),
  scale: z.number().min(0.1).max(2).default(1),
  blur: z.number().min(0).max(24).default(0),
  position: z.tuple([z.number().min(0).max(100), z.number().min(0).max(100)]).default([50, 50]),
  size: z.enum(['cover', 'contain']).default('cover'),
}).strict()
const shadowSchema = z.object({ x: z.number().min(-40).max(40), y: z.number().min(-40).max(40), blur: z.number().min(0).max(80), spread: z.number().min(-20).max(20).default(0), color: themeColorSchema }).strict()

export const themeDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  colors: z.partialRecord(z.enum(themeColorNames), themeColorSchema).default({}),
  shadows: z.partialRecord(z.enum(['soft', 'raised', 'overlay', 'window', 'illustration']), z.array(shadowSchema).max(4)).default({}),
  materials: z.array(materialSchema).max(4).default([]),
  welcome: z.object({ text: localizedText.nullable().optional(), image: themeImageSchema.nullable().optional() }).strict().optional(),
}).strict().superRefine((document, context) => {
  if (new Set(document.materials.map(material => material.anchor)).size !== document.materials.length)
    context.addIssue({ code: 'custom', path: ['materials'], message: 'Each anchor can have one material' })
})
export type ThemeDocument = z.infer<typeof themeDocumentSchema>
export type ThemeDocumentInput = z.input<typeof themeDocumentSchema>
export type ThemeMaterial = z.infer<typeof materialSchema>
export type ThemeColors = Record<ThemeColorName, string>
export interface ThemeDescriptor extends Omit<ThemeContribution, 'path'> {
  source: 'plugin' | 'user' | 'fallback'
  extensionId: string | null
  packageName: string
  swatch: string
}

export function themeAssetPaths(document: ThemeDocument): string[] {
  return [...new Set([document.welcome?.image, ...document.materials.map(material => material.image)].filter((path): path is string => !!path))]
}

export function describeTheme() {
  return {
    schema: z.toJSONSchema(themeDocumentSchema),
    colors: themeColorNames,
    anchors: themeAnchorSchema.options,
    precedence: ['fallback', 'theme', 'overrides', 'derived states'],
  }
}
