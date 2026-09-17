import type { BrowserFailureReason } from '../../shared/browser'
import type { ApplicationDiagnostic } from '../../shared/diagnostics/applicationDiagnostic'
import type { ApplicationLogApi } from '../../shared/diagnostics/applicationLog'
import type { ApplicationStartupState } from '../../shared/diagnostics/applicationStartup'
import type { SandboxEnvironmentStatus, SandboxSetupResult } from '../../shared/permissions/shellSandbox'
import type { BuddyCapabilities } from '../../shared/platform'
import type { DesktopCommandId, DesktopPlatform } from './desktopCommands'
import type { LocalChatApi } from './localChatApi'

export const DESKTOP_IPC_CHANNELS = {
  contextPanelGetState: 'lexora:context-panel:get-state',
  contextPanelExecute: 'lexora:context-panel:execute',
  contextPanelStateChanged: 'lexora:context-panel:state-changed',
  appLogsQuery: 'lexora:app:logs:query',
  appStartupGetState: 'lexora:app:startup:get-state',
  appStartupReport: 'lexora:app:startup:report',
  appStartupStateChanged: 'lexora:app:startup:state-changed',
  appCheckForUpdates: 'lexora:app:check-for-updates',
  appGetInfo: 'lexora:app:get-info',
  appGetSandboxStatus: 'lexora:app:get-sandbox-status',
  appSetupSandbox: 'lexora:app:setup-sandbox',
  appOpenFeedbackIssue: 'lexora:app:open-feedback-issue',
  appOpenReleasePage: 'lexora:app:open-release-page',
  appOpenTarget: 'lexora:app:open-target',
  appHidden: 'lexora:app:hidden',
  appPrepareQuit: 'lexora:app:prepare-quit',
  appPrepareQuitAck: 'lexora:app:prepare-quit-ack',
  browserAttachGuest: 'lexora:browser:attach-guest',
  browserCaptureScreenshot: 'lexora:browser:capture-screenshot',
  browserClose: 'lexora:browser:close',
  browserEnsureSession: 'lexora:browser:ensure-session',
  browserGoBack: 'lexora:browser:go-back',
  browserGoForward: 'lexora:browser:go-forward',
  browserGuestsChanged: 'lexora:browser:guests-changed',
  browserListGuests: 'lexora:browser:list-guests',
  browserNavigate: 'lexora:browser:navigate',
  browserOpenArtifact: 'lexora:browser:open-artifact',
  browserOpenExternal: 'lexora:browser:open-external',
  browserReload: 'lexora:browser:reload',
  browserSetProfileMode: 'lexora:browser:set-profile-mode',
  browserSetSurface: 'lexora:browser:set-surface',
  browserShowFileInFolder: 'lexora:browser:show-file-in-folder',
  browserStateChanged: 'lexora:browser:state-changed',
  browserStop: 'lexora:browser:stop',
  browserTakeControl: 'lexora:browser:take-control',
  clipboardWriteText: 'lexora:clipboard:write-text',
  commandExecute: 'lexora:command:execute',
  settingsGet: 'lexora:settings:get',
  settingsUpdate: 'lexora:settings:update',
  windowGetState: 'lexora:window:get-state',
  windowMinimize: 'lexora:window:minimize',
  windowStateChanged: 'lexora:window:state-changed',
  windowToggleMaximize: 'lexora:window:toggle-maximize',
} as const

export const DESKTOP_BROWSER_ERROR_CODES = [
  'BROWSER_CERTIFICATE_ERROR',
  'BROWSER_NAVIGATION_BLOCKED',
  'BROWSER_PAGE_CRASHED',
  'BROWSER_PAGE_FAILED',
  'BROWSER_PAGE_UNRESPONSIVE',
  'BROWSER_PERMISSION_DENIED',
  'BROWSER_SESSION_EVICTED',
  'BROWSER_SESSION_LIMIT_REACHED',
  'BROWSER_SESSION_NOT_FOUND',
] as const

