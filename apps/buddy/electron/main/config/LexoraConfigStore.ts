import type { ZodError } from 'zod'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { LexoraConfig, LexoraConfigPatch } from '../../shared/desktopApi'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import { parse, stringify } from 'smol-toml'
import { z } from 'zod'
import { browserPreferencesSchema, DEFAULT_BROWSER_PREFERENCES } from '../../../shared/browser/browserPreferences'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { extensionAuthorSchema } from '../../../shared/extensions/extensionIdentity'
import { BUILTIN_FILE_ICON_THEME, fileIconPreferenceSchema } from '../../../shared/icons/fileIconTheme'
import { DEFAULT_PROXY_SETTINGS, proxySettingsSchema } from '../../../shared/network/proxySettings'
import { BUDDY_PERMISSION_MODES } from '../../../shared/permissions/permissionMode'
import { DEFAULT_RUNTIME_PREFERENCES, runtimePreferencesSchema } from '../../../shared/runtime/runtimePreferences'
import { keybindingsSchema } from '../../../shared/shortcuts/keybindingSchema'
import { DEFAULT_LOCAL_BACKUP_LIMIT, localBackupLimitSchema } from '../../../shared/storage/backupRetention'
import { DESKTOP_ACCENT_COLORS, legacyThemePreferenceSchema, migrateThemePreference, themePreferenceSchema } from '../../../shared/theme/themePreferences'
import { DEFAULT_TYPOGRAPHY, typographyPreferencesSchema } from '../../../shared/typography/typographyPreferences'
import { DEFAULT_DESKTOP_CHAT_PREFERENCES, DEFAULT_DESKTOP_CHAT_WELCOME_ITEMS, DESKTOP_CHAT_OUTLINE_POSITIONS, DESKTOP_PROFILE_AVATAR_MAX_DATA_URL_LENGTH, DESKTOP_TASK_SIDEBAR_SECTIONS } from '../../shared/desktopApi'

import { desktopChatWelcomeItemsSchema } from '../../shared/desktopApiSchemas'
import { isPresetWelcomeId, normalizeDesktopChatWelcomePreference } from '../../shared/desktopChatWelcome'

function migrateWelcomeItems(value: unknown): unknown {
  if (!Array.isArray(value))
    return value
  return value.filter(item => asRecord(item).id !== 'orchestrating').map((item) => {
    const record = asRecord(item)
    if (record.kind !== undefined || typeof record.id !== 'string')
      return item
    return isPresetWelcomeId(record.id)
      ? { kind: 'preset', id: record.id }
      : { kind: 'custom', id: record.id, text: record.text }
  })
}

const taskSidebarPinnedItemSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().min(1).max(128), kind: z.literal('conversation') }).strict(),
  z.object({ id: z.string().min(1).max(128), kind: z.literal('space') }).strict(),
])

const taskSidebarConfigSchema = z.object({
  collapsed: z.boolean().default(false),
  collapsed_sections: z.array(z.enum(DESKTOP_TASK_SIDEBAR_SECTIONS))
    .max(DESKTOP_TASK_SIDEBAR_SECTIONS.length)
    .refine(sections => new Set(sections).size === sections.length)
    .default([]),
  collapsed_spaces: z.array(z.string().min(1).max(128))
    .max(500)
    .refine(ids => new Set(ids).size === ids.length)
    .default([]),
  width: z.number().int().min(0).max(10_000).optional(),
}).passthrough().default({
  collapsed: false,
  collapsed_sections: [],
  collapsed_spaces: [],
})

