import { z } from 'zod'
import { extensionPathSchema } from '../extensions/extensionPath.ts'
import { themeIdSchema } from '../theme/themePreferences.ts'

export const BUILTIN_FILE_ICON_THEME = 'lexora.material'
export const FILE_ICON_PROTOCOL = 'lexora-icon'
export const fileIconPreferenceSchema = z.object({ id: themeIdSchema }).strict()
export const fileIconThemeContributionSchema = z.object({
  id: themeIdSchema,
  label: z.string().min(1).max(100),
  path: extensionPathSchema.refine(path => path.endsWith('.json')),
}).strict()
const iconId = z.string().min(1).max(128)
const associations = z.record(z.string().min(1).max(256), iconId).refine(value => Object.keys(value).length <= 20000)
const associationShape = {
  file: iconId.optional(),
  folder: iconId.optional(),
  folderExpanded: iconId.optional(),
  rootFolder: iconId.optional(),
  rootFolderExpanded: iconId.optional(),
  fileNames: associations.optional(),
  fileExtensions: associations.optional(),
  languageIds: associations.optional(),
  folderNames: associations.optional(),
  folderNamesExpanded: associations.optional(),
  rootFolderNames: associations.optional(),
  rootFolderNamesExpanded: associations.optional(),
}
const associationSchema = z.object(associationShape).strict()
export const fileIconThemeDocumentSchema = z.object({
  ...associationShape,
  $schema: z.string().max(2048).optional(),
  iconDefinitions: z.record(iconId, z.object({ iconPath: z.string().min(1).max(512) }).strict()).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 4096),
  light: associationSchema.optional(),
  highContrast: associationSchema.optional(),
  hidesExplorerArrows: z.boolean().optional(),
}).strict().superRefine((document, context) => {
  for (const section of [document, document.light, document.highContrast]) {
    if (!section)
      continue
    for (const key of Object.keys(associationShape) as Array<keyof typeof associationShape>) {
      const value = section[key]
      for (const id of typeof value === 'string' ? [value] : Object.values(value ?? {})) {
        if (!Object.hasOwn(document.iconDefinitions, id))
          context.addIssue({ code: 'custom', message: `Unknown icon: ${id}`, path: [key] })
      }
    }
  }
})
export type FileIconThemeDocument = z.infer<typeof fileIconThemeDocumentSchema>
export type FileIconAssociations = z.infer<typeof associationSchema>
export type FileIconThemeContribution = z.infer<typeof fileIconThemeContributionSchema>
export interface FileIconResource { path: string, kind: 'file' | 'directory', expanded?: boolean, root?: boolean, languageId?: string }
export interface FileIconThemeDescriptor { id: string, label: string, extensionId: string | null, packageName: string }
export interface ResolvedFileIconTheme {
  descriptor: FileIconThemeDescriptor
  document: FileIconThemeDocument
  urls: Record<string, string>
}
export interface FileIconThemeSnapshot {
  revision: number
  preference: { id: string }
  themes: FileIconThemeDescriptor[]
  active: ResolvedFileIconTheme | null
  unavailable: string | null
}

function lookup(map: Record<string, string> | undefined, key: string): string | undefined {
  return map && Object.hasOwn(map, key) ? map[key] : undefined
}

export function normalizeFileIconTheme(document: FileIconThemeDocument): FileIconThemeDocument {
  const result = structuredClone(document)
  for (const section of [result, result.light, result.highContrast]) {
    if (!section)
      continue
    for (const key of Object.keys(associationShape) as Array<keyof typeof associationShape>) {
      const value = section[key]
      if (value && typeof value === 'object')
        Object.assign(section, { [key]: Object.fromEntries(Object.entries(value).map(([name, icon]) => [name.toLowerCase(), icon])) })
    }
  }
  return result
}

export function resolveFileIconDefinition(document: FileIconThemeDocument, resource: FileIconResource, appearance: 'light' | 'dark' | 'highContrast'): string | undefined {
  const variant = appearance === 'dark' ? undefined : document[appearance]
  const value = (key: keyof FileIconAssociations): string | undefined => {
    const entry = variant?.[key] ?? document[key]
    return typeof entry === 'string' ? entry : undefined
  }
  const match = (key: keyof FileIconAssociations, name: string): string | undefined => {
    const overrides = variant?.[key]
    const defaults = document[key]
    return lookup(typeof overrides === 'object' ? overrides : undefined, name) ?? lookup(typeof defaults === 'object' ? defaults : undefined, name)
  }
  const parts = resource.path.replaceAll('\\', '/').split('/').filter(Boolean)
  const name = parts.at(-1)?.toLowerCase() ?? ''
  const parent = parts.at(-2)?.toLowerCase()
  const named = (key: keyof FileIconAssociations, name: string) => (parent ? match(key, `${parent}/${name}`) : undefined) ?? match(key, name)
  if (resource.kind === 'directory') {
    if (resource.root) {
      return (resource.expanded ? match('rootFolderNamesExpanded', name) : undefined)
        ?? match('rootFolderNames', name)
        ?? (resource.expanded ? value('rootFolderExpanded') : undefined)
        ?? value('rootFolder')
        ?? (resource.expanded ? value('folderExpanded') : undefined)
        ?? value('folder')
    }
    return (resource.expanded ? named('folderNamesExpanded', name) : undefined)
      ?? named('folderNames', name)
      ?? (resource.expanded ? value('folderExpanded') : undefined)
      ?? value('folder')
  }
  const exact = named('fileNames', name)
  if (exact)
    return exact
  const segments = name.split('.')
  for (const prefix of parent ? [`${parent}/`, ''] : ['']) {
    for (let index = 1; index < segments.length; index++) {
      const icon = match('fileExtensions', `${prefix}${segments.slice(index).join('.')}`)
      if (icon)
        return icon
    }
  }
  return (resource.languageId ? match('languageIds', resource.languageId.toLowerCase()) : undefined) ?? value('file')
}
