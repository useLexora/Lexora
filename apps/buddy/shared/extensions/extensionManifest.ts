import { satisfies, valid, validRange } from 'semver'
import { z } from 'zod'
import { workbenchConditionSchema } from '../workbench/workbenchContext'
import { workbenchAnchorSchema, workbenchControlSchema, workbenchMountTargetSchema, workbenchPresentationSchema } from '../workbench/workbenchUi'

export const EXTENSION_API_VERSION = 2
export const EXTENSION_PROTOCOL = 'lexora-extension'
export const EXTENSION_ICON_LIMIT = 64 * 1024
export const extensionIconUrlSchema = z.string().max(Math.ceil(EXTENSION_ICON_LIMIT / 3) * 4 + 40).regex(/^data:image\/(?:svg\+xml|png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/)
export const extensionIdSchema = z.string().max(120).regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/)
export const extensionVersionSchema = z.string().max(80).refine(value => valid(value) === value, 'Invalid semantic version')
export const extensionPathSchema = z.string().min(1).max(256).refine((value) => {
  const parts = value.split('/')
  return /^[\w./-]+$/.test(value) && !value.startsWith('__') && parts.every(part => part && part !== '.' && part !== '..' && !part.endsWith('.') && !/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part))
}, 'Invalid package path')
const contributionId = z.string().min(1).max(180).regex(/^[a-z][a-z0-9.-]+$/)
const placementBase = { id: contributionId, view: contributionId, when: workbenchConditionSchema.optional() }
export const extensionPlacementSchema = z.discriminatedUnion('kind', [
  z.object({
    ...placementBase,
    kind: z.literal('view'),
    target: workbenchMountTargetSchema.optional(),
    presentation: workbenchPresentationSchema.omit({ target: true }).default({}),
    location: z.enum(['workbench.top', 'workbench.bottom', 'workbench.floating']).optional(),
    height: z.number().int().min(32).max(640).optional(),
    width: z.number().int().min(160).max(960).optional(),
  }).strict().superRefine((value, context) => {
    if (!!value.target === !!value.location || (value.target && (value.height !== undefined || value.width !== undefined)))
      context.addIssue({ code: 'custom', message: 'Declare a mount target and presentation, or a legacy location' })
  }).transform(({ id, view, kind, when, target, presentation, location, height, width }) => ({
    id,
    view,
    kind,
    ...(when ? { when } : {}),
    target: target ?? 'workbench' as const,
    presentation: location ? { position: location === 'workbench.floating' ? 'absolute' as const : 'static' as const, order: location === 'workbench.top' ? -1 : 1, height: height ?? 56, ...(width === undefined ? {} : { width }), ...presentation } : presentation,
  })),
  z.object({ ...placementBase, kind: z.literal('decoration'), anchor: workbenchAnchorSchema }).strict(),
  z.object({ ...placementBase, kind: z.literal('control'), target: workbenchControlSchema, height: z.number().int().min(32).max(160).default(64) }).strict(),
])
export type ExtensionPlacement = z.infer<typeof extensionPlacementSchema>
export const extensionPermissionsSchema = z.object({
  windowEffects: z.boolean().default(false),
  controls: z.array(workbenchControlSchema).max(1).default([]),
  notifications: z.boolean().default(false),
  schedules: z.boolean().default(false),
  selectedResource: z.enum(['none', 'read']).default('none'),
  localResources: z.boolean().default(false),
  resourceExport: z.boolean().default(false),
  network: z.array(z.string().url().max(512).refine((value) => {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
  }, 'Expected an HTTPS origin')).max(16).default([]),
}).strict()
export const extensionManifestSchema = z.object({
  schemaVersion: z.literal(1),
  format: z.enum(['compiled', 'source']).default('compiled'),
  id: extensionIdSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(''),
  icon: extensionPathSchema.refine(value => /\.(?:svg|png|jpe?g|webp)$/i.test(value), 'Expected an SVG, PNG, JPEG or WebP icon').optional(),
  categories: z.array(z.string().min(1).max(40)).max(8).default([]),
  tags: z.array(z.string().min(1).max(40)).max(16).default([]),
  version: extensionVersionSchema,
  apiVersion: z.union([z.literal(1), z.literal(EXTENSION_API_VERSION)]),
  engines: z.object({ lexora: z.string().max(100).refine(value => validRange(value) !== null) }).strict(),
  entry: extensionPathSchema.optional(),
  dataVersion: z.number().int().min(1).max(10000).default(1),
  dependencies: z.record(extensionIdSchema, z.string().max(100).refine(value => validRange(value) !== null)).default({}),
  permissions: extensionPermissionsSchema.prefault({}),
  contributes: z.object({
    commands: z.array(z.object({ id: contributionId, title: z.string().min(1).max(100), hidden: z.boolean().default(false), when: workbenchConditionSchema.optional() }).strict()).max(64).default([]),
    views: z.array(z.object({ id: contributionId, title: z.string().min(1).max(100), entry: extensionPathSchema, stateVersion: z.number().int().min(1).max(10000).default(1), resource: z.enum(['selected-file', 'none']).default('selected-file'), location: z.enum(['context', 'page', 'window-overlay']).default('context'), when: workbenchConditionSchema.optional() }).strict()).max(16).default([]),
    placements: z.array(extensionPlacementSchema).max(16).default([]),
    navigation: z.object({ title: z.string().min(1).max(40), view: contributionId, when: workbenchConditionSchema.optional() }).strict().optional(),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const ids = new Set<string>()
  for (const contribution of [...manifest.contributes.commands, ...manifest.contributes.views, ...manifest.contributes.placements]) {
    if (!contribution.id.startsWith(`${manifest.id}.`) || ids.has(contribution.id))
      context.addIssue({ code: 'custom', message: 'Contribution IDs must be unique and owned by the extension' })
    ids.add(contribution.id)
  }
  if (manifest.contributes.commands.length && !manifest.entry)
    context.addIssue({ code: 'custom', message: 'Commands require an extension entry' })
  if (manifest.id in manifest.dependencies)
    context.addIssue({ code: 'custom', message: 'An extension cannot depend on itself' })
  if (manifest.contributes.views.some(view => view.resource === 'selected-file') && manifest.permissions.selectedResource !== 'read')
    context.addIssue({ code: 'custom', message: 'File views require selected-resource permission' })
  if (manifest.contributes.views.some(view => view.location !== 'context' && view.resource !== 'none'))
    context.addIssue({ code: 'custom', message: 'Page views cannot require a selected resource' })
  if (manifest.contributes.views.some(view => view.location === 'window-overlay') && !manifest.permissions.windowEffects)
    context.addIssue({ code: 'custom', message: 'Window overlays require windowEffects permission' })
  if (manifest.contributes.views.filter(view => view.location === 'window-overlay').length > 1)
    context.addIssue({ code: 'custom', message: 'An extension can provide one window overlay' })
  if (manifest.contributes.navigation && !manifest.contributes.views.some(view => view.id === manifest.contributes.navigation?.view && view.resource === 'none' && (view.location === 'page' || (manifest.apiVersion === 2 && view.location === 'context'))))
    context.addIssue({ code: 'custom', message: 'Navigation must reference a page view' })
  if (manifest.apiVersion === 1 && (manifest.contributes.placements.length || manifest.permissions.controls.length))
    context.addIssue({ code: 'custom', message: 'UI placements and controls require API 2' })
  for (const placement of manifest.contributes.placements) {
    const view = manifest.contributes.views.find(view => view.id === placement.view)
    if (!view || view.resource !== 'none' || view.location !== 'context')
      context.addIssue({ code: 'custom', message: 'Placements require a resource-free view definition' })
    if (placement.kind === 'decoration' && !manifest.permissions.windowEffects)
      context.addIssue({ code: 'custom', message: 'Decorations require windowEffects permission' })
    if (placement.kind === 'control' && !manifest.permissions.controls.includes(placement.target))
      context.addIssue({ code: 'custom', message: 'Control replacement requires permission for its target' })
  }
  if (manifest.permissions.schedules && !manifest.entry)
    context.addIssue({ code: 'custom', message: 'Schedules require an extension entry' })
})
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>
export type ExtensionPermissions = z.infer<typeof extensionPermissionsSchema>

export function extensionCompatible(manifest: ExtensionManifest, version: string): boolean {
  return manifest.apiVersion <= EXTENSION_API_VERSION && satisfies(version, manifest.engines.lexora, { includePrerelease: true })
}

export function addedExtensionPermissions(previous: ExtensionPermissions | undefined, next: ExtensionPermissions): string[] {
  return [
    ...(next.windowEffects && !previous?.windowEffects ? ['windowEffects'] : []),
    ...next.controls.filter(target => !previous?.controls?.includes(target)).map(target => `controls:${target}`),
    ...(next.notifications && !previous?.notifications ? ['notifications'] : []),
    ...(next.schedules && !previous?.schedules ? ['schedules'] : []),
    ...(next.selectedResource === 'read' && previous?.selectedResource !== 'read' ? ['selectedResource:read'] : []),
    ...(next.localResources && !previous?.localResources ? ['localResources'] : []),
    ...(next.resourceExport && !previous?.resourceExport ? ['resourceExport'] : []),
    ...next.network.filter(origin => !previous?.network.includes(origin)).map(origin => `network:${origin}`),
  ]
}
