<script setup lang="ts">
import type { DesktopShellBindings } from '../shell/desktopShellBindings'
import type { DesktopBrowserGuestSurfaceHost } from '@/platform/browser/browserGuestSurface'
import { useMessage } from 'naive-ui'
import { computed, onScopeDispose, provide, toRef, useTemplateRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { resolveBuddyLocale, translateBuddy } from '@/i18n/buddyI18n'
import { useProvideAutomationContext } from '@/modules/automations'
import { useProvideSettingsContext } from '@/modules/settings'
import { useProvideSkillsContext } from '@/modules/skills'
import { useProvideTaskContext, useTaskCapability, useTaskResourcePanel } from '@/modules/tasks'
import DesktopBrowserGuestHost from '@/platform/browser/DesktopBrowserGuestHost.vue'
import { useBrowserGuestHost } from '@/platform/browser/useBrowserGuestHost'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { runtimeAvailabilityKey } from '@/platform/runtime/runtimeAvailability'
import { useProvideDesktopUi } from '@/shared/ui/desktopUiContext'
import { useDesktopShellState } from '../shell/useDesktopShellState'
import { createDesktopCapabilities } from './desktopCapabilities'
import { useDesktopAppState } from './useDesktopAppState'
import { useDesktopLifecycle } from './useDesktopLifecycle'
import { useDesktopNavigation } from './useDesktopNavigation'

const props = defineProps<{ isDark: boolean }>()
const emit = defineEmits<{
  languageChange: [language: 'zh-CN' | 'en-US']
  themeChange: [theme: 'system' | 'light' | 'dark']
}>()
defineSlots<{ default: (props: { shell: DesktopShellBindings }) => unknown }>()

const api = requireDesktopApi()
const router = useRouter()
const route = useRoute()
const message = useMessage()
const appState = useDesktopAppState({ api })
const { stores } = appState
const tasks = useTaskCapability({
  api,
  applicationSettings: stores.applicationSettings,
  modelProviders: stores.modelProviders,
  runtimeSupervisor: stores.runtimeSupervisor,
  onTaskDeleted,
  onDraftCommitted,
})
const resources = useTaskResourcePanel({
  activeConversationId: tasks.workspace.session.activeConversationId,
  activeDraftId: tasks.workspace.composer.draftId,
  activeBranchId: tasks.workspace.session.activeBranchId,
  activeRunId: computed(() => tasks.workspace.execution.activeRun.value?.id
    ?? tasks.workspace.transcript.runs.value.findLast(run => run.branchId === tasks.workspace.session.activeBranchId.value
      && run.purpose !== 'conversation.compaction')?.id ?? null),
  activeSpace: tasks.session.activeSpace,
  spaces: tasks.index.spaces,
  mode: computed(() => stores.applicationSettings.config.value?.desktop.contextPanelMode ?? 'task'),
  taskVisible: computed(() => route.meta.desktopView === 'tasks'),
  control: api.contextPanel,
  browser: api.browser,
  changeSets: tasks.workspace.transcript.changeSets,
  runOutputs: tasks.workspace.transcript.runOutputs,
  onError: () => message.error(translateBuddy(stores.applicationSettings.language.value, 'desktop.context.controlFailed')),
})
const capabilities = createDesktopCapabilities({ api, stores, tasks, onAutomationRunFailure: error => message.error(error) })
function onTaskDeleted(id: string) {
  resources.discardConversation(id)
}
function onDraftCommitted(draftId: string, conversationId: string) {
  resources.adoptDraft(draftId, conversationId)
}
watch(tasks.workspace.status.errorMessage, (error) => {
  if (!error)
    return
  message.error(error)
  tasks.workspace.status.dismissError()
})
watch(stores.modelProviders.modelProviderError, (error) => {
  if (!error)
    return
  message.error(error)
  stores.modelProviders.clearModelProviderError()
})
const shell = useDesktopShellState(stores.applicationSettings, api)
const lifecycle = useDesktopLifecycle({
  api,
  appState,
  automations: capabilities.automations,
  shell,
  tasks,
  prepareSurface: () => router.isReady(),
})
const { ready } = lifecycle
provide(runtimeAvailabilityKey, { loading: lifecycle.loading, failed: lifecycle.failed, language: stores.applicationSettings.language, retry: lifecycle.retry })
const navigation = useDesktopNavigation({
  router,
  ready,
  session: tasks.session,
  notifications: stores.notifications,
  getRun: api.localChat.runs.get,
  onError: () => message.error(translateBuddy(stores.applicationSettings.language.value, 'desktop.command.failed')),
})
const { notificationTargetMessageId } = navigation
onScopeDispose(api.app.onOpenTarget(navigation.openTarget))
const browserGuestHost = useTemplateRef<DesktopBrowserGuestSurfaceHost>('browserGuestHost')
const browserGuests = useBrowserGuestHost(browserGuestHost)
const toggleAppSidebar = () => void shell.setAppSidebarCollapsed(!shell.appSidebarCollapsed.value)

const shellBindings: DesktopShellBindings = {
  contextPanelGlobal: computed(() => stores.applicationSettings.config.value?.desktop.contextPanelGlobal ?? false),
  resources,
  resourceContext: tasks.workspace.context,
  lifecycle,
  appInfo: shell.appInfo,
  navigation,
  notifications: stores.notifications,
  taskIndex: tasks.index,
  toggleAppSidebar,
}
useProvideDesktopUi({
  isDark: toRef(() => props.isDark),
  language: stores.applicationSettings.language,
  appSidebarCollapsed: shell.appSidebarCollapsed,
})
useProvideTaskContext({
  resources,
  browser: api.browser,
  browserGuests,
  clipboard: api.clipboard,
  notificationTargetMessageId,
  tasks,
})
useProvideSettingsContext({
  applicationSettings: stores.applicationSettings,
  appInfo: shell.appInfo,
  dataSettings: capabilities.dataSettings,
  platformCapabilities: shell.platformCapabilities,
  providerSettings: stores.modelProviders,
  ready,
  webSettings: capabilities.webSettings,
  mcpSettings: capabilities.mcpSettings,
  openTask: navigation.openTask,
})
useProvideSkillsContext({
  writeClipboardText: text => api.clipboard.writeText(text),
  api: api.localChat.skills,
  spaces: tasks.index.spaces,
  ready,
})
useProvideAutomationContext({
  automations: capabilities.automations,
  openTask: async (id) => { await tasks.session.openTask(id) },
  providerSettings: stores.modelProviders,
  ready,
  refreshTasks: async () => { await tasks.index.refresh() },
  spaces: tasks.index.spaces,
})

watch(() => stores.applicationSettings.config.value?.desktop.language, (language) => {
  if (language)
    emit('languageChange', resolveBuddyLocale(language))
}, { immediate: true })
watch(() => stores.applicationSettings.config.value?.desktop.theme, (theme) => {
  if (theme)
    emit('themeChange', theme)
}, { immediate: true })
</script>

<template>
  <DesktopBrowserGuestHost ref="browserGuestHost" :api="api.browser" />
  <slot :shell="shellBindings" />
</template>
