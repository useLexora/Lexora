import type { JsonValue } from '../workbench/workbenchState'
import type { ControlProposal, WorkbenchPresentation } from '../workbench/workbenchUi'
import type { ExtensionCatalogSnapshot } from './extensionCatalog'
import type { ExtensionInstallation } from './extensionInstallation'
import type { ExtensionManifest } from './extensionManifest'
import { z } from 'zod'
import { spaceFileTargetSchema } from '../spaces/spaceFileApi'
import { extensionIdSchema } from './extensionManifest'

export const EXTENSION_IPC = {
  request: 'lexora:extensions:request',
  changed: 'lexora:extensions:changed',
  review: 'lexora:extensions:review',
  workbench: 'lexora:extensions:workbench',
  workbenchReply: 'lexora:extensions:workbench-reply',
  hostRequest: 'lexora:extensions:host-request',
  hostMessage: 'lexora:extensions:host-message',
  hostReply: 'lexora:extensions:host-reply',
} as const
export const extensionJsonSchema = z.json().refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144, 'Extension data is too large')
export const extensionResourceSchema = z.object({ id: z.string().uuid(), name: z.string().max(512) }).strict()
export const extensionViewInputSchema = z.object({
  viewId: z.string().uuid(),
  extensionId: extensionIdSchema,
  viewType: z.string().max(180),
  placementId: z.string().min(1).max(180).optional(),
  resource: extensionResourceSchema.nullable(),
  state: extensionJsonSchema,
  stateVersion: z.number().int().min(0).max(10000),
}).strict()
export type ExtensionResource = z.infer<typeof extensionResourceSchema>
export type ExtensionViewInput = z.infer<typeof extensionViewInputSchema>
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
    | { kind: 'open', requestId: string, extensionId: string, generation: string, viewType: string, resource: ExtensionResource | null, state: JsonValue, stateVersion: number }
    | { kind: 'state', requestId: string, viewId: string, generation: string, token: string, state: JsonValue, stateVersion: number }
    | { kind: 'placement', requestId: string, extensionId: string, generation: string, placementId: string, visible: boolean }
    | { kind: 'control', requestId: string, viewId: string, generation: string, token: string, proposal: ControlProposal }
    | { kind: 'presentation', requestId: string, viewId: string, generation: string, token: string, presentation: WorkbenchPresentation }

export const extensionManagementSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('installations') }).strict(),
  z.object({ action: z.literal('catalog'), refresh: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('reviewCatalog'), id: extensionIdSchema, version: z.string().max(80) }).strict(),
  z.object({ action: z.literal('cancelInstallation'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('selectPackage'), development: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('install'), token: z.string().uuid() }).strict(),
  z.object({ action: z.literal('cancelInstall'), token: z.string().uuid() }).strict(),
  z.object({ action: z.literal('enable'), id: extensionIdSchema, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('restart'), id: extensionIdSchema }).strict(),
  z.object({ action: z.literal('uninstall'), id: extensionIdSchema }).strict(),
  z.object({ action: z.literal('devtools'), id: extensionIdSchema }).strict(),
  z.object({ action: z.literal('revokeResources'), id: extensionIdSchema }).strict(),
  z.object({ action: z.literal('execute'), id: extensionIdSchema, command: z.string().max(180), resource: spaceFileTargetSchema.nullable() }).strict(),
  z.object({ action: z.literal('openView'), view: extensionViewInputSchema }).strict(),
  z.object({ action: z.literal('closeView'), viewId: z.string().uuid(), generation: z.string().uuid(), token: z.string().uuid() }).strict(),
  z.object({ action: z.literal('viewRequest'), viewId: z.string().uuid(), generation: z.string().uuid(), token: z.string().uuid(), method: z.string().max(80), params: extensionJsonSchema }).strict(),
])
export type ExtensionManagementRequest = z.infer<typeof extensionManagementSchema>
export interface ExtensionApi {
  list: () => Promise<ExtensionStatus[]>
  installations: () => Promise<ExtensionInstallation[]>
  catalog: (refresh?: boolean) => Promise<ExtensionCatalogSnapshot>
  reviewCatalog: (id: string, version: string) => Promise<ExtensionReview>
  cancelInstallation: (id: string) => Promise<void>
  selectPackage: (development?: boolean) => Promise<ExtensionReview | null>
  install: (token: string) => Promise<void>
  cancelInstall: (token: string) => Promise<void>
  enable: (id: string, enabled: boolean) => Promise<void>
  restart: (id: string) => Promise<void>
  uninstall: (id: string) => Promise<void>
  devtools: (id: string) => Promise<void>
  revokeResources: (id: string) => Promise<void>
  execute: (id: string, command: string, resource: import('../spaces/spaceFileApi').SpaceFileTarget | null) => Promise<void>
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