const desktopConfigSchema = z.object({
  typography: z.object({
    ui_font: typographyPreferencesSchema.shape.uiFont.default(DEFAULT_TYPOGRAPHY.uiFont),
    body_font: typographyPreferencesSchema.shape.bodyFont.default(DEFAULT_TYPOGRAPHY.bodyFont),
    code_font: typographyPreferencesSchema.shape.codeFont.default(DEFAULT_TYPOGRAPHY.codeFont),
    body_size: typographyPreferencesSchema.shape.bodySize.default(DEFAULT_TYPOGRAPHY.bodySize),
  }).passthrough().prefault({}),
  plugin_author: extensionAuthorSchema.default(''),
  background_close_notice_shown: z.boolean().default(false),
  chat: z.object({
    outline_position: z.enum(DESKTOP_CHAT_OUTLINE_POSITIONS).default(DEFAULT_DESKTOP_CHAT_PREFERENCES.outlinePosition),
    paste_text_as_attachment: z.boolean().default(DEFAULT_DESKTOP_CHAT_PREFERENCES.pasteTextAsAttachment),
    permission_mode: z.enum(BUDDY_PERMISSION_MODES).default(DEFAULT_DESKTOP_CHAT_PREFERENCES.permissionMode),
    welcome: z.string().max(64).default(DEFAULT_DESKTOP_CHAT_PREFERENCES.welcome).transform(val => val === 'orchestrating' ? 'writing' : val),
    welcome_items: z.preprocess(migrateWelcomeItems, desktopChatWelcomeItemsSchema.default([...DEFAULT_DESKTOP_CHAT_WELCOME_ITEMS])),
    welcome_enabled: z.boolean().optional(),
    welcome_greeting_enabled: z.boolean().default(DEFAULT_DESKTOP_CHAT_PREFERENCES.welcomeGreetingEnabled),
    welcome_companion_enabled: z.boolean().default(DEFAULT_DESKTOP_CHAT_PREFERENCES.welcomeCompanionEnabled),
  }).passthrough().prefault({}),
  context_panel_mode: z.enum(['task', 'space', 'independent']).default('task'),
  context_panel_global: z.boolean().default(false),
  context_panel_auto_collapse: z.boolean().default(false),
  keybindings: keybindingsSchema.default({}),
  task_sidebar_pinned_items: z.array(taskSidebarPinnedItemSchema)
    .max(500)
    .refine(items => new Set(items.map(item => `${item.kind}:${item.id}`)).size === items.length)
    .default([]),
  task_sidebar: taskSidebarConfigSchema,
  profile: z.object({
    user_name: z.string().max(30).default(''),
    device_name: z.string().max(30).default(''),
    avatar: z.string().max(DESKTOP_PROFILE_AVATAR_MAX_DATA_URL_LENGTH).default(''),
  }).passthrough().default({
    user_name: '',
    device_name: '',
    avatar: '',
  }),
  developer_tools_enabled: z.boolean().default(false),
  language: z.enum(['zh-CN', 'en-US']).default('zh-CN'),
  launch_at_login: z.boolean().default(false),
  notifications_enabled: z.boolean().default(true),
  subtask_notifications_enabled: z.boolean().default(true),
  update_notifications_enabled: z.boolean().default(true),
  auto_download_updates: z.boolean().default(true),
  local_backup_limit: localBackupLimitSchema.default(DEFAULT_LOCAL_BACKUP_LIMIT),
  notify_when_focused: z.boolean().default(false),
  sidebar_collapsed: z.boolean().default(false),
  file_icon_theme: fileIconPreferenceSchema.default({ id: BUILTIN_FILE_ICON_THEME }),
  theme: z.union([themePreferenceSchema, legacyThemePreferenceSchema, z.enum(['system', 'light', 'dark'])]).default('system'),
  accent_color: z.enum(DESKTOP_ACCENT_COLORS).default('default'),
}).passthrough().default({
  background_close_notice_shown: false,
  typography: { ui_font: '', body_font: '', code_font: '', body_size: DEFAULT_TYPOGRAPHY.bodySize },
  plugin_author: '',
  chat: {
    outline_position: DEFAULT_DESKTOP_CHAT_PREFERENCES.outlinePosition,
    paste_text_as_attachment: DEFAULT_DESKTOP_CHAT_PREFERENCES.pasteTextAsAttachment,
    permission_mode: DEFAULT_DESKTOP_CHAT_PREFERENCES.permissionMode,
    welcome: DEFAULT_DESKTOP_CHAT_PREFERENCES.welcome,
    welcome_items: [...DEFAULT_DESKTOP_CHAT_WELCOME_ITEMS],
    welcome_enabled: DEFAULT_DESKTOP_CHAT_PREFERENCES.welcomeEnabled,
    welcome_greeting_enabled: DEFAULT_DESKTOP_CHAT_PREFERENCES.welcomeGreetingEnabled,
    welcome_companion_enabled: DEFAULT_DESKTOP_CHAT_PREFERENCES.welcomeCompanionEnabled,
  },
  context_panel_mode: 'task',
  context_panel_global: false,
  context_panel_auto_collapse: false,
  keybindings: {},
  task_sidebar_pinned_items: [],
  task_sidebar: { collapsed: false, collapsed_sections: [], collapsed_spaces: [] },
  profile: { user_name: '', device_name: '', avatar: '' },
  developer_tools_enabled: false,
  language: 'zh-CN',
  launch_at_login: false,
  notifications_enabled: true,
  subtask_notifications_enabled: true,
  update_notifications_enabled: true,
  auto_download_updates: true,
  local_backup_limit: DEFAULT_LOCAL_BACKUP_LIMIT,
  notify_when_focused: false,
  sidebar_collapsed: false,
  file_icon_theme: { id: BUILTIN_FILE_ICON_THEME },
  theme: 'system',
  accent_color: 'default',
})

