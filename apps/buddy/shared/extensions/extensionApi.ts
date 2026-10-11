import type { WorkbenchHitRegion, WorkbenchPaneSnapshot } from '../workbench/workbenchInteraction'
import type { JsonValue } from '../workbench/workbenchState'
import type { ControlProposal, WorkbenchPresentation } from '../workbench/workbenchUi'
import type { ExtensionTaskAction, ExtensionTaskActionInput, ExtensionTaskActionResult } from './extensionActionApi'
import type { ExtensionCatalogSnapshot } from './extensionCatalog'
import type { ExtensionConditionsChanged, ExtensionConditionState } from './extensionConditions'
import type { ExtensionInstallation } from './extensionInstallation'
import type { ExtensionManifest } from './extensionManifest'
import type { ExtensionConfiguration, ExtensionConfigurationSnapshot } from './extensionSettings'
import { z } from 'zod'
import { spaceFileTargetSchema } from '../spaces/spaceFileApi'
import { themeTransportSchema } from '../theme/themeApi.ts'
import { workbenchPanesSchema } from '../workbench/workbenchInteraction'
import { workbenchMenuSchema } from '../workbench/workbenchUi'
import { extensionActionRpc } from './extensionActionApi'
import { extensionIdSchema } from './extensionManifest'
import { extensionConfigurationSchema } from './extensionSettings'

export const EXTENSION_IPC = {
  request: 'lexora:extensions:request',
  changed: 'lexora:extensions:changed',
  conditionsChanged: 'lexora:extensions:conditions-changed',
  review: 'lexora:extensions:review',
  workbench: 'lexora:extensions:workbench',
  workbenchReply: 'lexora:extensions:workbench-reply',
  hostRequest: 'lexora:extensions:host-request',
  hostMessage: 'lexora:extensions:host-message',
  hostReply: 'lexora:extensions:host-reply',
} as const
export const extensionJsonSchema = z.json().refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144, 'Extension data is too large')
export function parseExtensionRequestParams(method: string, params: unknown): JsonValue {
  return (method === 'themes.request' ? themeTransportSchema : extensionJsonSchema).parse(params)
}

export const extensionResourceSchema = z.object({ id: z.string().uuid(), name: z.string().max(512) }).strict()
export const extensionViewInputSchema = z.object({
  viewId: z.string().uuid(),
  extensionId: extensionIdSchema,
  viewType: z.string().max(180),
  placementId: z.string().min(1).max(180).optional(),
  interactionId: z.string().uuid().optional(),
  instanceId: z.string().uuid().optional(),
  resource: extensionResourceSchema.nullable(),
  state: extensionJsonSchema,
  stateVersion: z.number().int().min(0).max(10000),
}).strict()
export type ExtensionResource = z.infer<typeof extensionResourceSchema>
export type ExtensionViewInput = z.infer<typeof extensionViewInputSchema>
export const extensionMenuInvocationSchema = z.object({
  target: workbenchMenuSchema,
  instanceId: z.string().uuid().optional(),
  content: z.string().max(131072).optional(),
  resource: spaceFileTargetSchema.nullable().default(null),
}).strict()
export type ExtensionMenuInvocation = z.infer<typeof extensionMenuInvocationSchema>
export interface ExtensionViewSession {
  id: string
  extensionId: string
  generation: string
  url: string
  token: string
}
export interface ExtensionLog {
  time: string
  event: string
  code?: string
  durationMs?: number
}
export interface ExtensionStatus {
  source?: ExtensionReview['source']
  manifest: ExtensionManifest
  iconUrl?: string
  revision: string
  enabled: boolean
  development: boolean
  compatible: boolean
  pending: { manifest: ExtensionManifest, revision: string } | null
  state: 'disabled' | 'inactive' | 'activating' | 'active' | 'failed' | 'blocked'
  generation: string | null
  error: string | null
  activationMs: number | null
  logs: ExtensionLog[]
}
export interface ExtensionReview {
  iconUrl?: string
  installationId?: string
  source?: { catalog: string, artifact: string, sha256: string }
  token: string
  manifest: ExtensionManifest
  sha256: string
  development: boolean
  currentVersion: string | null
  addedPermissions: string[]
}
export type ExtensionWorkbenchEvent
  = | { kind: 'cancel', requestId: string }
    | { kind: 'clear-data', requestId: string, extensionId: string }
    | { kind: 'open', requestId: string, extensionId: string, generation: string, viewType: string, resource: ExtensionResource | null, state: JsonValue, stateVersion: number }
    | { kind: 'state', requestId: string, viewId: string, generation: string, token: string, state: JsonValue, stateVersion: number }
    | { kind: 'interaction', requestId: string, extensionId: string, generation: string, interactionId: string, title: string | null }
    | { kind: 'message', requestId: string, extensionId: string, generation: string, message: JsonValue }
    | { kind: 'regions', requestId: string, viewId: string, generation: string, token: string, regions: WorkbenchHitRegion[] }
    | { kind: 'placement', requestId: string, extensionId: string, generation: string, placementId: string, visible: boolean, instanceId?: string, interactionId?: string }
    | { kind: 'control', requestId: string, viewId: string, generation: string, token: string, proposal: ControlProposal }
    | { kind: 'activity', requestId: string, viewId: string, generation: string, token: string, active: boolean }
    | { kind: 'presentation', requestId: string, viewId: string, generation: string, token: string, presentation: WorkbenchPresentation }

