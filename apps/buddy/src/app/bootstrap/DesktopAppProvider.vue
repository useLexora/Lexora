<script setup lang="ts">
import type { DesktopShellBindings } from '../shell/desktopShellBindings'
import type { DesktopBrowserGuestSurfaceHost } from '@/platform/browser/browserGuestSurface'
import { DEFAULT_DESKTOP_CHAT_PREFERENCES } from '@buddy-electron/shared/desktopApi'
import { executionTargetSchema } from '@buddy-shared/executions/executionPresentationApi'
import { useMessage } from 'naive-ui'
import { computed, nextTick, onMounted, onScopeDispose, provide, ref, useTemplateRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { resolveBuddyLocale, translateBuddy } from '@/i18n/buddyI18n'
import { useProvideAutomationContext } from '@/modules/automations'
import { useProvideBuddiesContext } from '@/modules/buddies'
import { ExtensionWindowStyleController, useExtensionState, useExtensionUiContributions, useExtensionViews, useProvideExtensionContext } from '@/modules/extensions'
import { DesktopExtensionControl, DesktopExtensionFrameHost, DesktopExtensionMenu, DesktopExtensionOverlays, DesktopExtensionReviewHost, DesktopExtensionSlot } from '@/modules/extensions/ui'
import { useProvideFileOpening } from '@/modules/files'
import { fileOperationsKey } from '@/modules/files/ui'
import { useDesktopOnboarding, useFeatureDiscovery } from '@/modules/onboarding'
import { useCloudBackupFeedback, usePluginSettings, useProvideSettingsContext, useSettingsRegistry } from '@/modules/settings'
import { useProvideSkillsContext } from '@/modules/skills'
import { DesktopSkillReviewHost } from '@/modules/skills/ui'
import { provideExecutionEnvironment, sessionReferenceNavigationKey, useProvideTaskEnvironment, useTaskIndex, useTaskResourcePanel } from '@/modules/tasks'
import { useProvideDesktopUpdates } from '@/modules/updates'
import { DesktopUpdateHost } from '@/modules/updates/ui'
import DesktopBrowserGuestHost from '@/platform/browser/DesktopBrowserGuestHost.vue'
import { useBrowserGuestHost } from '@/platform/browser/useBrowserGuestHost'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { createRendererDiagnostics } from '@/platform/runtime/RendererDiagnostics'
import { runtimeAvailabilityKey } from '@/platform/runtime/runtimeAvailability'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import { useProvideWorkbenchCommands } from '@/shared/ui/contributions/workbenchCommands'
import { useProvideWorkbenchUi } from '@/shared/ui/contributions/workbenchUiContext'
import { useProvideDesktopUi } from '@/shared/ui/desktopUiContext'
import { useReferenceTargetPicker } from '@/shared/ui/selection/useReferenceTargetPicker'
import { workbenchSelectionReferencesKey } from '@/shared/ui/selection/workbenchSelectionReferences'
import { useDesktopTypography } from '@/theme/desktopTypography'
import { ThemeMaterialController } from '@/theme/ThemeMaterialController'
import { useDesktopTheme } from '@/theme/useDesktopTheme'
import { SemanticAnchorRegistry } from '@/workbench/browser/surfaces/SemanticAnchorRegistry'
import { WorkbenchPaneRegistry } from '@/workbench/browser/surfaces/WorkbenchPaneRegistry'
import WorkbenchSurfaceHost from '@/workbench/browser/surfaces/WorkbenchSurfaceHost.vue'
import { commandLabel } from '@/workbench/common/workbench'
import { useDesktopPages } from '../router/useDesktopPages'
import { useDesktopShellState } from '../shell/useDesktopShellState'
import { resolveUserProfile } from '../shell/userProfile'
import { createWorkbenchDataPort } from '../workbench/createWorkbenchDataPort'
import { desktopWorkbenchKey } from '../workbench/desktopWorkbenchContext'
import { registerResourceContributions } from '../workbench/registerResourceContributions'
import { useDesktopKeybindings } from '../workbench/useDesktopKeybindings'
import { useDesktopWorkbench } from '../workbench/useDesktopWorkbench'
import { useExtensionContributions } from '../workbench/useExtensionContributions'
import { useExtensionReferences } from '../workbench/useExtensionReferences'
import { useTaskResourceSpaces } from '../workbench/useTaskResourceSpaces'
import { createDesktopCapabilities } from './desktopCapabilities'
import { useDesktopAppState } from './useDesktopAppState'
import { useDesktopLifecycle } from './useDesktopLifecycle'
import { useDesktopNavigation } from './useDesktopNavigation'

const emit = defineEmits<{
  languageChange: [language: 'zh-CN' | 'en-US']
}>()
defineSlots<{ default: (props: { shell: DesktopShellBindings }) => unknown }>()
const desktopTheme = useDesktopTheme()
const api = requireDesktopApi()
const router = useRouter()
const message = useMessage()
const appState = useDesktopAppState({ api })
const { stores } = appState
const cloudBackup = useCloudBackupFeedback({ api: api.sync, language: stores.applicationSettings.language, notify: (type, content) => message[type](content) })

useDesktopTypography(() => stores.applicationSettings.config.value?.desktop.typography)
useProvideDesktopUpdates(stores.updates)
const buddyDirectory = useProvideBuddiesContext({ api: api.localChat.buddies, ready: computed(() => stores.runtimeSupervisor.runtimeState.value.status === 'ready') })
const taskIndex = useTaskIndex({
  api: api.localChat,
  applicationSettings: stores.applicationSettings,
  ready: computed(() => stores.runtimeSupervisor.runtimeState.value.status === 'ready'),
  onTaskDeleted,
  beforeTaskDelete,
  beforeTaskMove,
  onSpaceCreated,
})
const diagnostics = createRendererDiagnostics(api.app.logs)
const fileOpening = useProvideFileOpening(api.extensions)
const workbench = useDesktopWorkbench({ beforeExtensionClose: prepareExtensionClose, fileOpening, buddyCatalog: buddyDirectory.catalog, api, events: diagnostics.events, stores, taskIndex, router, resources: getResources, onError: () => message.error(translateBuddy(stores.applicationSettings.language.value, 'desktop.command.failed')) })

onScopeDispose(() => {
  void workbench.dispose().finally(() => diagnostics.dispose()).catch(() => {})
})
fileOpening.bindRegistry(workbench.controller.registry)
provide(desktopWorkbenchKey, workbench)
provide(fileOperationsKey, workbench.fileOperations)
provide(sessionReferenceNavigationKey, id => workbench.openTask(id, { direction: 'right' }))
provide(workbenchSelectionReferencesKey, workbench.selectionReferences)
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
function prepareExtensionClose(id: string, signal?: AbortSignal) {
  return extensionViews.prepareClosePlan(id, signal)
}
const pageContext = workbench.controller.contextKeys.bind()
onScopeDispose(pageContext.dispose)
watch(() => pages.context.value.values, values => pageContext.update(values), { immediate: true, flush: 'sync' })
const anchors = new SemanticAnchorRegistry()
const windowStyles = new ExtensionWindowStyleController(extensions.installed)
onScopeDispose(() => windowStyles.dispose())
const materials = new ThemeMaterialController(anchors)
onScopeDispose(() => {
  materials.dispose()
  anchors.dispose()
})
useProvideWorkbenchUi({ anchors, panes: paneRegistry, controlRenderer: DesktopExtensionControl, slotRenderer: DesktopExtensionSlot, menuRenderer: DesktopExtensionMenu })
const ui = useExtensionUiContributions(extensions.installed, workbench.controller.configuration)
const extensionReferences = useExtensionReferences({
  references: workbench.selectionReferences,
  controller: workbench.controller,
  persistence: workbench.persistence,
  pool: workbench.pool,
  api: api.extensions,
  views: extensionViews,
  installed: extensions.installed,
  writeClipboard: api.clipboard.writeText,
  chooseTarget: useReferenceTargetPicker(() => stores.applicationSettings.language.value),
  prepareNewTaskInput: workbench.prepareNewTaskInput,
  showTarget: workbench.showTaskInput,
  showPage: workbench.showReferencePage,
  notifySuccess: result => message.success(result.kind === 'view'
    ? translateBuddy(stores.applicationSettings.language.value, 'desktop.chat.quoteAddedToTarget', { title: result.title })
    : translateBuddy(stores.applicationSettings.language.value, result.kind === 'clipboard' ? 'desktop.chat.quoteCopied' : 'desktop.chat.quoteAddedToNewTask')),
})
useExtensionContributions({ controller: workbench.controller, renderers: workbench.renderers, persistence: workbench.persistence, installed: extensions.installed, api: api.extensions, views: extensionViews, ui, ready: () => workbench.initialized, receiveReference: extensionReferences.receive })
useProvideExtensionContext({ data: createWorkbenchDataPort({ api: api.localChat, controller: workbench.controller, pool: workbench.pool }), settingsLocation: settingsRegistry.extensionLocation, authoring: { author: computed(() => stores.applicationSettings.config.value?.desktop.pluginAuthor ?? ''), save: author => stores.applicationSettings.updateSettings({ desktop: { pluginAuthor: author } }) }, state: extensions, views: extensionViews, themeColors: desktopTheme.extensionColors, themeRevision: desktopTheme.revision, anchors, ui, workbench: pages.context, language: stores.applicationSettings.language, isDark: desktopTheme.isDark, startCreation: prompt => workbench.startTaskWithSkill('plugin-creator', prompt), endInteraction: id => workbench.controller.interactions.end(id), focusView: (id) => {
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
  linkOpening: computed(() => stores.applicationSettings.config.value?.browser.linkOpening ?? 'in-app'),
  autoCollapse: computed(() => stores.applicationSettings.config.value?.desktop.contextPanelAutoCollapse ?? false),
  taskVisible: computed(() => pages.current.value === 'lexora.tasks' || !!stores.applicationSettings.config.value?.desktop.contextPanelGlobal),
  control: api.contextPanel,
  browser: api.browser,
  files: api.localChat.taskFiles,
  openFile: async (file, source, provider, current, signal) => {
    if (!current())
      return
    const state = { mode: provider?.renderer === 'text' ? 'source' : 'preview', fileOpeningProvider: provider?.id ?? null, ...(source ? { contextSource: { ...source } } : {}) }
    const id = await workbench.controller.open({ scheme: 'task-file', id: JSON.stringify([file.target.conversationId, file.target.path]), data: { ...file.target, kind: file.kind } }, file.name, { location: 'context', state, signal })
    if (!id)
      throw new Error('FILE_OPENER_UNAVAILABLE')
    const view = workbench.controller.layout.views[id]
    if (view)
      workbench.controller.updateView(id, { state: { ...view.state, ...state } })
  },
  fileOpening: {
    ensureReady: fileOpening.ensureReady,
    resolve: fileOpening.resolve,
    open: async (resource, provider, current, signal) => {
      const prepared = await api.extensions.prepareFileOpening({ providerId: provider.id, location: 'standalone', source: resource.source })
      if (!current())
        return
      const id = await workbench.controller.open({ scheme: 'extension', id: JSON.stringify([resource.source, provider.id]), data: { extensionId: prepared.extensionId, viewType: prepared.viewType, resource: prepared.resource } }, resource.name, { viewType: prepared.viewType, location: 'context', signal, state: { version: 0, value: {}, ...(resource.context ? { contextSource: { ...resource.context } } : {}) } })
      if (!id)
        throw new Error('FILE_OPENER_UNAVAILABLE')
    },
  },
  closeView: async id => (await workbench.controller.close(id)).status === 'closed',
  closeFiles: workbench.closeContextFiles,
  changeSets: computed(() => selectedTask.value?.workspace.transcript.changeSets.value ?? []),
  runOutputs: computed(() => selectedTask.value?.workspace.transcript.runOutputs.value ?? []),
  onError: error => message.error(error ? resolveLocalChatErrorMessage(error, stores.applicationSettings.language.value) : translateBuddy(stores.applicationSettings.language.value, 'desktop.context.controlFailed')),
})
onScopeDispose(registerResourceContributions(workbench.controller.registry, () => resources, () => stores.applicationSettings.language.value))
provideExecutionEnvironment({
  api: api.localChat.executions,
  ready: computed(() => stores.runtimeSupervisor.runtimeState.value.status === 'ready'),
  selectedTarget: computed(() => {
    if (!resources.isOpen.value)
      return null
    const tab = resources.activeTab.value
    const view = tab?.kind === 'view' ? workbench.controller.layout.views[tab.viewId] : null
    if (view?.resource.scheme !== 'execution')
      return null
    const target = executionTargetSchema.safeParse(view.resource.data)
    return target.success ? target.data : null
  }),
  open: async (target, label) => {
    const view = await workbench.controller.open({ scheme: 'execution', id: `${target.branchId}:${target.runId}`, data: { ...target } }, label)
    if (!view)
      throw new Error('Execution detail is unavailable')
    resources.openView(view, label, { conversationId: target.conversationId, runId: target.runId })
  },
  onError: () => message.error(translateBuddy(stores.applicationSettings.language.value, 'desktop.command.failed')),
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
  return workbench.newTask({ spaceId: id })
}
async function beforeTaskMove(id: string) {
  return await workbench.pool.peek({ scheme: 'task', id, data: {} })?.flushDrafts() ?? true
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
  prepareQuit: extensionViews.prepareAllClose,
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
    startTask: spaceId => workbench.newTask({ spaceId }),
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

const onboarding = useDesktopOnboarding({
  settings: stores.applicationSettings,
  providers: stores.modelProviders,
  buddies: buddyDirectory,
  onComplete: () => navigation.navigate(desktopRouteLocations.tasks()),
})
const featureDiscovery = useFeatureDiscovery({
  settings: stores.applicationSettings,
  appInfo: shell.appInfo,
  visit: async (id) => {
    const location = {
      'navigation-layout': desktopRouteLocations.settings('appearance'),
      'npc-team': desktopRouteLocations.buddies(buddyDirectory.catalog.value?.defaultBuddyId),
      'additional-directories': desktopRouteLocations.tasks(),
      'network-permissions': desktopRouteLocations.settings('browser'),
      'follow-up-behavior': desktopRouteLocations.settings('runtime'),
      'speech-settings': desktopRouteLocations.settings('speech'),
      'image-settings': desktopRouteLocations.settings('models'),
    }[id]
    await navigation.navigate(location)
    if (router.currentRoute.value.path !== router.resolve(location).path)
      return false
    return id === 'additional-directories' ? taskIndex.index.sidebar.setCollapsed(false) : true
  },
  onError: () => message.error(translateBuddy(stores.applicationSettings.language.value, 'desktop.command.failed')),
})
watch(() => router.currentRoute.value.fullPath, () => featureDiscovery.routeChanged())
const shellBindings: DesktopShellBindings = {
  onboarding,
  featureDiscovery,
  navigationLayout: shell.navigationLayout,
  pages,
  shortcuts,
  contextPanelGlobal: computed(() => stores.applicationSettings.config.value?.desktop.contextPanelGlobal ?? false),
  workbench,
  resources,
  resourceContext: {
    getChangeOverview: api.localChat.changes.overview,
    files: api.localChat.spaces,
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
const userProfile = computed(() => resolveUserProfile(
  stores.applicationSettings.config.value?.desktop.profile,
  shell.appInfo.value,
))

useProvideDesktopUi({
  isDark: desktopTheme.isDark,
  chat: computed(() => stores.applicationSettings.config.value?.desktop.chat ?? DEFAULT_DESKTOP_CHAT_PREFERENCES),
  language: stores.applicationSettings.language,
  appSidebarCollapsed: shell.appSidebarCollapsed,
  userName: computed(() => userProfile.value.userName),
})
useProvideTaskEnvironment({
  resources,
  browser: api.browser,
  browserGuests,
  clipboard: api.clipboard,
  notificationTarget,
})
useProvideSettingsContext({
  openOnboarding: onboarding.open,
  featureDiscovery: { open: featureDiscovery.open, unreadCount: computed(() => featureDiscovery.unread.value.length) },
  registry: settingsRegistry,
  pluginSettings: usePluginSettings(extensions.installed, extensions.api),
  shortcuts,
  browser: api.browser,
  applicationSettings: stores.applicationSettings,
  appInfo: shell.appInfo,
  dataSettings: capabilities.dataSettings,
  storageUsage: stores.storageUsage,
  storage: stores.storage,
  cloudBackup,
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
</script>

<template>
  <WorkbenchSurfaceHost v-slot="{ layout }">
    <DesktopBrowserGuestHost ref="browserGuestHost" :api="api.browser" :layout="layout" />
    <DesktopExtensionFrameHost :layout="layout" />
  </WorkbenchSurfaceHost>
  <DesktopExtensionOverlays />
  <DesktopExtensionReviewHost />
  <DesktopSkillReviewHost />
  <DesktopUpdateHost v-if="!onboarding.pending.value" :language="stores.applicationSettings.language.value" />
  <slot :shell="shellBindings" />
</template>