const petConfigSchema = z.object({
  always_on_top: z.boolean().default(true),
  enabled: z.boolean().default(true),
  remember_position: z.boolean().default(true),
}).passthrough().default({
  always_on_top: true,
  enabled: true,
  remember_position: true,
})

const lexoraConfigFileSchema = z.object({
  runtime: z.object({
    cache_warming: runtimePreferencesSchema.shape.cacheWarming.default(DEFAULT_RUNTIME_PREFERENCES.cacheWarming),
    codemode: runtimePreferencesSchema.shape.codemode.default(DEFAULT_RUNTIME_PREFERENCES.codemode),
    model_retry_limit: runtimePreferencesSchema.shape.modelRetryLimit.default(DEFAULT_RUNTIME_PREFERENCES.modelRetryLimit),
  }).passthrough().prefault({}),
  browser: z.object({
    screenshot_destination: browserPreferencesSchema.shape.screenshotDestination.default(DEFAULT_BROWSER_PREFERENCES.screenshotDestination),
    default_zoom_factor: browserPreferencesSchema.shape.defaultZoomFactor.default(DEFAULT_BROWSER_PREFERENCES.defaultZoomFactor),
    freeze_background: browserPreferencesSchema.shape.freezeBackground.default(DEFAULT_BROWSER_PREFERENCES.freezeBackground),
    freeze_foreground: browserPreferencesSchema.shape.freezeForeground.default(DEFAULT_BROWSER_PREFERENCES.freezeForeground),
    freeze_delay_seconds: browserPreferencesSchema.shape.freezeDelaySeconds.default(DEFAULT_BROWSER_PREFERENCES.freezeDelaySeconds),
  }).passthrough().prefault({}),
  proxy: proxySettingsSchema.default(DEFAULT_PROXY_SETTINGS),
  desktop: desktopConfigSchema,
  pet: petConfigSchema,
}).passthrough()

export class LexoraConfigError extends Error {
  readonly code = 'INVALID_CONFIG'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LexoraConfigError'
  }
}

export type LexoraConfigChange = {
  readonly revision: number
  readonly operationId: string
  readonly groups: readonly (keyof LexoraConfig)[]
} & ({ readonly kind: 'committed', readonly config: EventSnapshot<LexoraConfig> } | { readonly kind: 'applied' | 'apply-failed' | 'commit-failed' | 'rolled-back' | 'rollback-failed' | 'cleanup-failed' })

export class LexoraConfigStore {
  readonly #changes = new Emitter<LexoraConfigChange>(() => console.error('CONFIG_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #revision = 0
  #persisted: LexoraConfig | null = null
  #applied: LexoraConfig | null = null
  #disposing: Promise<void> | undefined
  readonly #configPath: string
  #writeQueue: Promise<void> = Promise.resolve()

  constructor(options: { configPath: string }) {
    this.#configPath = options.configPath
  }

