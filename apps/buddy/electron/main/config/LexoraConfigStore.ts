import type { ZodError } from 'zod'
import type { LexoraConfig, LexoraConfigPatch } from '../../shared/desktopApi'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import { parse, stringify } from 'smol-toml'
import { z } from 'zod'
import { browserPreferencesSchema, DEFAULT_BROWSER_PREFERENCES } from '../../../shared/browser/browserPreferences'
import { DEFAULT_PROXY_SETTINGS, proxySettingsSchema } from '../../../shared/network/proxySettings'
import { DEFAULT_RUNTIME_PREFERENCES, runtimePreferencesSchema } from '../../../shared/runtime/runtimePreferences'
import { keybindingsSchema } from '../../../shared/shortcuts/keybindingSchema'
import { DEFAULT_DESKTOP_CHAT_PREFERENCES, DESKTOP_CHAT_OUTLINE_POSITIONS, DESKTOP_CHAT_WELCOME_VARIANT_IDS, DESKTOP_PROFILE_AVATAR_MAX_DATA_URL_LENGTH, DESKTOP_TASK_SIDEBAR_SECTIONS } from '../../shared/desktopApi'

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
  background_close_notice_shown: z.boolean().default(false),
  chat: z.object({
    outline_position: z.enum(DESKTOP_CHAT_OUTLINE_POSITIONS).default(DEFAULT_DESKTOP_CHAT_PREFERENCES.outlinePosition),
    welcome: z.enum(['none', 'random', ...DESKTOP_CHAT_WELCOME_VARIANT_IDS]).default(DEFAULT_DESKTOP_CHAT_PREFERENCES.welcome),
  }).passthrough().prefault({}),
  context_panel_mode: z.enum(['task', 'independent']).default('task'),
  context_panel_global: z.boolean().default(false),
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
  notify_when_focused: z.boolean().default(false),
  sidebar_collapsed: z.boolean().default(false),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
}).passthrough().default({
  background_close_notice_shown: false,
  chat: {
    outline_position: DEFAULT_DESKTOP_CHAT_PREFERENCES.outlinePosition,
    welcome: DEFAULT_DESKTOP_CHAT_PREFERENCES.welcome,
  },
  context_panel_mode: 'task',
  context_panel_global: false,
  keybindings: {},
  task_sidebar_pinned_items: [],
  task_sidebar: { collapsed: false, collapsed_sections: [], collapsed_spaces: [] },
  profile: { user_name: '', device_name: '', avatar: '' },
  developer_tools_enabled: false,
  language: 'zh-CN',
  launch_at_login: false,
  notifications_enabled: true,
  notify_when_focused: false,
  sidebar_collapsed: false,
  theme: 'system',
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

export class LexoraConfigStore {
  readonly #configPath: string
  #writeQueue: Promise<void> = Promise.resolve()

  constructor(options: { configPath: string }) {
    this.#configPath = options.configPath
  }

  async read(): Promise<LexoraConfig> {
    return decodeConfig(await this.#readFile())
  }

  update(patch: LexoraConfigPatch, apply?: (config: LexoraConfig) => Promise<void> | void): Promise<LexoraConfig> {
    const operation = this.#writeQueue.then(async () => {
      const file = await this.#readFile()
      const current = decodeConfig(file)
      const next = mergeConfig(current, patch)
      try {
        await apply?.(next)
        await this.#write(mergeConfigFile(file, next))
      }
      catch (error) {
        await apply?.(current)
        throw error
      }
      return next
    })

    this.#writeQueue = operation.then(() => undefined, () => undefined)
    return operation
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

  async #write(config: Record<string, unknown>): Promise<void> {
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

      await rename(temporaryPath, this.#configPath)
      await chmod(this.#configPath, 0o600)
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
    runtime: { cacheWarming: config.runtime.cache_warming },
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
      chat: {
        outlinePosition: config.desktop.chat.outline_position,
        welcome: config.desktop.chat.welcome,
      },
      contextPanelMode: config.desktop.context_panel_mode,
      contextPanelGlobal: config.desktop.context_panel_global,
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
      notifyWhenFocused: config.desktop.notify_when_focused,
      sidebarCollapsed: config.desktop.sidebar_collapsed,
      theme: config.desktop.theme,
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
    runtime: { cache_warming: config.runtime.cacheWarming },
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
      chat: {
        outline_position: config.desktop.chat.outlinePosition,
        welcome: config.desktop.chat.welcome,
      },
      context_panel_mode: config.desktop.contextPanelMode,
      context_panel_global: config.desktop.contextPanelGlobal,
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
      notify_when_focused: config.desktop.notifyWhenFocused,
      sidebar_collapsed: config.desktop.sidebarCollapsed,
      theme: config.desktop.theme,
    },
    pet: {
      always_on_top: config.pet.alwaysOnTop,
      enabled: config.pet.enabled,
      remember_position: config.pet.rememberPosition,
    },
  }
}

function mergeConfig(current: LexoraConfig, patch: LexoraConfigPatch): LexoraConfig {
  return {
    runtime: runtimePreferencesSchema.parse({ ...current.runtime, ...patch.runtime }),
    browser: browserPreferencesSchema.parse({ ...current.browser, ...patch.browser }),
    proxy: proxySettingsSchema.parse(patch.proxy ?? current.proxy),
    desktop: {
      ...current.desktop,
      ...patch.desktop,
      chat: {
        ...current.desktop.chat,
        ...patch.desktop?.chat,
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
