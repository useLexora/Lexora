<script setup lang="ts">
import type { DesktopShellBindings } from '../shell/desktopShellBindings'
import type { DesktopBrowserGuestSurfaceHost } from '@/platform/browser/browserGuestSurface'
import { DEFAULT_DESKTOP_CHAT_PREFERENCES } from '@buddy-electron/shared/desktopApi'
import { useMessage } from 'naive-ui'
import { computed, nextTick, onMounted, onScopeDispose, provide, ref, toRef, useTemplateRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { resolveBuddyLocale, translateBuddy } from '@/i18n/buddyI18n'
import { useProvideAutomationContext } from '@/modules/automations'
import { useExtensionState, useExtensionUiContributions, useExtensionViews, useProvideExtensionContext } from '@/modules/extensions'
import { DesktopExtensionControl, DesktopExtensionFrameHost, DesktopExtensionMenu, DesktopExtensionOverlays, DesktopExtensionReviewHost, DesktopExtensionSlot } from '@/modules/extensions/ui'
import { usePluginSettings, useProvideSettingsContext, useSettingsRegistry } from '@/modules/settings'
import { useProvideSkillsContext } from '@/modules/skills'
import { DesktopSkillReviewHost } from '@/modules/skills/ui'
import { sessionReferenceNavigationKey, useProvideTaskEnvironment, useTaskIndex, useTaskResourcePanel } from '@/modules/tasks'
import { useProvideDesktopUpdates } from '@/modules/updates'
import { DesktopUpdateHost } from '@/modules/updates/ui'
import DesktopBrowserGuestHost from '@/platform/browser/DesktopBrowserGuestHost.vue'
import { useBrowserGuestHost } from '@/platform/browser/useBrowserGuestHost'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { createRendererDiagnostics } from '@/platform/runtime/RendererDiagnostics'
import { runtimeAvailabilityKey } from '@/platform/runtime/runtimeAvailability'
import { useProvideWorkbenchCommands } from '@/shared/ui/contributions/workbenchCommands'
import { useProvideWorkbenchUi } from '@/shared/ui/contributions/workbenchUiContext'
import { useProvideDesktopUi } from '@/shared/ui/desktopUiContext'
import { SemanticAnchorRegistry } from '@/workbench/browser/surfaces/SemanticAnchorRegistry'
import { WorkbenchPaneRegistry } from '@/workbench/browser/surfaces/WorkbenchPaneRegistry'
import WorkbenchSurfaceHost from '@/workbench/browser/surfaces/WorkbenchSurfaceHost.vue'
import { commandLabel } from '@/workbench/common/workbench'
import { useDesktopPages } from '../router/useDesktopPages'
import { useDesktopShellState } from '../shell/useDesktopShellState'
import { desktopWorkbenchKey } from '../workbench/desktopWorkbenchContext'
import { useDesktopKeybindings } from '../workbench/useDesktopKeybindings'
import { useDesktopWorkbench } from '../workbench/useDesktopWorkbench'
import { useExtensionContributions } from '../workbench/useExtensionContributions'
import { useTaskResourceSpaces } from '../workbench/useTaskResourceSpaces'
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
const message = useMessage()
const appState = useDesktopAppState({ api })
const { stores } = appState
useProvideDesktopUpdates(stores.updates)
const taskIndex = useTaskIndex({
  api: api.localChat,
  applicationSettings: stores.applicationSettings,
  ready: computed(() => stores.runtimeSupervisor.runtimeState.value.status === 'ready'),
  onTaskDeleted,
  beforeTaskDelete,
  onSpaceCreated,
})
const diagnostics = createRendererDiagnostics(api.app.logs)
const workbench = useDesktopWorkbench({ api, events: diagnostics.events, stores, taskIndex, router, resources: getResources, onError: () => message.error(translateBuddy(stores.applicationSettings.language.value, 'desktop.command.failed')) })
onScopeDispose(() => {
  void workbench.dispose().finally(() => diagnostics.dispose()).catch(() => {})
})
provide(desktopWorkbenchKey, workbench)
provide(sessionReferenceNavigationKey, id => workbench.openTask(id, { direction: 'right' }))
const extensions = useExtensionState(api.extensions)
const settingsRegistry = useSettingsRegistry(extensions.installed)
const pages = useDesktopPages(router, extensions.installed, stores.applicationSettings.language)
const paneRegistry = new WorkbenchPaneRegistry(() => workbench.controller.layout.activePane)
onMounted(() => paneRegistry.start())
onScopeDispose(() => paneRegistry.dispose())
onScopeDispose(workbench.controller.onDidChangeLayout(paneRegistry.invalidate).dispose)
onScopeDispose(paneRegistry.onDidChange((change) => {
  void api.extensions.updatePanes([...change.snapshot]).catch(() => {})
}).dispose)
const commandRevision = ref(0)
onScopeDispose(workbench.controller.registry.subscribe(() => commandRevision.value++))
onScopeDispose(workbench.controller.subscribe(() => commandRevision.value++))
useProvideWorkbenchCommands({
  reportFailure: () => message.error(translateBuddy(stores.applicationSettings.language.value, 'desktop.command.inputFailed')),
  entries: computed(() => {
    void commandRevision.value
    return [...workbench.controller.registry.commands.values()].flatMap(command => command.slash && (!command.enabled || command.enabled(workbench.controller.context)) ? [{ id: command.id, name: command.slash.name, title: commandLabel(command), description: command.slash.description, origin: command.slash.origin }] : [])
  }),
  execute: async (id, argumentsText, instanceId) => {
    const execution = await workbench.controller.commands.execute(id, { source: 'slash', arguments: argumentsText, paneId: instanceId })
    if (execution.status === 'unavailable')
      throw new Error('EXTENSION_COMMAND_UNAVAILABLE')
    return (execution.result ?? null) as import('@buddy-shared/workbench/workbenchState').JsonValue
  },
})
const extensionViews = useExtensionViews(api.extensions, extensions.installed, computed(() => pages.context.value.values))
const pageContext = workbench.controller.contextKeys.bind()
onScopeDispose(pageContext.dispose)
watch(() => pages.context.value.values, values => pageContext.update(values), { immediate: true, flush: 'sync' })
const anchors = new SemanticAnchorRegistry()
onScopeDispose(() => anchors.dispose())
useProvideWorkbenchUi({ anchors, panes: paneRegistry, controlRenderer: DesktopExtensionControl, slotRenderer: DesktopExtensionSlot, menuRenderer: DesktopExtensionMenu })
const ui = useExtensionUiContributions(extensions.installed, workbench.controller.configuration)
useExtensionContributions({ controller: workbench.controller, renderers: workbench.renderers, persistence: workbench.persistence, installed: extensions.installed, api: api.extensions, views: extensionViews, ui, ready: () => workbench.initialized })
useProvideExtensionContext({ settingsLocation: settingsRegistry.extensionLocation, authoring: { author: computed(() => stores.applicationSettings.config.value?.desktop.pluginAuthor ?? ''), save: author => stores.applicationSettings.updateSettings({ desktop: { pluginAuthor: author } }) }, state: extensions, views: extensionViews, anchors, ui, workbench: pages.context, language: stores.applicationSettings.language, isDark: toRef(() => props.isDark), startCreation: prompt => workbench.startTaskWithSkill('plugin-creator', prompt), endInteraction: id => workbench.controller.interactions.end(id), focusView: (id) => {
  workbench.controller.focus(id)
} })
onScopeDispose(workbench.controller.subscribe(() => void nextTick(extensionViews.layout)))
const selectedTask = workbench.activeTask
const resources = useTaskResourcePanel({
  scopeSpaceIds: useTaskResourceSpaces({ controller: workbench.controller, pool: workbench.pool, tasks: taskIndex.index.tasks }),
  activeConversationId: workbench.activeTaskId,
  activeDraftId: computed(() => selectedTask.value?.workspace.composer.draftId.value ?? null),
  activeBranchId: computed(() => selectedTask.value?.workspace.session.activeBranchId.value ?? null),
  activeRunId: computed(() => selectedTask.value?.workspace.execution.activeRun.value?.id
    ?? selectedTask.value?.workspace.transcript.runs.value.findLast(run => run.branchId === selectedTask.value?.workspace.session.activeBranchId.value
      && run.purpose !== 'conversation.compaction')?.id ?? null),
  activeSpace: computed(() => selectedTask.value?.session.activeSpace.value ?? null),
  spaces: taskIndex.index.spaces,
  mode: computed(() => stores.applicationSettings.config.value?.desktop.contextPanelMode ?? 'task'),
  taskVisible: computed(() => pages.current.value === 'lexora.tasks' || !!stores.applicationSettings.config.value?.desktop.contextPanelGlobal),
  control: api.contextPanel,
  browser: api.browser,
  closeView: async id => (await workbench.controller.close(id)).status === 'closed',
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
    void extensions.refresh()
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
    activeTaskId: workbench.activeTaskId,
    spaceId: computed(() => selectedTask.value?.session.spaceId.value ?? null),
    navigationVersion: () => workbench.navigationVersion,
    openTask: (id, signal) => workbench.openTask(id, { signal }),
    startTask: spaceId => workbench.newTask(spaceId),
  },
  notifications: stores.notifications,
  openUpdate: stores.updates.openDetails,
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
  pages,
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
  registry: settingsRegistry,
  pluginSettings: usePluginSettings(extensions.installed, extensions.api),
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
  prompts: api.localChat.prompts,
  writeClipboardText: text => api.clipboard.writeText(text),
  openTask: navigation.openTask,
})
useProvideSkillsContext({
  startCreation: (spaceId, prompt) => workbench.startTaskWithSkill('skill-creator', prompt, spaceId),
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
  <WorkbenchSurfaceHost v-slot="{ layout }">
    <DesktopBrowserGuestHost ref="browserGuestHost" :api="api.browser" :layout="layout" />
    <DesktopExtensionFrameHost :layout="layout" />
  </WorkbenchSurfaceHost>
  <DesktopExtensionOverlays />
  <DesktopExtensionReviewHost />
  <DesktopSkillReviewHost />
  <DesktopUpdateHost :language="stores.applicationSettings.language.value" />
  <slot :shell="shellBindings" />
</template>
