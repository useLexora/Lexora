import type { DeepReadonly } from '../../shared/runtime/apiValidation'
import { z } from 'zod'
import { isLexoraReleaseUrl } from './productLinks'

export const desktopVersionSchema = z.string().max(32).regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/)

export const desktopUpdateResultSchema = z.object({
  currentVersion: desktopVersionSchema,
  latestVersion: desktopVersionSchema,
  releaseUrl: z.url().refine(isLexoraReleaseUrl),
  releaseNotes: z.string().max(1024 * 1024),
  status: z.enum(['up_to_date', 'update_available']),
}).strict()

export type DesktopUpdateCheckResult = DeepReadonly<z.infer<typeof desktopUpdateResultSchema>>

export interface DesktopUpdateNotification {
  readonly id: 'desktop.update'
  readonly revision: string
  readonly kind: 'app.update-available'
  readonly origin: 'desktop'
  readonly attention: 'seen' | 'unseen'
  readonly occurredAt: string
  readonly action: { readonly type: 'open-app-update' }
  readonly payload: { readonly version: string }
}

export type DesktopUpdateDeliveryMode = 'restart' | 'open-package' | 'manual' | 'release'
export type DesktopUpdateDeliveryReason = 'metadata-required' | 'signature-required' | 'system-package' | 'asset-unavailable' | 'distribution-unavailable' | 'installer-unavailable' | null
export type DesktopUpdateFailureKind = 'download' | 'verification' | 'storage' | 'timeout'

export interface DesktopUpdateDeliveryState {
  readonly mode: DesktopUpdateDeliveryMode
  readonly reason: DesktopUpdateDeliveryReason
  readonly status: 'unsupported' | 'idle' | 'verifying' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'
  readonly version: string | null
  readonly progressPercent: number
  readonly downloadedBytes?: number
  readonly totalBytes?: number | null
  readonly failure?: DesktopUpdateFailureKind
}

export interface DesktopUpdateCacheSummary {
  readonly bytes: number
  readonly files: number
}

export interface DesktopUpdateCapabilities {
  readonly automaticCheck: boolean
  readonly download: boolean
  readonly install: boolean
}

export interface DesktopUpdateState {
  readonly manualInstallation?: DesktopUpdateManualInstallation
  readonly delivery?: DesktopUpdateDeliveryState
  readonly downloadDirectory?: string | null
  readonly revision: number
  readonly checking: boolean
  readonly enabled: boolean
  readonly lastCheckedAt: number | null
  readonly lastSuccessfulCheckAt: number | null
  readonly checkFailed: boolean
  readonly ignoredVersion: string | null
  readonly result: DesktopUpdateCheckResult | null
  readonly notification: DesktopUpdateNotification | null
  readonly reminderDueAt: number | null
  readonly reminderDeferredUntil?: number | null
}

export interface DesktopUpdateManualInstallation {
  readonly version: string
  readonly packageName: string
  readonly packagePath: string
  readonly manager: string
  readonly command: string
}

export const desktopUpdateActionSchema = z.discriminatedUnion('action', [
  z.object({ version: desktopVersionSchema, action: z.enum(['seen', 'ignore', 'reminded', 'unignore', 'cancel-snooze']) }).strict(),
  z.object({ version: desktopVersionSchema, action: z.literal('snooze'), delay: z.enum(['30-minutes', 'tomorrow']) }).strict(),
])

export type DesktopUpdateAction = z.infer<typeof desktopUpdateActionSchema>
export const desktopUpdateTargetSchema = z.object({ version: desktopVersionSchema }).strict()

export interface DesktopUpdateApi {
  download: (version: string) => Promise<void>
  cancelDownload: (version: string) => Promise<void>
  install: (version: string) => Promise<void>
  openDownloadDirectory: () => Promise<void>
  openPackage: (version: string) => Promise<void>
  getCacheSummary: () => Promise<DesktopUpdateCacheSummary>
  clearCache: () => Promise<void>
  getState: () => Promise<DesktopUpdateState>
  onChanged: (listener: (state: DesktopUpdateState) => void) => () => void
  acknowledge: (input: DesktopUpdateAction) => Promise<DesktopUpdateState>
  takeReminder: () => Promise<DesktopUpdateCheckResult | null>
}

export function compareDesktopVersions(left: string, right: string): number {
  const a = left.split('.').map(BigInt)
  const b = right.split('.').map(BigInt)
  for (let index = 0; index < 3; index++) {
    if (a[index]! > b[index]!)
      return 1
    if (a[index]! < b[index]!)
      return -1
  }
  return 0
}
