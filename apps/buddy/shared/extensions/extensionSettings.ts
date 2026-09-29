import type { EventSnapshot } from '../events/eventTypes'
import { z } from 'zod'
import { builtinSettingsModuleIds, publicSettingsGroups } from '../settings/settingsCatalog'
import { extensionConditionReferenceSchema } from './extensionConditions'

export const extensionSettingIdSchema = z.string().max(180).regex(/^[a-z][a-z0-9.-]+$/)
export const extensionSettingKeySchema = z.string().max(80).regex(/^[a-z][a-zA-Z0-9]*$/)
export const extensionModelSelectionSchema = z.object({ providerId: z.string().min(1).max(200), modelId: z.string().min(1).max(200) }).strict()
export const extensionSettingValueSchema = z.union([z.boolean(), z.string().max(8192), z.number().finite(), extensionModelSelectionSchema, z.null()])
export const extensionConfigurationSchema = z.record(extensionSettingKeySchema, extensionSettingValueSchema)
export type ExtensionConfiguration = z.infer<typeof extensionConfigurationSchema>
export type ExtensionSettingValue = z.infer<typeof extensionSettingValueSchema>
export interface ConfigurationEvents {
  'configuration:changed': { readonly configuration: EventSnapshot<ExtensionConfiguration>, readonly changedKeys: readonly string[] }
}
export const extensionConfigurationAppliedSchema = z.object({
  operationId: z.uuid(),
  generation: z.uuid(),
  configurationRevision: z.string().regex(/^[a-f0-9]{64}$/),
  applied: z.boolean(),
}).strict()
export const extensionConfigurationSnapshotSchema = z.object({ values: extensionConfigurationSchema, invalidKeys: z.array(extensionSettingKeySchema).max(64) }).strict()
export type ExtensionConfigurationSnapshot = z.infer<typeof extensionConfigurationSnapshotSchema>
export const extensionSettingsModules = builtinSettingsModuleIds
export const extensionSettingsGroups = publicSettingsGroups
const itemBase = { enabledWhen: extensionConditionReferenceSchema.optional(), id: extensionSettingIdSchema, key: extensionSettingKeySchema, group: extensionSettingIdSchema, title: z.string().min(1).max(100), description: z.string().max(500).default(''), order: z.number().int().min(-1000).max(1000).default(0) }
export const extensionSettingItemSchema = z.discriminatedUnion('type', [
  z.object({ ...itemBase, type: z.literal('boolean'), default: z.boolean() }).strict(),
  z.object({ ...itemBase, type: z.literal('string'), default: z.string().max(8192) }).strict(),
  z.object({ ...itemBase, type: z.literal('number'), default: z.number().finite(), min: z.number().finite().optional(), max: z.number().finite().optional() }).strict(),
  z.object({ ...itemBase, type: z.literal('select'), default: z.string(), options: z.array(z.object({ label: z.string().min(1).max(100), value: z.string().max(200) }).strict()).min(1).max(64) }).strict(),
  z.object({ ...itemBase, type: z.literal('model'), default: extensionModelSelectionSchema.nullable().default(null) }).strict(),
])
export type ExtensionSettingItem = z.infer<typeof extensionSettingItemSchema>
export const extensionSettingsSchema = z.object({
  modules: z.array(z.object({ id: extensionSettingIdSchema, title: z.string().min(1).max(40), order: z.number().int().min(-1000).max(1000).default(0) }).strict()).max(8).default([]),
  groups: z.array(z.object({ id: extensionSettingIdSchema, module: extensionSettingIdSchema, title: z.string().min(1).max(100), order: z.number().int().min(-1000).max(1000).default(0) }).strict()).max(32).default([]),
  items: z.array(extensionSettingItemSchema).max(64).default([]),
}).strict()

export function validateExtensionSetting(item: ExtensionSettingItem, value: unknown): ExtensionSettingValue {
  const parsed = extensionSettingValueSchema.parse(value)
  const valid = item.type === 'model'
    ? parsed === null || typeof parsed === 'object'
    : item.type === 'select'
      ? item.options.some(option => option.value === parsed)
      : item.type === 'number'
        ? typeof parsed === 'number' && (item.min === undefined || parsed >= item.min) && (item.max === undefined || parsed <= item.max)
        : item.type === 'boolean' ? typeof parsed === 'boolean' : typeof parsed === 'string'
  if (!valid)
    throw new Error('EXTENSION_CONFIGURATION_INVALID')
  return parsed
}

export function resolveExtensionConfiguration(items: readonly ExtensionSettingItem[], stored: ExtensionConfiguration): ExtensionConfigurationSnapshot {
  const values: ExtensionConfiguration = {}
  const invalidKeys: string[] = []
  for (const item of items) {
    const value = Object.hasOwn(stored, item.key) ? stored[item.key]! : item.default
    values[item.key] = value
    try {
      validateExtensionSetting(item, value)
    }
    catch { invalidKeys.push(item.key) }
  }
  return { values, invalidKeys }
}
