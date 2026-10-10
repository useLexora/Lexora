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

export interface DesktopUpdateState {
  readonly revision: number
  readonly checking: boolean
  readonly enabled: boolean
  readonly result: DesktopUpdateCheckResult | null
  readonly notification: DesktopUpdateNotification | null
  readonly reminderDueAt: number | null
}

export const desktopUpdateActionSchema = z.object({
  version: desktopVersionSchema,
  action: z.enum(['seen', 'ignore', 'reminded']),
}).strict()

export type DesktopUpdateAction = z.infer<typeof desktopUpdateActionSchema>

export interface DesktopUpdateApi {
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