  async read(): Promise<LexoraConfig> {
    await this.#writeQueue
    const config = decodeConfig(await this.#readFile())
    this.#persisted = structuredClone(config)
    return config
  }

  get snapshot() { return copyEventSnapshot({ revision: this.#revision, persisted: this.#persisted, applied: this.#applied }) }

  update(patch: LexoraConfigPatch, apply?: (config: LexoraConfig) => Promise<void> | void, assertCurrent: () => void = () => {}): Promise<LexoraConfig> {
    if (this.#disposing)
      return Promise.reject(new Error('CONFIG_STORE_STOPPED'))
    const input = structuredClone(patch)
    const operation = this.#writeQueue.then(async () => {
      assertCurrent()
      const file = await this.#readFile()
      const current = decodeConfig(file)
      const next = mergeConfig(current, input)
      const groups = (Object.keys(next) as (keyof LexoraConfig)[]).filter(group => JSON.stringify(current[group]) !== JSON.stringify(next[group]))
      const operationId = randomUUID()
      const publish = (kind: Exclude<LexoraConfigChange['kind'], 'committed'>) => this.#changes.fire(copyEventSnapshot({ kind, revision: ++this.#revision, operationId, groups }))
      this.#persisted = structuredClone(current)
      let committed = false
      let applying = true
      try {
        if (apply) {
          await apply(structuredClone(next))
          this.#applied = structuredClone(next)
          publish('applied')
        }
        applying = false
        await this.#write(mergeConfigFile(file, next), () => {
          committed = true
          this.#persisted = structuredClone(next)
          this.#changes.fire(copyEventSnapshot({ kind: 'committed', revision: ++this.#revision, operationId, groups, config: next }))
        }, assertCurrent)
      }
      catch (error) {
        if (committed) {
          publish('cleanup-failed')
          throw error
        }
        this.#applied = applying ? null : this.#applied
        publish(applying ? 'apply-failed' : 'commit-failed')
        if (apply) {
          try {
            await apply(structuredClone(current))
            this.#applied = structuredClone(current)
            publish('rolled-back')
          }
          catch (rollbackError) {
            this.#applied = null
            publish('rollback-failed')
            throw new AggregateError([error, rollbackError], 'CONFIG_ROLLBACK_FAILED')
          }
        }
        throw error
      }
      return next
    })

    this.#writeQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#writeQueue.then(() => this.#changes.dispose())
    return this.#disposing
  }

  async #readFile(): Promise<unknown> {
    let content: string

    try {
      content = await readFile(this.#configPath, 'utf8')
    }
    catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT')
        return {}

      throw error
    }

    try {
      return content.trim() ? parse(content) : {}
    }
    catch (error) {
      throw createConfigError(error)
    }
  }

  async #write(config: Record<string, unknown>, committed: () => void, assertCurrent: () => void): Promise<void> {
    const parent = dirname(this.#configPath)
    const temporaryPath = `${this.#configPath}.${process.pid}.${randomUUID()}.tmp`
    const content = stringify(config)

    await mkdir(parent, { mode: 0o700, recursive: true })

    try {
      const handle = await open(temporaryPath, 'wx', 0o600)
      try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
      }
      finally {
        await handle.close()
      }

      await chmod(temporaryPath, 0o600)
      assertCurrent()
      await rename(temporaryPath, this.#configPath)
      committed()
    }
    finally {
      await rm(temporaryPath, { force: true })
    }
  }
}

function decodeConfig(value: unknown): LexoraConfig {
  let config: z.infer<typeof lexoraConfigFileSchema>

  try {
    config = lexoraConfigFileSchema.parse(value)
  }
  catch (error) {
    throw createConfigError(error)
  }

  return {
    runtime: { cacheWarming: config.runtime.cache_warming, codemode: config.runtime.codemode, modelRetryLimit: config.runtime.model_retry_limit },
    browser: {
      screenshotDestination: config.browser.screenshot_destination,
      defaultZoomFactor: config.browser.default_zoom_factor,
      freezeBackground: config.browser.freeze_background,
      freezeForeground: config.browser.freeze_foreground,
      freezeDelaySeconds: config.browser.freeze_delay_seconds,
    },
    proxy: config.proxy,
    desktop: {
      backgroundCloseNoticeShown: config.desktop.background_close_notice_shown,
      pluginAuthor: config.desktop.plugin_author,
      chat: {
        outlinePosition: config.desktop.chat.outline_position,
        pasteTextAsAttachment: config.desktop.chat.paste_text_as_attachment,
        permissionMode: config.desktop.chat.permission_mode,
        welcome: normalizeDesktopChatWelcomePreference(config.desktop.chat.welcome, config.desktop.chat.welcome_items),
        welcomeItems: config.desktop.chat.welcome_items,
        welcomeEnabled: config.desktop.chat.welcome_enabled ?? config.desktop.chat.welcome !== 'none',
        welcomeGreetingEnabled: config.desktop.chat.welcome_greeting_enabled,
        welcomeCompanionEnabled: config.desktop.chat.welcome_companion_enabled,
      },
      contextPanelMode: config.desktop.context_panel_mode,
      contextPanelGlobal: config.desktop.context_panel_global,
      contextPanelAutoCollapse: config.desktop.context_panel_auto_collapse,
      keybindings: config.desktop.keybindings,
      taskSidebarPinnedItems: config.desktop.task_sidebar_pinned_items,
      taskSidebar: {
        collapsed: config.desktop.task_sidebar.collapsed,
        collapsedSections: config.desktop.task_sidebar.collapsed_sections,
        collapsedSpaces: config.desktop.task_sidebar.collapsed_spaces,
        width: config.desktop.task_sidebar.width ?? null,
      },
      profile: {
        userName: config.desktop.profile.user_name,
        deviceName: config.desktop.profile.device_name,
        avatar: config.desktop.profile.avatar,
      },
      developerToolsEnabled: config.desktop.developer_tools_enabled,
      language: config.desktop.language,
      launchAtLogin: config.desktop.launch_at_login,
      notificationsEnabled: config.desktop.notifications_enabled,
      subtaskNotificationsEnabled: config.desktop.subtask_notifications_enabled,
      updateNotificationsEnabled: config.desktop.update_notifications_enabled,
      autoDownloadUpdates: config.desktop.auto_download_updates,
      localBackupLimit: config.desktop.local_backup_limit,
      notifyWhenFocused: config.desktop.notify_when_focused,
      sidebarCollapsed: config.desktop.sidebar_collapsed,
      fileIconTheme: config.desktop.file_icon_theme,
      theme: migrateThemePreference(config.desktop.theme, config.desktop.accent_color),
      typography: {
        uiFont: config.desktop.typography.ui_font,
        bodyFont: config.desktop.typography.body_font,
        codeFont: config.desktop.typography.code_font,
        bodySize: config.desktop.typography.body_size,
      },
    },
    pet: {
      alwaysOnTop: config.pet.always_on_top,
      enabled: config.pet.enabled,
      rememberPosition: config.pet.remember_position,
    },
  }
}

