import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { ParsedBuddyChatCommand } from '@buddy-shared/conversation/buddyChatCommands'
import type { BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { LocalPromptContextItem } from '@buddy-shared/conversation/chatApi'
import type { BuddyApprovalPolicy } from '@buddy-shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '@buddy-shared/permissions/executionProfile'
import type { LocalRun } from '@buddy-shared/runs/runApi'

import type { ComposerTarget } from '../composer/useComposerTarget'
import type { ChatRunSync } from './typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ChatComposerSubmitPayload } from '@/modules/prompt-input'
import type { ChatSession } from '@/modules/tasks/state/conversations/useChatSession'
import type { ChatDrafts, TaskModelSelection } from '@/modules/tasks/state/drafts/typing'
import type { TaskIndexData } from '@/modules/tasks/state/task-index/useTaskIndexData'
import type { RuntimeSupervisorStore } from '@/platform/runtime/useRuntimeSupervisorStore'
import { parseBuddyChatCommand } from '@buddy-shared/conversation/buddyChatCommands'
import { getBuddyUserContentResourceIds } from '@buddy-shared/conversation/buddyUserContent'
import { computed, onScopeDispose, readonly, shallowRef, watch } from 'vue'
import { translateBuddy } from '@/i18n/buddyI18n'
import { createRequestIdRegistry } from '@/modules/tasks/model/requests/chatRequestIdentity'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'
import { parseDraftScopeKey } from '../../model/drafts/draftScope'
import { useChatQueue } from './useChatQueue'

interface ValueRef<T> {
  readonly value: T
}

export interface UseChatTurnExecutionOptions {
  activeRun: ValueRef<LocalRun | null>
  approvalPolicy: ValueRef<BuddyApprovalPolicy>
  api: { chat: Pick<LocalChatApi['chat'], 'cancel' | 'executeCommand' | 'startTurn' | 'enqueue' | 'listQueue' | 'cancelQueued' | 'steerQueued'> }
  canSendDraft: ValueRef<boolean>
  taskIndexData: Pick<TaskIndexData, 'refreshIndex'>
  session: Pick<ChatSession, | 'acceptTurn'
  | 'activeBranchId'
  | 'activeConversationId'
  | 'branches'
  | 'generation'
  | 'isCurrent'
  | 'upsertBranch'>
  drafts: Pick<ChatDrafts, | 'acknowledgeSend'
  | 'draftId'
  | 'isPersisted'
  | 'resourceIdsForDraft'
  | 'setUserContent'
  | 'snapshot'>
  composerTarget: ComposerTarget
  draftScopeKey: ValueRef<string>
  draftChangedMessage: () => string
  executionProfile: ValueRef<BuddyExecutionProfile>
  getRunTerminationMessage: (errorCode: string | null) => string
  isUpdatingPermissionSettings: ValueRef<boolean>
  language: ValueRef<BuddyLocale>
  modelSelection: Pick<TaskModelSelection, 'selectedModel'>
  onActionCommandRunStarted: (runId: string) => void
  onDraftCommitted?: (draftId: string, conversationId: string) => void
  persistWorkspaceState: () => Promise<boolean>
  runSync: Pick<ChatRunSync, 'applyRunStart' | 'upsertRuns' | 'refreshActiveConversation'>
  runtimeSupervisor: Pick<RuntimeSupervisorStore, 'runtimeState'>
  setErrorMessage: (message: string | null) => void
  unavailableCommandMessage: () => string
}

export function useChatTurnExecution(options: UseChatTurnExecutionOptions) {
  const queue = useChatQueue({ api: options.api.chat, session: options.session, runtime: options.runtimeSupervisor, refreshConversation: options.runSync.refreshActiveConversation, onError: error => options.setErrorMessage(resolveLocalChatErrorMessage(error, options.language.value)), onUnavailable: () => options.setErrorMessage(translateBuddy(options.language.value, 'desktop.chat.queueActionFailed')) })
  const isSending = shallowRef(false)
  const requestIds = createRequestIdRegistry()
  const pendingCancellationWatches = new Set<() => void>()
  let isDisposed = false
  onScopeDispose(() => {
    isDisposed = true
    for (const stop of pendingCancellationWatches)
      stop()
    pendingCancellationWatches.clear()
  }, true)
  const canSend = computed(() =>
    options.runtimeSupervisor.runtimeState.value.status === 'ready'
    && options.canSendDraft.value
    && options.modelSelection.selectedModel.value !== null
    && (!options.activeRun.value || options.composerTarget.current.value.kind === 'conversation_branch')
    && !isSending.value
    && !options.isUpdatingPermissionSettings.value,
  )

  async function send(payload: ChatComposerSubmitPayload | string) {
    const userContent = typeof payload === 'string' ? undefined : payload.userContent
    const content = typeof payload === 'string' ? payload : payload.content
    if (userContent)
      options.drafts.setUserContent(userContent)
    const resourceIds = userContent
      ? getBuddyUserContentResourceIds(userContent)
      : options.drafts.resourceIdsForDraft(options.drafts.draftId.value)
    const contextItems: ReadonlyArray<LocalPromptContextItem> = userContent
      ? userContent.body.flatMap(paragraph => paragraph.content.flatMap(node => node.type === 'prompt_directive' ? [{ kind: node.directive === 'skill' ? 'skill' as const : 'slashCommand' as const, value: node.value }] : []))
      : []
    const hasQuotes = Boolean((userContent ?? options.drafts.snapshot(options.draftScopeKey.value).content).quotes?.length)
    if ((!content.trim() && !resourceIds.length && !hasQuotes) || !canSend.value)
      return false
    const command = parseBuddyChatCommand(content)
    if (command?.kind === 'action' && (resourceIds.length || hasQuotes || options.composerTarget.current.value.kind === 'message_followup')) {
      options.setErrorMessage(options.unavailableCommandMessage())
      return false
    }
    if (command?.kind === 'action' && options.activeRun.value)
      return false
    if (command?.kind === 'action') {
      options.drafts.setUserContent(createActionCommandContent(command))
      return executeActionCommand(command, contextItems)
    }

    const sourceScopeKey = options.draftScopeKey.value
    const navigationVersion = options.session.generation()
    const isSourceViewCurrent = () => options.session.isCurrent(navigationVersion)
      && options.draftScopeKey.value === sourceScopeKey
    isSending.value = true
    options.setErrorMessage(null)
    try {
      if (!await options.persistWorkspaceState())
        return false
      const confirmedDraft = options.drafts.snapshot(sourceScopeKey)
      if (!options.drafts.isPersisted(confirmedDraft)) {
        if (isSourceViewCurrent())
          options.setErrorMessage(options.draftChangedMessage())
        return false
      }
      const expectedRevision = confirmedDraft.revision!
      const operationKey = `turn:${confirmedDraft.draftId}:${expectedRevision}`
      const requestId = requestIds.resolve(operationKey)
      if (options.activeRun.value || queue.queuedMessages.value.length) {
        const result = await options.api.chat.enqueue({ draftId: confirmedDraft.draftId, expectedRevision, requestId })
        requestIds.release(operationKey)
        options.composerTarget.complete(result.draftReceipt, sourceScopeKey, sourceScopeKey)
        await queue.refreshQueue()
        return true
      }
      const result = await options.api.chat.startTurn({
        draftId: confirmedDraft.draftId,
        expectedRevision,
        requestId,
      })
      if (!result.draftReceipt)
        throw new Error('Turn did not commit its Composer draft')
      requestIds.release(operationKey)
      const sourceViewIsCurrent = isSourceViewCurrent()
      const targetScopeKey = `conversation:${result.conversationId}:${result.branchId}`
      const source = parseDraftScopeKey(confirmedDraft.targetKey)
      const acknowledged = options.composerTarget.complete(result.draftReceipt, targetScopeKey, sourceScopeKey)
      options.onDraftCommitted?.(result.draftReceipt.draftId, result.conversationId)
      if (sourceViewIsCurrent && (acknowledged || sourceScopeKey === targetScopeKey)) {
        options.session.acceptTurn(result.conversationId, result.branchId)
        if (!options.session.branches.value.some(
          branch => branch.id === result.branchId,
        )) {
          options.session.upsertBranch({
            conversationId: result.conversationId,
            createdAt: result.run.startedAt,
            forkedFromMessageId: source.kind === 'message_followup' ? source.assistantMessageId : null,
            id: result.branchId,
            parentBranchId: source.kind === 'message_followup' ? source.branchId : null,
          })
        }
        options.runSync.applyRunStart(result)
      }
      if (result.run.status === 'failed' || result.run.status === 'cancelled') {
        if (sourceViewIsCurrent) {
          options.setErrorMessage(options.getRunTerminationMessage(result.run.errorCode))
        }
      }
      refreshTaskIndex()
      void options.persistWorkspaceState()
      return true
    }
    catch (error) {
      if (isSourceViewCurrent())
        setNormalizedError(error)
      return false
    }
    finally {
      isSending.value = false
    }
  }

  async function executeActionCommand(
    command: Extract<ParsedBuddyChatCommand, { kind: 'action' }>,
    contextItems: ReadonlyArray<LocalPromptContextItem>,
  ): Promise<boolean> {
    const conversationId = options.session.activeConversationId.value
    const branchId = options.session.activeBranchId.value
    const commandItems = contextItems.filter(item => item.kind === 'slashCommand')
    if (
      !conversationId
      || !branchId
      || contextItems.some(item => item.kind !== 'slashCommand')
      || commandItems.length > 1
      || (commandItems[0] && commandItems[0].value !== `/${command.name}`)
    ) {
      options.setErrorMessage(options.unavailableCommandMessage())
      return false
    }

    const sourceScopeKey = options.draftScopeKey.value
    const navigationVersion = options.session.generation()
    const isSourceViewCurrent = () => options.session.isCurrent(
      navigationVersion,
      conversationId,
      branchId,
    )
    isSending.value = true
    options.setErrorMessage(null)
    try {
      if (!await options.persistWorkspaceState())
        return false
      const confirmedDraft = options.drafts.snapshot(sourceScopeKey)
      if (!options.drafts.isPersisted(confirmedDraft)) {
        if (isSourceViewCurrent())
          options.setErrorMessage(options.draftChangedMessage())
        return false
      }
      const expectedRevision = confirmedDraft.revision!
      const operationKey = `command:${confirmedDraft.draftId}:${expectedRevision}`
      const requestId = requestIds.resolve(operationKey)
      const result = await options.api.chat.executeCommand({
        draftId: confirmedDraft.draftId,
        expectedRevision,
        requestId,
      })
      if (!result.draftReceipt)
        throw new Error('Command did not commit its Composer draft')
      requestIds.release(operationKey)
      options.composerTarget.complete(result.draftReceipt, sourceScopeKey, sourceScopeKey)
      if (isSourceViewCurrent()) {
        options.onActionCommandRunStarted(result.runId)
        options.runSync.applyRunStart(result)
      }
      if (result.run.status === 'failed' || result.run.status === 'cancelled') {
        if (
          isSourceViewCurrent()
          && result.run.errorCode !== 'CONTEXT_COMPACTION_NOT_NEEDED'
        ) {
          options.setErrorMessage(options.getRunTerminationMessage(result.run.errorCode))
        }
      }
      refreshTaskIndex()
      void options.persistWorkspaceState()
      return true
    }
    catch (error) {
      if (isSourceViewCurrent())
        setNormalizedError(error)
      return false
    }
    finally {
      isSending.value = false
    }
  }

  async function cancelActiveRun() {
    const run = options.activeRun.value
    if (!run || isDisposed)
      return
    const navigationVersion = options.session.generation()
    let sourceViewChanged = false
    const stopWatchingView = watch(
      () => [
        options.session.activeConversationId.value,
        options.session.activeBranchId.value,
        options.draftScopeKey.value,
      ],
      () => sourceViewChanged = true,
      { flush: 'sync' },
    )
    pendingCancellationWatches.add(stopWatchingView)
    const isSourceViewCurrent = () => !isDisposed && !sourceViewChanged
      && options.session.isCurrent(navigationVersion)
    try {
      const cancelled = await options.api.chat.cancel(run.id)
      if (isSourceViewCurrent())
        options.runSync.upsertRuns([cancelled])
    }
    catch (error) {
      if (isSourceViewCurrent())
        setNormalizedError(error)
    }
    finally {
      stopWatchingView()
      pendingCancellationWatches.delete(stopWatchingView)
    }
  }

  function refreshTaskIndex() {
    void options.taskIndexData.refreshIndex().catch(() => {})
  }

  function setNormalizedError(error: unknown) {
    options.setErrorMessage(resolveLocalChatErrorMessage(error, options.language.value))
  }

  return {
    ...queue,
    canSend: readonly(canSend),
    cancelActiveRun,
    isSending: readonly(isSending),
    send,
  }
}

function createActionCommandContent(
  command: Extract<ParsedBuddyChatCommand, { kind: 'action' }>,
): BuddyUserContentV1 {
  return {
    body: [{
      content: [
        {
          commandMode: 'action',
          directive: 'slash_command',
          type: 'prompt_directive',
          value: `/${command.name}`,
        },
        ...(command.arguments
          ? [{ text: ` ${command.arguments}`, type: 'text' as const }]
          : []),
      ],
      type: 'paragraph',
    }],
    panelResourceIds: [],
    version: 1,
  }
}
