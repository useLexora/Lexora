import type { DesktopBrowserApi } from '../../shared/browser/browserDesktopApi'
import type { DesktopNavigationLayout } from '../../shared/desktopNavigationLayout'
import type { ApplicationLogApi } from '../../shared/diagnostics/applicationLog'
import type { ApplicationStartupState } from '../../shared/diagnostics/applicationStartup'
import type { PerformanceDiagnosticApi } from '../../shared/diagnostics/performanceDiagnostic'
import type { RendererDiagnosticApi } from '../../shared/diagnostics/rendererDiagnostic'
import type { RendererLifecycleReport } from '../../shared/lifecycle/serviceLifecycle'
import type { DesktopNotificationsApi } from '../../shared/notifications/desktopNotification'
import type { NotificationSoundPreferences, NotificationSoundsApi } from '../../shared/notifications/notificationSound'
import type { SandboxEnvironmentStatus, SandboxSetupResult } from '../../shared/permissions/shellSandbox'
import type { BuddyCapabilities } from '../../shared/platform'
import type { BuddyRuntimeProfile } from '../../shared/runtime/profile'
import type { ThemePreference } from '../../shared/theme/themePreferences'
import type { DesktopChatWelcomeItem, DesktopChatWelcomePreference } from './desktopChatWelcome'
import type { DesktopCommandId, DesktopPlatform } from './desktopCommands'
import type { DesktopUpdateApi, DesktopUpdateCapabilities, DesktopUpdateCheckResult } from './desktopUpdates'
import type { LocalChatApi } from './localChatApi'
import { BUDDY_DEFAULT_PERMISSION_MODE } from '../../shared/permissions/permissionMode'
import { DEFAULT_DESKTOP_CHAT_WELCOME_ITEMS } from './desktopChatWelcome'

export { DESKTOP_BROWSER_ERROR_CODES, DESKTOP_BROWSER_PROFILE_MODES, DESKTOP_BROWSER_SECURITY_KINDS } from '../../shared/browser/browserDesktopApi'
export type { DesktopBrowserApi, DesktopBrowserAttachGuestInput, DesktopBrowserEnsureSessionInput, DesktopBrowserError, DesktopBrowserErrorCode, DesktopBrowserGuestDescriptor, DesktopBrowserNavigateInput, DesktopBrowserOpenArtifactInput, DesktopBrowserProfileMode, DesktopBrowserSecurityKind, DesktopBrowserSecurityState, DesktopBrowserSessionInput, DesktopBrowserSetProfileModeInput, DesktopBrowserSetSurfaceInput, DesktopBrowserState, DesktopBrowserStatus } from '../../shared/browser/browserDesktopApi'
export { DESKTOP_NAVIGATION_LAYOUTS } from '../../shared/desktopNavigationLayout'

