import type { FileOpeningChoice, FileOpeningReviewChoice, FileOpeningSnapshot } from '../files/fileOpening'
import type { ShellCandidate, ShellCandidateId } from '../shell/shellProgram'
import type { WorkbenchHitRegion, WorkbenchPaneSnapshot } from '../workbench/workbenchInteraction'
import type { JsonValue } from '../workbench/workbenchState'
import type { ControlProposal, WorkbenchPresentation } from '../workbench/workbenchUi'
import type { ExtensionTaskAction, ExtensionTaskActionInput, ExtensionTaskActionResult } from './extensionActionApi'
import type { ExtensionCatalogSnapshot } from './extensionCatalog'
import type { ExtensionCompatibilityIssue, ExtensionIncompatibleReview } from './extensionCompatibility'
import type { ExtensionConditionsChanged, ExtensionConditionState } from './extensionConditions'
import type { ExtensionDiagnostic } from './extensionDiagnostic'
import type { ExtensionInstallation } from './extensionInstallation'
import type { ExtensionManifest } from './extensionManifest'
import type { ExtensionReferenceMaterial, ExtensionReferenceOpening } from './extensionReferences'
import type { ExtensionConfiguration, ExtensionConfigurationSnapshot } from './extensionSettings'
import type { ExtensionWindowStyle } from './extensionWindowStyles'
import { z } from 'zod'
import { fileOpeningChoiceSchema, fileOpeningLocationSchema } from '../files/fileOpening'
import { shellCandidateIdSchema } from '../shell/shellProgram'
import { spaceFileTargetSchema } from '../spaces/spaceFileApi'
import { themeTransportSchema } from '../theme/themeApi.ts'
import { workbenchPanesSchema } from '../workbench/workbenchInteraction'
import { workbenchMenuSchema } from '../workbench/workbenchUi'
import { extensionActionRpc } from './extensionActionApi'
import { extensionFileOpeningSourceSchema } from './extensionFileOpening'
import { extensionIdSchema } from './extensionManifest'
import { extensionReferenceInputSchema, extensionReferenceOpeningSchema } from './extensionReferences'
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
  if (method === 'references.add')
    return extensionJsonSchema.parse(extensionReferenceInputSchema.parse(params))
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
export { extensionFileOpeningSourceSchema } from './extensionFileOpening'
export const extensionFileOpeningInputSchema = z.object({
  providerId: z.string().min(1).max(180),
  location: fileOpeningLocationSchema,
  source: extensionFileOpeningSourceSchema.nullable(),
  text: z.string().max(2 * 1024 * 1024).optional(),
}).strict().refine(input => input.text === undefined || (input.location === 'inline' && input.source?.kind === 'space'), 'Snapshots require an inline Space resource')
export type ExtensionFileOpeningSource = z.infer<typeof extensionFileOpeningSourceSchema>
export type ExtensionFileOpeningInput = z.infer<typeof extensionFileOpeningInputSchema>
export interface ExtensionPreparedFileOpening {
  extensionId: string
  viewType: string
  resource: ExtensionResource | null
}
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
  diagnostic?: ExtensionDiagnostic
}
export interface ExtensionStatus {
  windowStyles?: ExtensionWindowStyle[]
  source?: ExtensionReview['source']
  manifest: ExtensionManifest
  iconUrl?: string
  revision: string
  enabled: boolean
  development: boolean
  compatible: boolean
  incompatibility?: ExtensionCompatibilityIssue | null
  pending: { manifest: ExtensionManifest, revision: string, incompatibility?: ExtensionCompatibilityIssue | null } | null
  state: 'disabled' | 'inactive' | 'activating' | 'active' | 'failed' | 'blocked'
  generation: string | null
  error: string | null
  activationMs: number | null
  logs: ExtensionLog[]
}
export interface ExtensionReview {
  fileAssociations?: FileOpeningReviewChoice[]
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
export type ExtensionReviewResult = ExtensionReview | ExtensionIncompatibleReview
export type ExtensionUnavailableInstallation = ExtensionIncompatibleReview & { pending: boolean }
export type ExtensionWorkbenchEvent
  = | { kind: 'cancel', requestId: string }
    | { kind: 'clear-data', requestId: string, extensionId: string }
    | { kind: 'open', requestId: string, extensionId: string, generation: string, viewType: string, resource: ExtensionResource | null, state: JsonValue, stateVersion: number }
    | { kind: 'state', requestId: string, viewId: string, generation: string, token: string, state: JsonValue, stateVersion: number }
    | { kind: 'reference', requestId: string, viewId: string, generation: string, token: string, material: ExtensionReferenceMaterial }
    | { kind: 'interaction', requestId: string, extensionId: string, generation: string, interactionId: string, title: string | null }
    | { kind: 'message', requestId: string, extensionId: string, generation: string, message: JsonValue }
    | { kind: 'regions', requestId: string, viewId: string, generation: string, token: string, regions: WorkbenchHitRegion[] }
    | { kind: 'placement', requestId: string, extensionId: string, generation: string, placementId: string, visible: boolean, instanceId?: string, interactionId?: string }
    | { kind: 'control', requestId: string, viewId: string, generation: string, token: string, proposal: ControlProposal }
    | { kind: 'activity', requestId: string, viewId: string, generation: string, token: string, active: boolean }
    | { kind: 'presentation', requestId: string, viewId: string, generation: string, token: string, presentation: WorkbenchPresentation }

export const extensionManagementSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('fileOpeners') }).strict(),
  z.object({ action: z.literal('setFileOpener'), choice: fileOpeningChoiceSchema }).strict(),
  z.object({ action: z.literal('prepareFileOpening'), input: extensionFileOpeningInputSchema }).strict(),
  z.object({ action: z.literal('prepareReferenceOpening'), input: extensionReferenceOpeningSchema }).strict(),
  z.object({ action: z.literal('unavailable') }).strict(),
  z.object({ action: z.literal('detectShells'), id: extensionIdSchema }).strict(),
  z.object({ action: z.literal('selectShellExecutable'), id: extensionIdSchema, candidate: shellCandidateIdSchema }).strict(),
  z.object({ action: z.literal('configuration'), id: extensionIdSchema }).strict(),
  z.object({ action: z.literal('configurationSnapshot'), id: extensionIdSchema }).strict(),
  z.object({ action: z.literal('settingConditions'), id: extensionIdSchema, items: z.array(z.string().max(180)).max(64), form: extensionConfigurationSchema.optional() }).strict(),
  z.object({ action: z.literal('configure'), id: extensionIdSchema, patch: extensionConfigurationSchema }).strict(),
  z.object({ action: z.literal('installations') }).strict(),
  z.object({ action: z.literal('catalog'), refresh: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('reviewCatalog'), id: extensionIdSchema, version: z.string().max(80) }).strict(),
  z.object({ action: z.literal('cancelInstallation'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('selectPackage'), development: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('install'), token: z.string().uuid(), choices: z.array(fileOpeningChoiceSchema).max(4096).optional() }).strict(),
  z.object({ action: z.literal('cancelInstall'), token: z.string().uuid() }).strict(),
  z.object({ action: z.literal('enable'), id: extensionIdSchema, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('restart'), id: extensionIdSchema }).strict(),
  z.object({ action: z.literal('applyUpdate'), id: extensionIdSchema }).strict(),
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
  z.object({ action: z.literal('viewRequest'), viewId: z.string().uuid(), generation: z.string().uuid(), token: z.string().uuid(), method: z.string().max(80), params: z.unknown() }).strict(),
])
export type ExtensionManagementRequest = z.infer<typeof extensionManagementSchema>
export interface ExtensionApi {
  fileOpeners: () => Promise<FileOpeningSnapshot>
  setFileOpener: (choice: FileOpeningChoice) => Promise<FileOpeningSnapshot>
  prepareFileOpening: (input: ExtensionFileOpeningInput) => Promise<ExtensionPreparedFileOpening>
  prepareReferenceOpening: (input: ExtensionReferenceOpening) => Promise<ExtensionPreparedFileOpening>
  detectShells: (id: string) => Promise<ShellCandidate[]>
  selectShellExecutable: (id: string, candidate: ShellCandidateId) => Promise<string | null>
  settingConditions: (id: string, items: string[], form?: ExtensionConfiguration) => Promise<Record<string, ExtensionConditionState>>
  onConditionsChanged: (listener: (event: ExtensionConditionsChanged) => void) => () => void
  taskActions: () => Promise<ExtensionTaskAction[]>
  invokeTaskAction: (input: ExtensionTaskActionInput) => Promise<ExtensionTaskActionResult>
  list: () => Promise<ExtensionStatus[]>
  unavailable: () => Promise<ExtensionUnavailableInstallation[]>
  configuration: (id: string) => Promise<ExtensionConfiguration>
  configurationSnapshot: (id: string) => Promise<ExtensionConfigurationSnapshot>
  configure: (id: string, patch: ExtensionConfiguration) => Promise<void>
  installations: () => Promise<ExtensionInstallation[]>
  catalog: (refresh?: boolean) => Promise<ExtensionCatalogSnapshot>
  reviewCatalog: (id: string, version: string) => Promise<ExtensionReviewResult>
  cancelInstallation: (id: string) => Promise<void>
  selectPackage: (development?: boolean) => Promise<ExtensionReviewResult | null>
  install: (token: string, choices?: FileOpeningChoice[]) => Promise<void>
  cancelInstall: (token: string) => Promise<void>
  enable: (id: string, enabled: boolean) => Promise<void>
  restart: (id: string) => Promise<void>
  applyUpdate: (id: string) => Promise<void>
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
  viewRequest: (viewId: string, generation: string, token: string, method: string, params: unknown) => Promise<JsonValue>
  onChanged: (listener: () => void) => () => void
  onReview: (listener: (review: ExtensionReviewResult) => void) => () => void
  onWorkbench: (listener: (event: ExtensionWorkbenchEvent) => void) => () => void
  replyWorkbench: (requestId: string, viewId: string | null) => void
}

const extensionModelFailureSchema = z.object({
  data: z.object({ code: z.enum(['EXTENSION_MODEL_TRUNCATED', 'EXTENSION_MODEL_FAILED']) }),
})

export function extensionError(error: unknown): string {
  if (error instanceof z.ZodError)
    return 'EXTENSION_INVALID_ARGUMENT'
  const modelFailure = extensionModelFailureSchema.safeParse(error)
  if (modelFailure.success)
    return modelFailure.data.data.code
  const message = error instanceof Error ? error.message : ''
  return /^EXTENSION_[A-Z_]+$/.test(message) ? message : 'EXTENSION_OPERATION_FAILED'
}