export const DESKTOP_BROWSER_SECURITY_KINDS = [
  'blank',
  'certificate-error',
  'insecure',
  'local',
  'secure',
] as const

export const DESKTOP_BROWSER_PROFILE_MODES = ['default', 'incognito'] as const

export type DesktopBrowserErrorCode = typeof DESKTOP_BROWSER_ERROR_CODES[number]
export type DesktopBrowserProfileMode = typeof DESKTOP_BROWSER_PROFILE_MODES[number]
export type DesktopBrowserSecurityKind = typeof DESKTOP_BROWSER_SECURITY_KINDS[number]
export type DesktopBrowserStatus = 'error' | 'idle' | 'loading' | 'ready'

export interface DesktopBrowserError {
  code: DesktopBrowserErrorCode
  message: string
  reason?: BrowserFailureReason
}

export type DesktopBrowserSecurityState = {
  kind: 'blank'
  origin: null
} | {
  kind: Exclude<DesktopBrowserSecurityKind, 'blank'>
  origin: string
}

export interface DesktopBrowserState {
  canGoBack: boolean
  canGoForward: boolean
  controller: 'agent' | 'human'
  controlEpoch: number
  conversationId: string | null
  error: DesktopBrowserError | null
  pageId: string
  profileMode: DesktopBrowserProfileMode
  security: DesktopBrowserSecurityState
  sessionId: string
  status: DesktopBrowserStatus
  title: string
  url: string
  visible: boolean
}

export interface DesktopBrowserGuestDescriptor {
  partition: string
  sessionId: string
}

export interface DesktopBrowserAttachGuestInput {
  sessionId: string
  webContentsId: number
}

export interface DesktopBrowserEnsureSessionInput {
  conversationId: string | null
  tabId?: string
}

export interface DesktopBrowserNavigateInput {
  sessionId: string
  url: string
}

export interface DesktopBrowserOpenArtifactInput {
  artifactId: string
  sessionId: string
}

export interface DesktopBrowserSessionInput {
  sessionId: string
}

export interface DesktopBrowserSetProfileModeInput {
  profileMode: DesktopBrowserProfileMode
  sessionId: string
}

export interface DesktopBrowserSetSurfaceInput {
  sessionId: string
  visible: boolean
}

export interface DesktopBrowserApi {
  attachGuest: (sessionId: string, webContentsId: number) => Promise<void>
  captureScreenshot: (sessionId: string) => Promise<boolean>
  close: (sessionId: string) => Promise<void>
  ensureSession: (conversationId: string | null, tabId?: string) => Promise<DesktopBrowserState>
  goBack: (sessionId: string) => Promise<void>
  goForward: (sessionId: string) => Promise<void>
  listGuests: () => Promise<DesktopBrowserGuestDescriptor[]>
  navigate: (sessionId: string, url: string) => Promise<DesktopBrowserState>
  onGuestsChanged: (listener: () => void) => () => void
  onStateChanged: (listener: (state: DesktopBrowserState) => void) => () => void
  openArtifact: (sessionId: string, artifactId: string) => Promise<DesktopBrowserState>
  openExternal: (sessionId: string) => Promise<boolean>
  reload: (sessionId: string) => Promise<void>
  setProfileMode: (
    sessionId: string,
    profileMode: DesktopBrowserProfileMode,
  ) => Promise<DesktopBrowserState>
  setSurface: (input: DesktopBrowserSetSurfaceInput) => Promise<void>
  showFileInFolder: (sessionId: string) => Promise<boolean>
  stop: (sessionId: string) => Promise<void>
  takeControl: (sessionId: string) => Promise<DesktopBrowserState>
}

export interface DesktopUpdateCheckResult {
  currentVersion: string
  latestVersion: string
  releaseUrl: string
  status: 'up_to_date' | 'update_available'
}

export interface DesktopOpenTarget {
  conversationId: string
  runId: string
}

export interface DesktopWindowState {
  isMaximized: boolean
}

export interface DesktopAppInfo {
  capabilities: BuddyCapabilities
  chromiumVersion: string
  configPath: string
  electronVersion: string
  nodeVersion: string
  platform: DesktopPlatform
  version: string
}