export const extensionManagementSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('configuration'), id: extensionIdSchema }).strict(),
  z.object({ action: z.literal('configurationSnapshot'), id: extensionIdSchema }).strict(),
  z.object({ action: z.literal('settingConditions'), id: extensionIdSchema, items: z.array(z.string().max(180)).max(64), form: extensionConfigurationSchema.optional() }).strict(),
  z.object({ action: z.literal('configure'), id: extensionIdSchema, patch: extensionConfigurationSchema }).strict(),
  z.object({ action: z.literal('installations') }).strict(),
  z.object({ action: z.literal('catalog'), refresh: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('reviewCatalog'), id: extensionIdSchema, version: z.string().max(80) }).strict(),
  z.object({ action: z.literal('cancelInstallation'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('selectPackage'), development: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('install'), token: z.string().uuid() }).strict(),
  z.object({ action: z.literal('cancelInstall'), token: z.string().uuid() }).strict(),
  z.object({ action: z.literal('enable'), id: extensionIdSchema, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('restart'), id: extensionIdSchema }).strict(),
  z.object({ action: z.literal('uninstall'), id: extensionIdSchema, clearData: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('devtools'), id: extensionIdSchema }).strict(),
  z.object({ action: z.literal('revokeResources'), id: extensionIdSchema }).strict(),
  z.object({ action: z.literal('execute'), id: extensionIdSchema, command: z.string().max(180), resource: spaceFileTargetSchema.nullable() }).strict(),
  z.object({ action: z.literal('taskActions') }).strict(),
  z.object({ action: z.literal('invokeTaskAction'), input: extensionActionRpc.invoke.input }).strict(),
  z.object({ action: z.literal('executeMenu'), id: extensionIdSchema, menu: z.string().max(180), invocation: extensionMenuInvocationSchema }).strict(),
  z.object({ action: z.literal('executeSlash'), id: extensionIdSchema, command: z.string().max(180), arguments: z.string().max(8192), instanceId: z.string().uuid().optional() }).strict(),
  z.object({ action: z.literal('updatePanes'), panes: workbenchPanesSchema }).strict(),
  z.object({ action: z.literal('endInteraction'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('openView'), view: extensionViewInputSchema }).strict(),
  z.object({ action: z.literal('closeView'), viewId: z.string().uuid(), generation: z.string().uuid(), token: z.string().uuid() }).strict(),
  z.object({ action: z.literal('viewRequest'), viewId: z.string().uuid(), generation: z.string().uuid(), token: z.string().uuid(), method: z.string().max(80), params: themeTransportSchema }).strict().superRefine((input, context) => {
    if (input.method !== 'themes.request' && !extensionJsonSchema.safeParse(input.params).success)
      context.addIssue({ code: 'custom', path: ['params'], message: 'Extension data is too large' })
  }),
])
export type ExtensionManagementRequest = z.infer<typeof extensionManagementSchema>
export interface ExtensionApi {
  settingConditions: (id: string, items: string[], form?: ExtensionConfiguration) => Promise<Record<string, ExtensionConditionState>>
  onConditionsChanged: (listener: (event: ExtensionConditionsChanged) => void) => () => void
  taskActions: () => Promise<ExtensionTaskAction[]>
  invokeTaskAction: (input: ExtensionTaskActionInput) => Promise<ExtensionTaskActionResult>
  list: () => Promise<ExtensionStatus[]>
  configuration: (id: string) => Promise<ExtensionConfiguration>
  configurationSnapshot: (id: string) => Promise<ExtensionConfigurationSnapshot>
  configure: (id: string, patch: ExtensionConfiguration) => Promise<void>
  installations: () => Promise<ExtensionInstallation[]>
  catalog: (refresh?: boolean) => Promise<ExtensionCatalogSnapshot>
  reviewCatalog: (id: string, version: string) => Promise<ExtensionReview>
  cancelInstallation: (id: string) => Promise<void>
  selectPackage: (development?: boolean) => Promise<ExtensionReview | null>
  install: (token: string) => Promise<void>
  cancelInstall: (token: string) => Promise<void>
  enable: (id: string, enabled: boolean) => Promise<void>
  restart: (id: string) => Promise<void>
  uninstall: (id: string, options?: { clearData?: boolean }) => Promise<void>
  devtools: (id: string) => Promise<void>
  revokeResources: (id: string) => Promise<void>
  execute: (id: string, command: string, resource: import('../spaces/spaceFileApi').SpaceFileTarget | null) => Promise<void>
  executeMenu: (id: string, menu: string, invocation: ExtensionMenuInvocation) => Promise<JsonValue>
  executeSlash: (id: string, command: string, argumentsText: string, instanceId?: string) => Promise<JsonValue>
  updatePanes: (panes: WorkbenchPaneSnapshot[]) => Promise<void>
  endInteraction: (id: string) => Promise<void>
  openView: (view: ExtensionViewInput) => Promise<ExtensionViewSession>
  closeView: (viewId: string, generation: string, token: string) => Promise<void>
  viewRequest: (viewId: string, generation: string, token: string, method: string, params: JsonValue) => Promise<JsonValue>
  onChanged: (listener: () => void) => () => void
  onReview: (listener: (review: ExtensionReview) => void) => () => void
  onWorkbench: (listener: (event: ExtensionWorkbenchEvent) => void) => () => void
  replyWorkbench: (requestId: string, viewId: string | null) => void
}

export function extensionError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return /^EXTENSION_[A-Z_]+$/.test(message) ? message : 'EXTENSION_OPERATION_FAILED'
}
