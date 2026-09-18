import type { LexoraConfigPatch } from './desktopApi'
import { z } from 'zod'
import { browserPreferencesSchema } from '../../shared/browser/browserPreferences'
import { proxySettingsSchema } from '../../shared/network/proxySettings'
import { keybindingsSchema } from '../../shared/shortcuts/keybindingSchema'
import {
  DESKTOP_CHAT_OUTLINE_POSITIONS,
  DESKTOP_CHAT_WELCOME_VARIANT_IDS,
  DESKTOP_TASK_SIDEBAR_SECTIONS,
} from './desktopApi'
import { isLexoraReleaseUrl } from './productLinks'

const taskSidebarPinnedItemSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().min(1).max(128), kind: z.literal('conversation') }).strict(),
  z.object({ id: z.string().min(1).max(128), kind: z.literal('space') }).strict(),
])

const taskSidebarPinnedItemsSchema = z.array(taskSidebarPinnedItemSchema)
  .max(500)
  .refine(items => new Set(items.map(item => `${item.kind}:${item.id}`)).size === items.length)

const taskSidebarCollapsedSectionsSchema = z.array(z.enum(DESKTOP_TASK_SIDEBAR_SECTIONS))
  .max(DESKTOP_TASK_SIDEBAR_SECTIONS.length)
  .refine(sections => new Set(sections).size === sections.length)

const taskSidebarCollapsedSpacesSchema = z.array(z.string().min(1).max(128))
  .max(500)
  .refine(ids => new Set(ids).size === ids.length)

const taskSidebarWidthSchema = z.number().int().min(0).max(10_000).nullable()

const taskSidebarPreferencesSchema = z.object({
  collapsed: z.boolean().optional(),
  collapsedSections: taskSidebarCollapsedSectionsSchema.optional(),
  collapsedSpaces: taskSidebarCollapsedSpacesSchema.optional(),
  width: taskSidebarWidthSchema.optional(),
}).strict()

export const feedbackIssueInputSchema = z.object({
  feedback: z.string().max(4_000),
}).strict()

export const clipboardWriteTextInputSchema = z.object({
  text: z.string(),
}).strict()

export const releasePageInputSchema = z.object({
  url: z.url().refine(isLexoraReleaseUrl),
}).strict()

export const lexoraConfigPatchSchema: z.ZodType<LexoraConfigPatch> = z.object({
  browser: browserPreferencesSchema.partial().optional(),
  proxy: proxySettingsSchema.optional(),
  desktop: z.object({
    backgroundCloseNoticeShown: z.boolean().optional(),
    chat: z.object({
      outlinePosition: z.enum(DESKTOP_CHAT_OUTLINE_POSITIONS).optional(),
      welcome: z.enum(['none', 'random', ...DESKTOP_CHAT_WELCOME_VARIANT_IDS]).optional(),
    }).strict().optional(),
    contextPanelMode: z.enum(['task', 'independent']).optional(),
    contextPanelGlobal: z.boolean().optional(),
    keybindings: keybindingsSchema.optional(),
    taskSidebarPinnedItems: taskSidebarPinnedItemsSchema.optional(),
    taskSidebar: taskSidebarPreferencesSchema.optional(),
    developerToolsEnabled: z.boolean().optional(),
    language: z.enum(['zh-CN', 'en-US']).optional(),
    launchAtLogin: z.boolean().optional(),
    notificationsEnabled: z.boolean().optional(),
    notifyWhenFocused: z.boolean().optional(),
    sidebarCollapsed: z.boolean().optional(),
    theme: z.enum(['system', 'light', 'dark']).optional(),
  }).strict().optional(),
  pet: z.object({
    alwaysOnTop: z.boolean().optional(),
    enabled: z.boolean().optional(),
    rememberPosition: z.boolean().optional(),
  }).strict().optional(),
}).strict()

export { browserAttachGuestInputSchema, browserEnsureSessionInputSchema, browserNavigateInputSchema, browserOpenArtifactInputSchema, browserSessionInputSchema, browserSetProfileModeInputSchema, browserSetSurfaceInputSchema, browserSetZoomFactorInputSchema, desktopBrowserGuestDescriptorSchema, desktopBrowserGuestDescriptorsSchema, desktopBrowserStateSchema } from '../../shared/browser/browserDesktopSchemas'
