import type { DesktopBrowserApi } from '../../shared/browser/browserDesktopApi'
import type { ApplicationDiagnostic } from '../../shared/diagnostics/applicationDiagnostic'
import type { ApplicationLogApi } from '../../shared/diagnostics/applicationLog'
import type { ApplicationStartupState } from '../../shared/diagnostics/applicationStartup'
import type { SandboxEnvironmentStatus, SandboxSetupResult } from '../../shared/permissions/shellSandbox'
import type { BuddyCapabilities } from '../../shared/platform'
import type { DesktopCommandId, DesktopPlatform } from './desktopCommands'
import type { LocalChatApi } from './localChatApi'

export const DESKTOP_IPC_CHANNELS = {
  workbenchRead: 'lexora:workbench:read',
  workbenchWrite: 'lexora:workbench:write',
  contextPanelGetState: 'lexora:context-panel:get-state',
  contextPanelExecute: 'lexora:context-panel:execute',
  contextPanelStateChanged: 'lexora:context-panel:state-changed',
  appLogsQuery: 'lexora:app:logs:query',
  appLogsExportDiagnostics: 'lexora:app:logs:export-diagnostics',
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
  browserClearData: 'lexora:browser:clear-data',
  browserGetDataSummary: 'lexora:browser:get-data-summary',
  browserSetZoomFactor: 'lexora:browser:set-zoom-factor',
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

export interface SystemUserProfile {
  username: string
  displayName: string
  hostname: string
  avatarUrl: string | null
}

export const DESKTOP_PROFILE_AVATAR_MAX_BYTES = 2 * 1024 * 1024
export const DESKTOP_PROFILE_AVATAR_MAX_DATA_URL_LENGTH = 3_000_000

export interface DesktopUserProfileConfig {
  userName: string
  deviceName: string
  avatar: string
}

export interface DesktopAppInfo {
  capabilities: BuddyCapabilities
  chromiumVersion: string
  configPath: string
  electronVersion: string
  nodeVersion: string
  platform: DesktopPlatform
  version: string
  systemProfile: SystemUserProfile
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
export type DesktopChatWelcomePreference = 'none' | 'random' | DesktopChatWelcomeVariantId
export type DesktopContextPanelMode = 'task' | 'independent'

export const DESKTOP_CHAT_OUTLINE_POSITIONS = [
  'top-left',
  'center-left',
  'bottom-left',
  'top-right',
  'center-right',
  'bottom-right',
] as const

export type DesktopChatOutlinePosition = typeof DESKTOP_CHAT_OUTLINE_POSITIONS[number]

export interface DesktopChatPreferences {
  outlinePosition: DesktopChatOutlinePosition
  welcome: DesktopChatWelcomePreference
}

export const DEFAULT_DESKTOP_CHAT_PREFERENCES: Readonly<DesktopChatPreferences> = {
  outlinePosition: 'top-right',
  welcome: 'random',
}

export interface LexoraConfig {
  runtime: import('../../shared/runtime/runtimePreferences').RuntimePreferences
  browser: import('../../shared/browser/browserPreferences').BrowserPreferences
  proxy: import('../../shared/network/proxySettings').ProxySettings
  desktop: {
    backgroundCloseNoticeShown: boolean
    chat: DesktopChatPreferences
    contextPanelMode: DesktopContextPanelMode
    contextPanelGlobal: boolean
    keybindings: Record<string, string>
    taskSidebarPinnedItems: DesktopTaskPinnedItem[]
    taskSidebar: DesktopTaskSidebarPreferences
    developerToolsEnabled: boolean
    language: 'zh-CN' | 'en-US'
    launchAtLogin: boolean
    notificationsEnabled: boolean
    notifyWhenFocused: boolean
    profile: DesktopUserProfileConfig
    sidebarCollapsed: boolean
    theme: 'system' | 'light' | 'dark'
  }
  pet: {
    alwaysOnTop: boolean
    enabled: boolean
    rememberPosition: boolean
  }
}

export interface LexoraConfigPatch {
  runtime?: Partial<LexoraConfig['runtime']>
  browser?: Partial<LexoraConfig['browser']>
  proxy?: LexoraConfig['proxy']
  desktop?: Partial<Omit<LexoraConfig['desktop'], 'chat' | 'taskSidebar' | 'profile'>> & {
    chat?: Partial<DesktopChatPreferences>
    taskSidebar?: Partial<DesktopTaskSidebarPreferences>
    profile?: Partial<DesktopUserProfileConfig>
  }
  pet?: Partial<LexoraConfig['pet']>
}

export interface LexoraDesktopApi {
  extensions: import('../../shared/extensions/extensionApi').ExtensionApi
  workbench: import('../../shared/workbench/workbenchState').WorkbenchStateApi
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

export { DESKTOP_BROWSER_ERROR_CODES, DESKTOP_BROWSER_PROFILE_MODES, DESKTOP_BROWSER_SECURITY_KINDS } from '../../shared/browser/browserDesktopApi'
export type { DesktopBrowserApi, DesktopBrowserAttachGuestInput, DesktopBrowserEnsureSessionInput, DesktopBrowserError, DesktopBrowserErrorCode, DesktopBrowserGuestDescriptor, DesktopBrowserNavigateInput, DesktopBrowserOpenArtifactInput, DesktopBrowserProfileMode, DesktopBrowserSecurityKind, DesktopBrowserSecurityState, DesktopBrowserSessionInput, DesktopBrowserSetProfileModeInput, DesktopBrowserSetSurfaceInput, DesktopBrowserState, DesktopBrowserStatus } from '../../shared/browser/browserDesktopApi'
export type { DesktopCommandId, DesktopPlatform } from './desktopCommands'