function encodeConfig(config: LexoraConfig) {
  return {
    runtime: { cache_warming: config.runtime.cacheWarming, codemode: config.runtime.codemode, model_retry_limit: config.runtime.modelRetryLimit },
    browser: {
      screenshot_destination: config.browser.screenshotDestination,
      default_zoom_factor: config.browser.defaultZoomFactor,
      freeze_background: config.browser.freezeBackground,
      freeze_foreground: config.browser.freezeForeground,
      freeze_delay_seconds: config.browser.freezeDelaySeconds,
    },
    proxy: config.proxy,
    desktop: {
      background_close_notice_shown: config.desktop.backgroundCloseNoticeShown,
      plugin_author: config.desktop.pluginAuthor,
      chat: {
        outline_position: config.desktop.chat.outlinePosition,
        paste_text_as_attachment: config.desktop.chat.pasteTextAsAttachment,
        permission_mode: config.desktop.chat.permissionMode,
        welcome: config.desktop.chat.welcome,
        welcome_items: config.desktop.chat.welcomeItems,
        welcome_enabled: config.desktop.chat.welcomeEnabled,
        welcome_greeting_enabled: config.desktop.chat.welcomeGreetingEnabled,
        welcome_companion_enabled: config.desktop.chat.welcomeCompanionEnabled,
      },
      context_panel_mode: config.desktop.contextPanelMode,
      context_panel_global: config.desktop.contextPanelGlobal,
      context_panel_auto_collapse: config.desktop.contextPanelAutoCollapse,
      keybindings: config.desktop.keybindings,
      task_sidebar_pinned_items: config.desktop.taskSidebarPinnedItems,
      task_sidebar: {
        collapsed: config.desktop.taskSidebar.collapsed,
        collapsed_sections: config.desktop.taskSidebar.collapsedSections,
        collapsed_spaces: config.desktop.taskSidebar.collapsedSpaces,
        ...(config.desktop.taskSidebar.width === null ? {} : { width: config.desktop.taskSidebar.width }),
      },
      profile: {
        user_name: config.desktop.profile.userName,
        device_name: config.desktop.profile.deviceName,
        avatar: config.desktop.profile.avatar,
      },
      developer_tools_enabled: config.desktop.developerToolsEnabled,
      language: config.desktop.language,
      launch_at_login: config.desktop.launchAtLogin,
      notifications_enabled: config.desktop.notificationsEnabled,
      subtask_notifications_enabled: config.desktop.subtaskNotificationsEnabled,
      update_notifications_enabled: config.desktop.updateNotificationsEnabled,
      auto_download_updates: config.desktop.autoDownloadUpdates,
      local_backup_limit: config.desktop.localBackupLimit,
      notify_when_focused: config.desktop.notifyWhenFocused,
      sidebar_collapsed: config.desktop.sidebarCollapsed,
      file_icon_theme: config.desktop.fileIconTheme,
      theme: config.desktop.theme,
      typography: {
        ui_font: config.desktop.typography.uiFont,
        body_font: config.desktop.typography.bodyFont,
        code_font: config.desktop.typography.codeFont,
        body_size: config.desktop.typography.bodySize,
      },
    },
    pet: {
      always_on_top: config.pet.alwaysOnTop,
      enabled: config.pet.enabled,
      remember_position: config.pet.rememberPosition,
    },
  }
}

