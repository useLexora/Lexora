import type { LexoraConfigPatch } from './desktopApi'
import { z } from 'zod'
import { browserPreferencesSchema } from '../../shared/browser/browserPreferences'
import { DESKTOP_NAVIGATION_LAYOUTS } from '../../shared/desktopNavigationLayout'
import { extensionAuthorSchema } from '../../shared/extensions/extensionIdentity'
import { fileIconPreferenceSchema } from '../../shared/icons/fileIconTheme'
import { proxySettingsSchema } from '../../shared/network/proxySettings'
import { featureDiscoverySchema } from '../../shared/onboarding/featureDiscovery'
import { BUDDY_PERMISSION_MODES } from '../../shared/permissions/permissionMode'
import { runtimePreferencesSchema } from '../../shared/runtime/runtimePreferences'
import { keybindingsSchema } from '../../shared/shortcuts/keybindingSchema'
import { localBackupLimitSchema } from '../../shared/storage/backupRetention'
import { themePreferenceSchema } from '../../shared/theme/themePreferences'
import { typographyPreferencesSchema } from '../../shared/typography/typographyPreferences'
import {
  DESKTOP_CHAT_OUTLINE_POSITIONS,
  DESKTOP_PROFILE_AVATAR_MAX_DATA_URL_LENGTH,
  DESKTOP_TASK_SIDEBAR_SECTIONS,
} from './desktopApi'
import { DESKTOP_CHAT_WELCOME_MAX_ITEMS, DESKTOP_CHAT_WELCOME_MAX_LENGTH, DESKTOP_CHAT_WELCOME_VARIANT_IDS } from './desktopChatWelcome'
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

const desktopUserProfilePatchSchema = z.object({
  userName: z.string().max(30).optional(),
  deviceName: z.string().max(30).optional(),
  avatar: z.string().max(DESKTOP_PROFILE_AVATAR_MAX_DATA_URL_LENGTH).optional(),
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

export const desktopChatWelcomeItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preset'), id: z.enum(DESKTOP_CHAT_WELCOME_VARIANT_IDS) }).strict(),
  z.object({
    kind: z.literal('custom'),
    id: z.string().trim().min(1).max(64).refine(id => !['none', 'random', 'orchestrating', ...DESKTOP_CHAT_WELCOME_VARIANT_IDS].includes(id)),
    text: z.string().trim().min(1).max(DESKTOP_CHAT_WELCOME_MAX_LENGTH),
  }).strict(),
])
export const desktopChatWelcomeItemsSchema = z.array(desktopChatWelcomeItemSchema)
  .max(DESKTOP_CHAT_WELCOME_MAX_ITEMS)
  .refine(items => new Set(items.map(item => item.id)).size === items.length)

export const lexoraConfigPatchSchema: z.ZodType<LexoraConfigPatch> = z.object({
  runtime: runtimePreferencesSchema.partial().optional(),
  browser: browserPreferencesSchema.partial().optional(),
  proxy: proxySettingsSchema.optional(),
  desktop: z.object({
    featureDiscovery: featureDiscoverySchema.optional(),
    featureAnnouncementsEnabled: z.boolean().optional(),
    onboardingCompleted: z.boolean().optional(),
    backgroundCloseNoticeShown: z.boolean().optional(),
    chat: z.object({
      outlinePosition: z.enum(DESKTOP_CHAT_OUTLINE_POSITIONS).optional(),
      pasteTextAsAttachment: z.boolean().optional(),
      permissionMode: z.enum(BUDDY_PERMISSION_MODES).optional(),
      welcome: z.string().trim().min(1).max(64).optional(),
      welcomeItems: desktopChatWelcomeItemsSchema.optional(),
      welcomeEnabled: z.boolean().optional(),
      welcomeGreetingEnabled: z.boolean().optional(),
      welcomeCompanionEnabled: z.boolean().optional(),
    }).strict().optional(),
    contextPanelMode: z.enum(['task', 'space', 'independent']).optional(),
    contextPanelGlobal: z.boolean().optional(),
    contextPanelAutoCollapse: z.boolean().optional(),
    keybindings: keybindingsSchema.optional(),
    taskSidebarPinnedItems: taskSidebarPinnedItemsSchema.optional(),
    taskSidebar: taskSidebarPreferencesSchema.optional(),
    profile: desktopUserProfilePatchSchema.optional(),
    developerToolsEnabled: z.boolean().optional(),
    pluginAuthor: extensionAuthorSchema.optional(),
    language: z.enum(['zh-CN', 'en-US']).optional(),
    launchAtLogin: z.boolean().optional(),
    notificationsEnabled: z.boolean().optional(),
    subtaskNotificationsEnabled: z.boolean().optional(),
    updateNotificationsEnabled: z.boolean().optional(),
    autoDownloadUpdates: z.boolean().optional(),
    localBackupLimit: localBackupLimitSchema.optional(),
    notifyWhenFocused: z.boolean().optional(),
    sidebarCollapsed: z.boolean().optional(),
    navigationLayout: z.enum(DESKTOP_NAVIGATION_LAYOUTS).optional(),
    fileIconTheme: fileIconPreferenceSchema.optional(),
    theme: themePreferenceSchema.optional(),
    typography: typographyPreferencesSchema.partial().optional(),
  }).strict().optional(),
  pet: z.object({
    alwaysOnTop: z.boolean().optional(),
    enabled: z.boolean().optional(),
    rememberPosition: z.boolean().optional(),
  }).strict().optional(),
}).strict()

export { browserAttachGuestInputSchema, browserEnsureSessionInputSchema, browserNavigateInputSchema, browserOpenArtifactInputSchema, browserSessionInputSchema, browserSetProfileModeInputSchema, browserSetSurfaceInputSchema, browserSetZoomFactorInputSchema, desktopBrowserGuestDescriptorSchema, desktopBrowserGuestDescriptorsSchema, desktopBrowserStateSchema } from '../../shared/browser/browserDesktopSchemas'