export const DESKTOP_IPC_CHANNELS = {
  workbenchRead: 'lexora:workbench:read',
  workbenchWrite: 'lexora:workbench:write',
  contextPanelGetState: 'lexora:context-panel:get-state',
  contextPanelExecute: 'lexora:context-panel:execute',
  contextPanelStateChanged: 'lexora:context-panel:state-changed',
  appPerformanceSnapshot: 'lexora:app:performance:snapshot',
  appPerformanceCapture: 'lexora:app:performance:capture',
  appLogsQuery: 'lexora:app:logs:query',
  appLogsReport: 'lexora:app:logs:report',
  appLogsExportDiagnostics: 'lexora:app:logs:export-diagnostics',
  appStartupGetState: 'lexora:app:startup:get-state',
  appStartupReport: 'lexora:app:startup:report',
  appStartupStateChanged: 'lexora:app:startup:state-changed',
  appCheckForUpdates: 'lexora:app:check-for-updates',
  appUpdatesDownload: 'lexora:app:updates:download',
  appUpdatesCancelDownload: 'lexora:app:updates:cancel-download',
  appUpdatesInstall: 'lexora:app:updates:install',
  appUpdatesOpenPackage: 'lexora:app:updates:open-package',
  appUpdatesOpenDirectory: 'lexora:app:updates:open-directory',
  appUpdatesCacheSummary: 'lexora:app:updates:cache-summary',
  appUpdatesClearCache: 'lexora:app:updates:clear-cache',
  appUpdatesState: 'lexora:app:updates:state',
  appUpdatesChanged: 'lexora:app:updates:changed',
  appUpdatesAcknowledge: 'lexora:app:updates:acknowledge',
  appUpdatesTakeReminder: 'lexora:app:updates:take-reminder',
  appGetInfo: 'lexora:app:get-info',
  appGetSandboxStatus: 'lexora:app:get-sandbox-status',
  appSetupSandbox: 'lexora:app:setup-sandbox',
  appOpenFeedbackIssue: 'lexora:app:open-feedback-issue',
  appOpenReleasePage: 'lexora:app:open-release-page',
  appOpenTarget: 'lexora:app:open-target',
  appHidden: 'lexora:app:hidden',
  appPrepareQuit: 'lexora:app:prepare-quit',
  appPrepareQuitAck: 'lexora:app:prepare-quit-ack',
  appCancelQuitPreparation: 'lexora:app:cancel-quit-preparation',
  browserPickElement: 'lexora:browser:pick-element',
  browserCancelElementPick: 'lexora:browser:cancel-element-pick',
  browserLocateElement: 'lexora:browser:locate-element',
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
  browserOpenFile: 'lexora:browser:open-file',
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
  settingsChanged: 'lexora:settings:changed',
  windowGetState: 'lexora:window:get-state',
  windowMinimize: 'lexora:window:minimize',
  windowStateChanged: 'lexora:window:state-changed',
  windowToggleMaximize: 'lexora:window:toggle-maximize',
} as const

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
  updateCapabilities?: DesktopUpdateCapabilities
  runtimeProfile: BuddyRuntimeProfile
  isPackaged: boolean
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

export const DESKTOP_TASK_SIDEBAR_SECTIONS = ['pinned', 'spaces', 'tasks'] as const

export type DesktopTaskSidebarSection = typeof DESKTOP_TASK_SIDEBAR_SECTIONS[number]

/** 任务 Workspace sidebar 的布局偏好，随页面卸载重建后从配置恢复。 */
export interface DesktopTaskSidebarPreferences {
  collapsed: boolean
  collapsedSections: DesktopTaskSidebarSection[]
  collapsedSpaces: string[]
  width: number | null
}

export type { DesktopNavigationLayout } from '../../shared/desktopNavigationLayout'
export { DEFAULT_DESKTOP_CHAT_WELCOME_ITEMS, DESKTOP_CHAT_WELCOME_VARIANT_IDS } from './desktopChatWelcome'
export type DesktopContextPanelMode = 'task' | 'space' | 'independent'

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
  followUpBehavior: 'queue' | 'steer'
  outlinePosition: DesktopChatOutlinePosition
  pasteTextAsAttachment: boolean
  permissionMode: import('../../shared/permissions/permissionMode').BuddyPermissionMode
  welcome: DesktopChatWelcomePreference
  welcomeEnabled: boolean
  welcomeItems: ReadonlyArray<DesktopChatWelcomeItem>
  welcomeGreetingEnabled: boolean
  welcomeCompanionEnabled: boolean
  welcomeCompanionImage: string
  welcomeCompanionImages: readonly string[]
}

export const DEFAULT_DESKTOP_CHAT_PREFERENCES: Readonly<DesktopChatPreferences> = {
  followUpBehavior: 'steer',
  outlinePosition: 'top-right',
  pasteTextAsAttachment: true,
  permissionMode: BUDDY_DEFAULT_PERMISSION_MODE,
  welcome: 'random',
  welcomeEnabled: true,
  welcomeItems: [...DEFAULT_DESKTOP_CHAT_WELCOME_ITEMS],
  welcomeGreetingEnabled: true,
  welcomeCompanionEnabled: true,
  welcomeCompanionImage: 'lexora',
  welcomeCompanionImages: [],
}