function mergeConfig(current: LexoraConfig, patch: LexoraConfigPatch): LexoraConfig {
  const welcomeItems = desktopChatWelcomeItemsSchema.parse(patch.desktop?.chat?.welcomeItems ?? current.desktop.chat.welcomeItems)
  return {
    runtime: runtimePreferencesSchema.parse({ ...current.runtime, ...patch.runtime }),
    browser: browserPreferencesSchema.parse({ ...current.browser, ...patch.browser }),
    proxy: proxySettingsSchema.parse(patch.proxy ?? current.proxy),
    desktop: {
      ...current.desktop,
      ...patch.desktop,
      localBackupLimit: localBackupLimitSchema.parse(patch.desktop?.localBackupLimit ?? current.desktop.localBackupLimit),
      fileIconTheme: fileIconPreferenceSchema.parse(patch.desktop?.fileIconTheme ?? current.desktop.fileIconTheme),
      theme: themePreferenceSchema.parse(patch.desktop?.theme ?? current.desktop.theme),
      typography: typographyPreferencesSchema.parse({ ...current.desktop.typography, ...patch.desktop?.typography }),
      pluginAuthor: extensionAuthorSchema.parse(patch.desktop?.pluginAuthor ?? current.desktop.pluginAuthor),
      chat: {
        ...current.desktop.chat,
        ...patch.desktop?.chat,
        welcomeItems,
        welcome: normalizeDesktopChatWelcomePreference(patch.desktop?.chat?.welcome ?? current.desktop.chat.welcome, welcomeItems),
        permissionMode: z.enum(BUDDY_PERMISSION_MODES).parse(
          patch.desktop?.chat?.permissionMode ?? current.desktop.chat.permissionMode,
        ),
      },
      keybindings: keybindingsSchema.parse(patch.desktop?.keybindings ?? current.desktop.keybindings),
      taskSidebar: {
        ...current.desktop.taskSidebar,
        ...patch.desktop?.taskSidebar,
      },
      profile: {
        ...current.desktop.profile,
        ...patch.desktop?.profile,
      },
    },
    pet: {
      ...current.pet,
      ...patch.pet,
    },
  }
}

function mergeConfigFile(file: unknown, config: LexoraConfig): Record<string, unknown> {
  const root = asRecord(file)
  const desktop = asRecord(root.desktop)
  const pet = asRecord(root.pet)
  const encoded = encodeConfig(config)
  const nextDesktop: Record<string, unknown> = {
    ...desktop,
    ...encoded.desktop,
    typography: { ...asRecord(desktop.typography), ...encoded.desktop.typography },
    chat: {
      ...asRecord(desktop.chat),
      ...asRecord(encoded.desktop.chat),
    },
    task_sidebar: {
      ...asRecord(desktop.task_sidebar),
      ...asRecord(encoded.desktop.task_sidebar),
    },
    profile: {
      ...asRecord(desktop.profile),
      ...asRecord(encoded.desktop.profile),
    },
  }
  delete nextDesktop.accent_color
  delete nextDesktop.chat_sidebar_section_order
  delete nextDesktop.chat_sidebar_pinned_items
  const next: Record<string, unknown> = {
    ...root,
    runtime: { ...asRecord(root.runtime), ...encoded.runtime },
    browser: { ...asRecord(root.browser), ...encoded.browser },
    proxy: encoded.proxy,
    desktop: nextDesktop,
    pet: {
      ...pet,
      ...encoded.pet,
    },
  }
  delete next.agent
  return next
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function createConfigError(error: unknown): LexoraConfigError {
  const message = isZodError(error)
    ? error.issues.map(issue => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ')
    : error instanceof Error ? error.message : 'Invalid Lexora configuration'

  return new LexoraConfigError(message, { cause: error })
}

function isZodError(error: unknown): error is ZodError {
  return error instanceof z.ZodError
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
