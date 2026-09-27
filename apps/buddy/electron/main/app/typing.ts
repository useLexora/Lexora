import type { BrowserWindow } from 'electron'
import type { ApplicationEvents } from '../../../shared/observability/ApplicationEvents'
import type { LexoraConfig } from '../../shared/desktopApi'
import type { DesktopDiagnosticLogger } from '../desktopDiagnostics'
import type { BuddyRuntimePaths } from '../paths'
import type { DesktopLaunchIntent } from '../startupIntent'
import type { DesktopStartup } from './DesktopStartup'

export interface DesktopEnvironment {
  events: ApplicationEvents
  startup: DesktopStartup
  diagnostics: DesktopDiagnosticLogger
  desktopIconPath: string
  initialLaunchIntent: DesktopLaunchIntent
  isSmokeTest: boolean
  paths: BuddyRuntimePaths
  windowStateAvailable: boolean
  setAutostart: (enabled: boolean) => Promise<void>
  trayIconPath: string
}

export interface DesktopQuitOptions {
  discardDraftsOnFailure?: boolean
  restart?: boolean
}

export interface DesktopQuitHost {
  getWindow: () => BrowserWindow | null
  getLanguage: () => LexoraConfig['desktop']['language']
}
