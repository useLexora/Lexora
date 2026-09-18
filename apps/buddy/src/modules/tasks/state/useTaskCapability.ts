import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { BuddyPermissionMode } from '@buddy-shared/permissions/permissionMode'
import type { JSONContent } from '@tiptap/core'
import type { TaskCapability } from '../contracts'
import type { TaskIndexController } from './task-index/useTaskIndex'
import type { ModelProvidersStore } from '@/modules/models'
import type { ApplicationSettings } from '@/modules/settings'
import type { ChatBlockerKind } from '@/modules/tasks/model/status/typing'
import type { RuntimeSupervisorStore } from '@/platform/runtime/useRuntimeSupervisorStore'
import { until } from '@vueuse/core'
import { computed, readonly, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { getChatComposerResourceIds } from '@/modules/prompt-input'
import { resolveChatComposerModelInputIssue } from '@/modules/tasks/model/composer/chatComposerModelCapability'
import {
  reconcileDismissedChatBlocker,
  resolveChatBlocker,
} from '@/modules/tasks/model/status/chatBlocker'
import { useChatComposerInteractions } from '@/modules/tasks/state/composer/useChatComposerInteractions'
import { useComposerContextOptions } from '@/modules/tasks/state/composer/useComposerContextOptions'
import { useComposerResources } from '@/modules/tasks/state/composer/useComposerResources'
import { useChatApprovals } from '@/modules/tasks/state/runs/useChatApprovals'
import { useChatContextUsage } from '@/modules/tasks/state/runs/useChatContextUsage'
import { useChatExecution } from '@/modules/tasks/state/runs/useChatExecution'
import { useChatRunSync } from '@/modules/tasks/state/runs/useChatRunSync'
import { useTaskSpaces } from '@/modules/tasks/state/task-index/useTaskSpaces'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'
import { createDraftScopeKey } from '../model/drafts/draftScope'
import { useChatConversations } from './conversations/useChatConversations'
import { useChatSession } from './conversations/useChatSession'
import { useConversationTree } from './conversations/useConversationTree'
import { useChatDrafts } from './drafts/useChatDrafts'
import { useChatPermissionSettings } from './drafts/useChatPermissionSettings'
import { useTaskDraftModelBinding } from './drafts/useTaskDraftModelBinding'
import { useTaskModelPersistence } from './drafts/useTaskModelPersistence'
import { useTaskModelSelection } from './drafts/useTaskModelSelection'

import { useTaskWorkspacePersistence } from './drafts/useTaskWorkspacePersistence'
import { useTaskLifecycle } from './useTaskLifecycle'

export interface UseTaskCapabilityOptions {
  index: TaskIndexController
  initialTarget: { draftKey?: string, conversationId: string | null, branchId: string | null, spaceId: string | null }
  api: LexoraDesktopApi
  applicationSettings: ApplicationSettings
  modelProviders: ModelProvidersStore
  runtimeSupervisor: RuntimeSupervisorStore
  onDraftCommitted?: (draftId: string, conversationId: string) => void
}

export function useTaskCapability(options: UseTaskCapabilityOptions): TaskCapability {
  const {
    api,
    applicationSettings,
    modelProviders,
    runtimeSupervisor,
  } = options
  const taskModels = useTaskModelSelection(modelProviders)
  const taskIndexData = options.index.data
  const { conversations } = taskIndexData
  const chatSession = useChatSession()
  chatSession.hydrate({ activeConversationId: options.initialTarget.conversationId, activeBranchId: options.initialTarget.branchId, spaceId: options.initialTarget.spaceId })
  const {
    activeBranchId,
    activeConversationId,
    branches,
    spaceId,
  } = chatSession
  const isSelectingFiles = shallowRef(false)
  const isClosing = shallowRef(false)
  const errorMessage = shallowRef<string | null>(null)
  const dismissedChatBlockerKind = shallowRef<ChatBlockerKind | null>(null)
  const { language } = applicationSettings
  const welcomePreference = computed(() => (
    applicationSettings.config.value?.desktop.chat.welcome ?? 'random'
  ))
  const { t } = useBuddyI18n(language)
  const taskMarks = options.index.index.marks
  const getRunTerminationMessage = (errorCode: string | null) =>
    errorCode === 'SESSION_STORAGE_UNAVAILABLE'
      ? t('desktop.chat.sessionStorageUnavailable')
      : t('desktop.chat.runTerminated')
  const runSync = useChatRunSync({
    activeBranchId,
    activeConversationId,
    api: api.localChat,
    onError: setError,
  })
  const {
    approvals,
    changeSets,
    hasOlderMessages,
    isLoadingOlderMessages,
    messages,
    runEventBuckets,
    runSignalEvents,
    runOutputs,
    runs,
    timelineItems,
  } = runSync

  const activeRun = computed(() => runs.value.find(
    run => run.status === 'queued' || run.status === 'running',
  ) ?? null)
  const hasAvailableProvider = computed(() => modelProviders.providers.value.some(
    provider => provider.enabled && provider.status === 'available',
  ))
  const chatBlocker = computed(() => resolveChatBlocker({
    hasAvailableProvider: hasAvailableProvider.value,
    hasSelectedModel: taskModels.selectedModel.value !== null,
    runtimeError: runtimeSupervisor.runtimeError.value,
    runtimeStatus: runtimeSupervisor.runtimeState.value.status,
  }))
  const visibleChatBlocker = computed(() => (
    chatBlocker.value?.kind === dismissedChatBlockerKind.value ? null : chatBlocker.value
  ))
  const draftScopeKey = computed(() => createDraftScopeKey({
    draftKey: options.initialTarget.draftKey,
    conversationId: activeConversationId.value,
    branchId: activeBranchId.value,
    spaceId: spaceId.value,
  }))
  let persistDraftChanges = () => {}
  const drafts = useChatDrafts({
    onChange: () => persistDraftChanges(),
    targetKey: draftScopeKey,
  })
  const { composerContent, draft, draftId } = drafts
  const draftModelBinding = useTaskDraftModelBinding({
    drafts,
    isModelCatalogReady: computed(() => !modelProviders.isLoadingModelCatalog.value && modelProviders.models.value.length > 0),
    selection: taskModels,
    conversationModel: getActiveConversationModel,
  })
  const composerResources = useComposerResources({
    api: api.localChat.composerResources,
    draftId,
    getReferencedIds: drafts.resourceIdsForDraft,
    onError: setError,
    onLimitExceeded: () => errorMessage.value = t('desktop.chat.attachmentLimit'),
    onRejected: drafts.rejectResources,
  })
  watch([draftId, () => getChatComposerResourceIds(composerContent.value as JSONContent | null).join('\0')], ([id, references]) => {
    if (references)
      void composerResources.restore(id).catch(setError)
  }, { immediate: true })
  const {
    activateDraftScope,
    activateGlobalDraft,
    activeConversation,
    applyConversation,
    listActiveConversationMessages,
    openConversation,
    refreshBranches,
  } = useChatConversations({
    api: api.localChat,
    taskIndexData,
    clearError: () => errorMessage.value = null,
    onError: setError,
    persistWorkspaceState,
    restoreConversationModelSelection: draftModelBinding.restoreScope,
    runSync,
    selectDefaultModel: () => draftModelBinding.restoreScope(),
    session: chatSession,
  })
  const workspacePersistence = useTaskWorkspacePersistence({
    beforePersist: composerResources.whenAccepted,
    onDraftRestored: draftModelBinding.restoreOpenedDraft,
    initialModelSelection: draftModelBinding.initialModelSelection,
    api: api.localChat,
    drafts,
    getConversation: id => activeConversation.value?.id === id
      ? activeConversation.value
      : conversations.value.find(conversation => conversation.id === id) ?? null,
    onError: setError,
    session: chatSession,
  })
  persistDraftChanges = workspacePersistence.persistIfHydrated
  watch(spaceId, () => persistDraftChanges())
  function persistWorkspaceState() {
    return workspacePersistence.persist()
  }
  function getActiveConversationModel() {
    return activeConversation.value?.modelSelection ?? null
  }
  const taskSpaces = useTaskSpaces({
    activateDraftScope,
    index: options.index,
    draftId,
    onError: setError,
    persistWorkspaceState,
    spaceId,
    selectDefaultModel: () => draftModelBinding.restoreScope(),
  })
  const {
    activeSpace,
    createSpace,
    activateSpaceDraft,
  } = taskSpaces
  watch(activeSpace, (space, previous) => {
    if (!activeConversationId.value && previous && !previous.revokedAt && (!space || space.revokedAt))
      void activateGlobalDraft().catch(setError)
  })
  const { listContextOptions } = useComposerContextOptions({
    activeBranchId,
    activeConversationId,
    draftId,
    spaceId,
    listSources: api.localChat.composerResources.listSources,
    listSkills: api.localChat.skills.list,
  })
  const currentTitle = computed(() => activeConversation.value?.title?.trim()
    || t('desktop.tasks.newTask'))
  const permissionSettingsState = useChatPermissionSettings({
    activeConversation,
    activeConversationId,
    activeRun,
    applyConversation,
    api: api.localChat.conversations,
    drafts,
    onError: setError,
    persistWorkspaceState,
  })
  const {
    approvalViews,
    resolveApproval,
    resolvingApprovalActions,
    resolvingApprovalIds,
  } = useChatApprovals({
    api: api.localChat,
    approvals,
    onError: setError,
    refresh: runSync.refreshActiveConversation,
  })
  const contextUsageTracker = useChatContextUsage({
    activeBranchId,
    activeConversationId,
    approvalPolicy: permissionSettingsState.approvalPolicy,
    api: api.localChat.context,
    draftId,
    executionProfile: permissionSettingsState.executionProfile,
    models: modelProviders.models,
    spaceId,
    runSignalEvents,
    runtimeState: runtimeSupervisor.runtimeState,
    selectedEffort: taskModels.selectedEffort,
    selectedModel: taskModels.selectedModel,
    selectedServiceTier: taskModels.selectedServiceTier,
  })
  const { contextUsage } = contextUsageTracker
  const composerModelInputIssue = computed(() => resolveChatComposerModelInputIssue({
    model: taskModels.selectedModelOption.value,
    modelSelection: taskModels.currentSelection(),
    resourceIds: getChatComposerResourceIds(composerContent.value as JSONContent),
    resources: composerResources.resources.value,
  }))
  const composerInteractions = useChatComposerInteractions({ runs })
  const execution = useChatExecution({
    activeRun,
    approvalPolicy: permissionSettingsState.approvalPolicy,
    api: api.localChat,
    canSendDraft: computed(() => !isClosing.value && workspacePersistence.restorationState.value === 'ready' && composerModelInputIssue.value === null),
    taskIndexData,
    session: chatSession,
    drafts,
    draftScopeKey: drafts.targetKey,
    draftChangedMessage: () => t('desktop.chat.draftChanged'),
    executionProfile: permissionSettingsState.executionProfile,
    getRunTerminationMessage,
    isUpdatingPermissionSettings: permissionSettingsState.isUpdating,
    language,
    persistWorkspaceState,
    modelSelection: taskModels,
    onActionCommandRunStarted: composerInteractions.trackActionCommand,
    onDraftCommitted: options.onDraftCommitted,
    refreshBranches,
    selectComposerSource: composerResources.selectSource,
    runSync,
    setErrorMessage: message => errorMessage.value = message,
    runtimeSupervisor,
    unavailableCommandMessage: () => t('desktop.chat.commandUnavailable'),
  })
  const {
    activateBranch,
    canMutateBranch,
    canSend,
    queuedMessages,
    pendingQueueActions,
    cancelQueuedMessage,
    steerQueuedMessage,
    cancelActiveRun,
    cancelEditUserMessage,
    editUserMessage,
    editingMessageId,
    isMutatingBranch,
    isSending,
    regenerateAssistant,
    send,
    submitEditedMessage,
  } = execution
  const canUpdatePermissionSettings = computed(() => (
    permissionSettingsState.canUpdate.value
    && !isSending.value
    && !isMutatingBranch.value
  ))
  const { selectChatModel, setChatEffort, setChatServiceTier } = useTaskModelPersistence({
    activeConversationId,
    api: api.localChat.conversations,
    applyConversation,
    drafts,
    onError: setError,
    selection: taskModels,
  })

  async function setPermissionMode(value: BuddyPermissionMode): Promise<boolean> {
    if (!canUpdatePermissionSettings.value)
      return false
    return permissionSettingsState.setPermissionMode(value)
  }

  const lifecycle = useTaskLifecycle({
    api: api.localChat,
    activeConversation,
    clearError: () => errorMessage.value = null,
    onError: setError,
    refreshBranches,
    runSync,
    session: chatSession,
    taskIndex: taskIndexData,
    taskModels,
    restoreScopeModel: draftModelBinding.restoreScope,
    workspacePersistence,
  })

  watch(chatBlocker, (value) => {
    dismissedChatBlockerKind.value = reconcileDismissedChatBlocker(
      dismissedChatBlockerKind.value,
      value,
    )
  })

  async function selectAttachments() {
    if (isClosing.value)
      return
    const source = drafts.load(draftScopeKey.value)
    await lifecycle.initialLoad
    if (draftId.value !== source.draftId || !drafts.isEditorSessionCurrent(source))
      return
    isSelectingFiles.value = true
    try {
      const resourceIds = await composerResources.selectFiles(source.draftId)
      if (resourceIds.length)
        drafts.appendResourcePanel(source.draftId, resourceIds, source.editorSessionId)
    }
    catch (error) {
      setError(error)
    }
    finally {
      isSelectingFiles.value = false
    }
  }

  function setError(error: unknown) {
    errorMessage.value = resolveLocalChatErrorMessage(error, language.value)
  }

  function dispose() {
    lifecycle.dispose()
    workspacePersistence.dispose()
    draftModelBinding.dispose()
    taskModels.dispose()
    contextUsageTracker.dispose()
    runSync.dispose()
  }

  function flushDrafts(): Promise<boolean> {
    return workspacePersistence.flushPending()
  }

  async function prepareClose(): Promise<boolean> {
    isClosing.value = true
    await until(() => isSending.value || isMutatingBranch.value || isSelectingFiles.value).toBe(false)
    if (!await flushDrafts()) {
      isClosing.value = false
      return false
    }
    await until(() => composerResources.resources.value.some(entry => entry.resource.state === 'importing')).toBe(false)
    const saved = await flushDrafts()
    if (!saved)
      isClosing.value = false
    return saved
  }

  function dismissChatBlocker() {
    if (visibleChatBlocker.value?.dismissible)
      dismissedChatBlockerKind.value = visibleChatBlocker.value.kind
  }

  async function startTask(spaceId: string | null): Promise<void> {
    if (spaceId === null) {
      await activateGlobalDraft()
      return
    }
    await activateSpaceDraft(spaceId)
  }

  const index = { ...options.index.index, createSpace }

  const session = {
    navigationVersion: chatSession.generation,
    activeSpace: readonly(activeSpace),
    activeTask: readonly(activeConversation),
    activeTaskId: readonly(activeConversationId),
    currentTitle: readonly(currentTitle),
    openTask: openConversation,
    spaceId: readonly(spaceId),
    startTask,
  } as const

  const chatWorkspaceSession = {
    activeBranchId: readonly(activeBranchId),
    activeConversation: readonly(activeConversation),
    activeConversationId: readonly(activeConversationId),
    activeSpace: readonly(activeSpace),
    currentTitle: readonly(currentTitle),
    listActiveConversationMessages,
    openConversation,
    spaceId: readonly(spaceId),
  } as const

  const tree = useConversationTree({
    api: api.localChat.conversations,
    conversationId: activeConversationId,
    branchId: activeBranchId,
    language,
    runs,
  })
  const workspace = {
    marks: taskMarks,
    tree,
    context: {
      getChangeOverview: api.localChat.changes.overview,
      files: { listDirectory: api.localChat.spaces.listDirectory, readFile: api.localChat.spaces.readFile, revealFile: api.localChat.spaces.revealFile },
      getNodeDetail: api.localChat.conversations.getNodeDetail,
      getChangeSet: api.localChat.changes.get,
      readArtifactText: api.localChat.artifacts.readText,
    },
    composer: {
      target: execution.composerTarget.current,
      composerContent,
      contextUsage: readonly(contextUsage),
      dismissInteraction: composerInteractions.dismissInteraction,
      draft: readonly(draft),
      draftId: readonly(draftId),
      editorKey: readonly(drafts.editorKey),
      resources: composerResources.resources,
      rejectedResourceIds: composerResources.rejectedIds,
      beginImport: (files: readonly File[], origin?: 'file' | 'clipboard') => !isClosing.value && lifecycle.hasCompletedInitialLoad.value ? composerResources.begin(files, origin) : [],
      selectSource: composerResources.selectSource,
      retryResource: composerResources.retry,
      canUpdatePermissionSettings: readonly(canUpdatePermissionSettings),
      isUpdatingPermissionSettings: permissionSettingsState.isUpdating,
      isSelectingFiles: readonly(isSelectingFiles),
      interaction: composerInteractions.interaction,
      listContextOptions,
      models: modelProviders.models,
      providers: modelProviders.providers,
      selectedEffort: taskModels.selectedEffort,
      selectedModel: taskModels.selectedModelOption,
      selectedModelId: taskModels.selectedModelId,
      selectedServiceTier: taskModels.selectedServiceTier,
      selectAttachments,
      selectModel: selectChatModel,
      setSelectedEffort: setChatEffort,
      setSelectedServiceTier: setChatServiceTier,
      permissionMode: permissionSettingsState.permissionMode,
      setPermissionMode,
      updateComposerContent: (text: string, content: JSONContent | null) => {
        if (!isClosing.value)
          drafts.updateComposerContent(text, content)
      },
    },
    execution: {
      activeRun: readonly(activeRun),
      approvalViews: readonly(approvalViews),
      canMutateBranch: readonly(canMutateBranch),
      canSend: readonly(canSend),
      queuedMessages,
      pendingQueueActions,
      cancelQueuedMessage,
      steerQueuedMessage,
      cancelActiveRun,
      cancelEditUserMessage,
      editUserMessage,
      beginFollowup: execution.beginFollowup,
      cancelFollowup: execution.cancelFollowup,
      editingMessageId,
      isMutatingBranch: readonly(isMutatingBranch),
      isSending: readonly(isSending),
      regenerateAssistant,
      resolveApproval,
      resolvingApprovalActions: readonly(resolvingApprovalActions),
      resolvingApprovalIds: readonly(resolvingApprovalIds),
      send,
      submitEditedMessage,
    },
    language,
    session: chatWorkspaceSession,
    welcomePreference: readonly(welcomePreference),
    restoration: {
      state: workspacePersistence.restorationState,
      conflict: workspacePersistence.restorationConflict,
      restore: lifecycle.refreshRuntimeDependentState,
      resolveRemote: workspacePersistence.resolveRemote,
    },
    status: {
      isClosing: readonly(isClosing),
      canRestartRuntime: runtimeSupervisor.canRestartRuntime,
      dismissChatBlocker,
      dismissError: () => { errorMessage.value = null },
      errorMessage: readonly(errorMessage),
      isLoading: computed(() => lifecycle.isLoading.value || runSync.isLoadingConversation.value),
      restartRuntime: runtimeSupervisor.restartRuntime,
      runtimeError: runtimeSupervisor.runtimeError,
      runtimeState: runtimeSupervisor.runtimeState,
      visibleChatBlocker: readonly(visibleChatBlocker),
    },
    transcript: {
      activateBranch,
      branches: readonly(branches),
      changeSets: readonly(changeSets),
      hasOlderMessages: readonly(hasOlderMessages),
      isLoadingOlderMessages: readonly(isLoadingOlderMessages),
      loadOlderMessages: runSync.loadOlderMessages,
      messages: readonly(messages),
      runEventBuckets: readonly(runEventBuckets),
      runSignalEvents: readonly(runSignalEvents),
      runOutputs: readonly(runOutputs),
      runs: readonly(runs),
      timelineItems: readonly(timelineItems),
    },
  } as const

  return {
    prepareClose,
    cancelClose: () => isClosing.value = false,
    dispose,
    flushDrafts,
    index,
    initialize: lifecycle.initialize,
    language,
    refreshRuntimeDependentState: lifecycle.refreshRuntimeDependentState,
    session,
    workspace,
  }
}

export type { TaskCapability, TaskChatWorkspace } from '../contracts'
