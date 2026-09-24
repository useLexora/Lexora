<script setup lang="ts">
import type { DesktopShellBindings } from '../shell/desktopShellBindings'
import type { DesktopBrowserGuestSurfaceHost } from '@/platform/browser/browserGuestSurface'
import { DEFAULT_DESKTOP_CHAT_PREFERENCES } from '@buddy-electron/shared/desktopApi'
import { useMessage } from 'naive-ui'
import { computed, nextTick, onScopeDispose, provide, toRef, useTemplateRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { resolveBuddyLocale, translateBuddy } from '@/i18n/buddyI18n'
import { useProvideAutomationContext } from '@/modules/automations'
import { useExtensionState, useExtensionViews, useProvideExtensionContext } from '@/modules/extensions'
import { DesktopExtensionFrameHost, DesktopExtensionOverlays, DesktopExtensionReviewHost } from '@/modules/extensions/ui'
import { useProvideSettingsContext } from '@/modules/settings'
import { useProvideSkillsContext } from '@/modules/skills'
import { useProvideTaskEnvironment, useTaskIndex, useTaskResourcePanel } from '@/modules/tasks'
import DesktopBrowserGuestHost from '@/platform/browser/DesktopBrowserGuestHost.vue'
import { useBrowserGuestHost } from '@/platform/browser/useBrowserGuestHost'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { runtimeAvailabilityKey } from '@/platform/runtime/runtimeAvailability'
import { useProvideDesktopUi } from '@/shared/ui/desktopUiContext'
import { useDesktopShellState } from '../shell/useDesktopShellState'
import { desktopWorkbenchKey } from '../workbench/desktopWorkbenchContext'
import { useDesktopKeybindings } from '../workbench/useDesktopKeybindings'
import { useDesktopWorkbench } from '../workbench/useDesktopWorkbench'
import { useExtensionContributions } from '../workbench/useExtensionContributions'
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
const taskIndex = useTaskIndex({
  api: api.localChat,
  applicationSettings: stores.applicationSettings,
  ready: computed(() => stores.runtimeSupervisor.runtimeState.value.status === 'ready'),
  onTaskDeleted,
  beforeTaskDelete,
  onSpaceCreated,
})
const workbench = useDesktopWorkbench({ api, stores, taskIndex, router, resources: getResources, onError: () => message.error(translateBuddy(stores.applicationSettings.language.value, 'desktop.command.failed')) })
provide(desktopWorkbenchKey, workbench)
const extensions = useExtensionState(api.extensions)
const extensionViews = useExtensionViews(api.extensions, extensions.installed)
useProvideExtensionContext({ state: extensions, views: extensionViews, language: stores.applicationSettings.language, isDark: toRef(() => props.isDark), focusView: (id) => {
  workbench.controller.focus(id)
} })
useExtensionContributions(workbench.controller, workbench.persistence, extensions.installed, api.extensions, id => extensionViews.surfaces.get(id)?.session?.generation ?? null)
onScopeDispose(workbench.controller.subscribe(() => void nextTick(extensionViews.layout)))
const selectedTask = workbench.activeTask
const resources = useTaskResourcePanel({
  activeConversationId: computed(() => selectedTask.value?.workspace.session.activeConversationId.value ?? null),
  activeDraftId: computed(() => selectedTask.value?.workspace.composer.draftId.value ?? null),
  activeBranchId: computed(() => selectedTask.value?.workspace.session.activeBranchId.value ?? null),
  activeRunId: computed(() => selectedTask.value?.workspace.execution.activeRun.value?.id
    ?? selectedTask.value?.workspace.transcript.runs.value.findLast(run => run.branchId === selectedTask.value?.workspace.session.activeBranchId.value
      && run.purpose !== 'conversation.compaction')?.id ?? null),
  activeSpace: computed(() => selectedTask.value?.session.activeSpace.value ?? null),
  spaces: taskIndex.index.spaces,
  mode: computed(() => stores.applicationSettings.config.value?.desktop.contextPanelMode ?? 'task'),
  taskVisible: computed(() => route.meta.desktopView === 'tasks' || !!stores.applicationSettings.config.value?.desktop.contextPanelGlobal),
  control: api.contextPanel,
  browser: api.browser,
  closeView: id => workbench.controller.close(id),
  closeFiles: workbench.closeContextFiles,
  changeSets: computed(() => selectedTask.value?.workspace.transcript.changeSets.value ?? []),
  runOutputs: computed(() => selectedTask.value?.workspace.transcript.runOutputs.value ?? []),
  onError: () => message.error(translateBuddy(stores.applicationSettings.language.value, 'desktop.context.controlFailed')),
})
watch(() => resources.activeTab.value?.id, () => {
  if (workbench.controller.context.values['focus.area'] !== 'context')
    return
  const tab = resources.activeTab.value
  if (tab?.kind === 'view')
    workbench.controller.focus(tab.viewId)
  else
    workbench.controller.focusContext()
}, { flush: 'sync' })
watch(() => JSON.stringify(resources.snapshot()), (snapshot) => {
  if (workbench.initialized)
    workbench.controller.setAuxiliary('context', JSON.parse(snapshot))
})
function getResources() {
  return resources
}
const capabilities = createDesktopCapabilities({ api, stores, selectedModel: computed(() => selectedTask.value?.workspace.composer.selectedModel.value ?? null), onAutomationRunFailure: error => message.error(error) })
function onSpaceCreated(id: string) {
  return workbench.newTask(id)
}
function beforeTaskDelete(id: string) {
  return workbench.prepareTaskDeletion(id)
}
function onTaskDeleted(id: string) {
  workbench.discardTask(id)
}
watch(taskIndex.errorMessage, (error) => {
  if (error) {
    message.error(error)
    taskIndex.dismissError()
  }
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
  taskIndex,
  prepareSurface: async () => {
    await router.isReady()
    await extensions.refresh()
    await workbench.initialize()
  },
  flushSurface: workbench.flush,
  refreshSurface: workbench.pool.refresh.bind(workbench.pool),
})
const shortcuts = useDesktopKeybindings(workbench.controller.registry, stores.applicationSettings, () => shell.appInfo.value?.platform ?? 'linux')
const { ready } = lifecycle
provide(runtimeAvailabilityKey, { loading: lifecycle.loading, failed: lifecycle.failed, language: stores.applicationSettings.language, retry: lifecycle.retry })
const navigation = useDesktopNavigation({
  router,
  ready,
  session: {
    activeTaskId: computed(() => selectedTask.value?.session.activeTaskId.value ?? null),
    spaceId: computed(() => selectedTask.value?.session.spaceId.value ?? null),
    navigationVersion: () => workbench.navigationVersion,
    openTask: (id, signal) => workbench.openTask(id, signal),
    startTask: spaceId => workbench.newTask(spaceId),
  },
  notifications: stores.notifications,
  getRun: api.localChat.runs.get,
  activateRunBranch: async (run) => {
    const task = selectedTask.value
    if (task?.session.activeTaskId.value !== run.conversationId)
      return false
    return task.workspace.session.activeBranchId.value === run.branchId
      || await task.workspace.transcript.activateBranch(run.branchId)
  },
  onError: () => message.error(translateBuddy(stores.applicationSettings.language.value, 'desktop.command.failed')),
})
const { notificationTarget } = navigation
onScopeDispose(api.app.onOpenTarget(navigation.openTarget))
const browserGuestHost = useTemplateRef<DesktopBrowserGuestSurfaceHost>('browserGuestHost')
const browserGuests = useBrowserGuestHost(browserGuestHost)
onScopeDispose(workbench.controller.subscribe(() => void nextTick(() => browserGuests.layout?.())))
const toggleAppSidebar = () => void shell.setAppSidebarCollapsed(!shell.appSidebarCollapsed.value)

const shellBindings: DesktopShellBindings = {
  extensionNavigation: extensions.navigation,
  shortcuts,
  contextPanelGlobal: computed(() => stores.applicationSettings.config.value?.desktop.contextPanelGlobal ?? false),
  workbench,
  resources,
  resourceContext: {
    getChangeOverview: api.localChat.changes.overview,
    files: { listDirectory: api.localChat.spaces.listDirectory, readFile: api.localChat.spaces.readFile, revealFile: api.localChat.spaces.revealFile },
    getNodeDetail: api.localChat.conversations.getNodeDetail,
    getChangeSet: api.localChat.changes.get,
    readArtifactText: api.localChat.artifacts.readText,
  },
  lifecycle,
  appInfo: shell.appInfo,
  navigation,
  notifications: stores.notifications,
  profileConfig: computed(() => stores.applicationSettings.config.value?.desktop.profile ?? { avatar: '', deviceName: '', userName: '' }),
  taskIndex: taskIndex.index,
  toggleAppSidebar,
  updateProfile: async (patch) => {
    const saved = await stores.applicationSettings.updateSettings({ desktop: { profile: patch } })
    if (saved)
      message.success(translateBuddy(stores.applicationSettings.language.value, 'desktop.account.saveSuccess'))
    return saved
  },
}
useProvideDesktopUi({
  isDark: toRef(() => props.isDark),
  chat: computed(() => stores.applicationSettings.config.value?.desktop.chat ?? DEFAULT_DESKTOP_CHAT_PREFERENCES),
  language: stores.applicationSettings.language,
  appSidebarCollapsed: shell.appSidebarCollapsed,
})
useProvideTaskEnvironment({
  resources,
  browser: api.browser,
  browserGuests,
  clipboard: api.clipboard,
  notificationTarget,
})
useProvideSettingsContext({
  shortcuts,
  browser: api.browser,
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
  spaces: taskIndex.index.spaces,
  ready,
})
useProvideAutomationContext({
  onTaskDeleted,
  beforeTaskDelete,
  automations: capabilities.automations,
  openTask: navigation.openTask,
  providerSettings: stores.modelProviders,
  ready,
  refreshTasks: async () => {
    await taskIndex.index.refresh()
  },
  spaces: taskIndex.index.spaces,
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
  <DesktopExtensionFrameHost />
  <DesktopExtensionOverlays />
  <DesktopExtensionReviewHost />
  <slot :shell="shellBindings" />
</template>