export interface DesktopTaskPinnedItem {
  id: string
  kind: 'conversation' | 'space'
}

export const DESKTOP_CHAT_WELCOME_VARIANT_IDS = [
  'writing',
  'planning',
  'orchestrating',
] as const

export const DESKTOP_TASK_SIDEBAR_SECTIONS = ['pinned', 'spaces', 'tasks'] as const

export type DesktopTaskSidebarSection = typeof DESKTOP_TASK_SIDEBAR_SECTIONS[number]

/** 任务 Workspace sidebar 的布局偏好，随页面卸载重建后从配置恢复。 */
export interface DesktopTaskSidebarPreferences {
  collapsed: boolean
  collapsedSections: DesktopTaskSidebarSection[]
  collapsedSpaces: string[]
  width: number | null
}

export type DesktopChatWelcomeVariantId = typeof DESKTOP_CHAT_WELCOME_VARIANT_IDS[number]
export type DesktopChatWelcomePreference = 'random' | DesktopChatWelcomeVariantId
export type DesktopContextPanelMode = 'task' | 'independent'

export interface LexoraConfig {
  proxy: import('../../shared/network/proxySettings').ProxySettings
  desktop: {
    backgroundCloseNoticeShown: boolean
    contextPanelMode: DesktopContextPanelMode
    contextPanelGlobal: boolean
    taskSidebarPinnedItems: DesktopTaskPinnedItem[]
    taskSidebar: DesktopTaskSidebarPreferences
    developerToolsEnabled: boolean
    language: 'zh-CN' | 'en-US'
    launchAtLogin: boolean
    notificationsEnabled: boolean
    notifyWhenFocused: boolean
    sidebarCollapsed: boolean
    theme: 'system' | 'light' | 'dark'
    welcomeVariant: DesktopChatWelcomePreference
  }
  pet: {
    alwaysOnTop: boolean
    enabled: boolean
    rememberPosition: boolean
  }
}

export interface LexoraConfigPatch {
  proxy?: LexoraConfig['proxy']
  desktop?: Partial<Omit<LexoraConfig['desktop'], 'taskSidebar'>> & {
    taskSidebar?: Partial<DesktopTaskSidebarPreferences>
  }
  pet?: Partial<LexoraConfig['pet']>
}

export interface LexoraDesktopApi {
  contextPanel: import('../../shared/context-panel/contextPanel').ContextPanelApi
  app: {
    logs: ApplicationLogApi
    startup: {
      getState: () => Promise<ApplicationStartupState>
      onStateChanged: (listener: (state: ApplicationStartupState) => void) => () => void
      reportEvent: (event: ApplicationDiagnostic) => Promise<void>
    }
    checkForUpdates: () => Promise<DesktopUpdateCheckResult>
    getInfo: () => Promise<DesktopAppInfo>
    getSandboxStatus: () => Promise<SandboxEnvironmentStatus>
    setupSandbox: () => Promise<SandboxSetupResult>
    onBeforeQuit: (listener: () => Promise<boolean>) => () => void
    onHidden: (listener: () => void) => () => void
    onOpenTarget: (listener: (target: DesktopOpenTarget) => void) => () => void
    openFeedbackIssue: (feedback: string) => Promise<void>
    openReleasePage: (url: string) => Promise<void>
  }
  browser: DesktopBrowserApi
  clipboard: {
    getFilePath: (file: File) => string
    writeText: (text: string) => Promise<void>
  }
  commands: {
    execute: (commandId: DesktopCommandId) => Promise<void>
  }
  settings: {
    get: () => Promise<LexoraConfig>
    update: (patch: LexoraConfigPatch) => Promise<LexoraConfig>
  }
  window: {
    getState: () => Promise<DesktopWindowState>
    minimize: () => Promise<void>
    onStateChanged: (listener: (state: DesktopWindowState) => void) => () => void
    toggleMaximize: () => Promise<DesktopWindowState>
  }
  localChat: LocalChatApi
}