export interface LexoraConfig {
  runtime: import('../../shared/runtime/runtimePreferences').RuntimePreferences
  browser: import('../../shared/browser/browserPreferences').BrowserPreferences
  proxy: import('../../shared/network/proxySettings').ProxySettings
  desktop: {
    featureDiscovery: import('../../shared/onboarding/featureDiscovery').FeatureDiscoveryState
    featureAnnouncementsEnabled: boolean
    onboardingCompleted: boolean
    backgroundCloseNoticeShown: boolean
    chat: DesktopChatPreferences
    contextPanelMode: DesktopContextPanelMode
    contextPanelGlobal: boolean
    contextPanelAutoCollapse: boolean
    keybindings: Record<string, string>
    taskSidebarPinnedItems: DesktopTaskPinnedItem[]
    taskSidebar: DesktopTaskSidebarPreferences
    developerToolsEnabled: boolean
    language: 'zh-CN' | 'en-US'
    launchAtLogin: boolean
    notificationsEnabled: boolean
    notificationSound: NotificationSoundPreferences
    subtaskNotificationsEnabled: boolean
    updateNotificationsEnabled: boolean
    autoDownloadUpdates: boolean
    localBackupLimit: number
    notifyWhenFocused: boolean
    profile: DesktopUserProfileConfig
    pluginAuthor: string
    sidebarCollapsed: boolean
    navigationLayout: DesktopNavigationLayout
    fileIconTheme: { id: string }
    theme: ThemePreference
    typography: import('../../shared/typography/typographyPreferences').TypographyPreferences
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
  desktop?: Partial<Omit<LexoraConfig['desktop'], 'chat' | 'taskSidebar' | 'profile' | 'typography' | 'notificationSound'>> & {
    notificationSound?: Partial<Pick<NotificationSoundPreferences, 'selected' | 'volume'>>
    typography?: Partial<LexoraConfig['desktop']['typography']>
    chat?: Partial<DesktopChatPreferences>
    taskSidebar?: Partial<DesktopTaskSidebarPreferences>
    profile?: Partial<DesktopUserProfileConfig>
  }
  pet?: Partial<LexoraConfig['pet']>
}

export interface LexoraDesktopApi {
  notifications: DesktopNotificationsApi
  notificationSounds: NotificationSoundsApi
  sync: import('../../shared/sync/syncApi').SyncApi
  storage: import('../../shared/storage/storageApi').StorageApi
  fileIcons: import('../../shared/icons/fileIconThemeApi').FileIconThemeApi
  themes: import('../../shared/theme/themeApi').ThemeApi
  extensions: import('../../shared/extensions/extensionApi').ExtensionApi
  workbench: import('../../shared/workbench/workbenchState').WorkbenchStateApi
  contextPanel: import('../../shared/context-panel/contextPanel').ContextPanelApi
  app: {
    performance: PerformanceDiagnosticApi
    logs: ApplicationLogApi & RendererDiagnosticApi
    startup: {
      getState: () => Promise<ApplicationStartupState>
      onStateChanged: (listener: (state: ApplicationStartupState) => void) => () => void
      reportLifecycle: (report: RendererLifecycleReport) => Promise<void>
    }
    updates: DesktopUpdateApi
    checkForUpdates: () => Promise<DesktopUpdateCheckResult>
    getInfo: () => Promise<DesktopAppInfo>
    getSandboxStatus: () => Promise<SandboxEnvironmentStatus>
    setupSandbox: () => Promise<SandboxSetupResult>
    onBeforeQuit: (listener: (requestId: string) => Promise<boolean>) => () => void
    onQuitPreparationCancelled: (listener: (requestId: string) => void) => () => void
    onHidden: (listener: () => void) => () => void
    onOpenTarget: (listener: (target: DesktopOpenTarget) => void) => () => void
    openFeedbackIssue: (feedback: string) => Promise<void>
    openReleasePage: (url: string) => Promise<void>
  }
  browser: DesktopBrowserApi
  clipboard: {
    getFilePath: (file: File) => string
    writeText: (text: string, html?: string) => Promise<void>
  }
  commands: {
    execute: (commandId: DesktopCommandId) => Promise<void>
  }
  settings: {
    onChanged: (listener: (config: LexoraConfig) => void) => () => void
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

export type { DesktopChatWelcomeItem, DesktopChatWelcomePreference, DesktopChatWelcomeVariantId } from './desktopChatWelcome'
export type { DesktopCommandId, DesktopPlatform } from './desktopCommands'
export type { DesktopUpdateCheckResult } from './desktopUpdates'
