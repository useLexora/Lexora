import type { DesktopChatWelcomePreference } from '@buddy-electron/shared/desktopApi'
import type { LocalBuddyServiceSupervisorState } from '@buddy-shared/runtime/serviceState'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { TaskChatWorkspace } from '../../../contracts'
import type { ChatApprovalDecision } from '../../../model/runs/typing'
import type { BuddyChatMessageListHandle } from '../../transcript/chatMessageViewport'
import type { ChatWorkspaceProps } from '../typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ChatComposerSubmitPayload } from '@/modules/prompt-input'
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick, shallowReactive, shallowRef } from 'vue'
import { createChatComposerContentFromText } from '@/modules/prompt-input'
import { useChatWorkspace } from '../useChatWorkspace'
import { useTaskComposer } from '../useTaskComposer'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function createOwner(name: string) {
  const delivered: { mode: 'send' | 'edit', content: string }[] = []
  const draft = shallowRef(`${name} draft`)
  const workspace = {
    executionTree: {
      groups: shallowRef({ byRoot: new Map(), byRun: new Map() }),
      records: shallowRef([]),
      revision: shallowRef(0),
      ready: shallowRef(true),
      conversationId: shallowRef(null),
      branchId: shallowRef(null),
      byParent: shallowRef(new Map()),
      target: record => ({ conversationId: 'conversation', branchId: 'branch', rootRunId: record.rootRunId, runId: record.runId }),
      onError: () => {},
      refresh: async () => {},
      api: {
        sendDraft: async () => { throw new Error('No draft') },
        list: async () => [],
        detail: async () => { throw new Error('No execution') },
        events: async () => ({ events: [], nextSequence: 0, hasMore: false }),
        send: async () => ({ accepted: true }),
        answer: async () => ({ accepted: true }),
        cancel: async () => ({ cancelled: true }),
        cancelChildren: async () => ({ cancelledRunIds: [] }),
        onChanged: () => () => {},
      },
    },
    marks: {
      items: shallowRef([]),
      states: shallowRef(new Map()),
      busy: shallowRef(false),
      loading: shallowRef(false),
      error: shallowRef(null),
      refresh: async () => {},
      save: async () => true,
      remove: async () => true,
      assign: async () => true,
      clear: async () => true,
      setRead: async () => true,
      readResult: async () => {},
      beginVisit: () => {},
    },
    tree: { data: shallowRef(null), loading: shallowRef(false), error: shallowRef(null), refresh: async () => {}, setVisible: () => {} },
    composer: {
      target: shallowRef({ kind: 'global' } as const),
      composerContent: shallowRef(createChatComposerContentFromText(draft.value)),
      contextUsage: shallowRef(null),
      draft,
      draftId: shallowRef(`${name}-draft`),
      editorKey: shallowRef(`${name}-editor`),
      resources: shallowRef([]),
      rejectedResourceIds: new Set<string>(),
      canUpdatePermissionSettings: shallowRef(true),
      isUpdatingPermissionSettings: shallowRef(false),
      isSelectingFiles: shallowRef(false),
      interaction: shallowRef(null),
      models: shallowRef([]),
      isLoadingModel: shallowRef(false),
      isUpdatingModel: shallowRef(false),
      providers: shallowRef([]),
      selectedEffort: shallowRef(null),
      selectedModel: shallowRef(null),
      selectedModelId: shallowRef(null),
      selectedServiceTier: shallowRef(null),
      permissionMode: shallowRef('manual_approval' as const),
      beginImport: () => [],
      importPastedText: async () => null,
      readResourceText: async () => '',
      dismissInteraction: () => {},
      listContextOptions: async () => ({ files: [], skills: [] }),
      retryResource: async () => {},
      selectAttachments: async () => {},
      selectModel: async () => {},
      selectSource: async () => null,
      setSelectedEffort: async () => {},
      setSelectedServiceTier: async () => {},
      setPermissionMode: async () => true,
      updateComposerContent: (text: string) => { draft.value = text },
    },
    execution: {
      isActorInput: shallowRef(false),
      queuedMessages: shallowRef([]),
      pendingQueueActions: shallowRef(new Set<string>()),
      cancelQueuedMessage: async () => {},
      steerQueuedMessage: async () => {},
      beginFollowup: async () => false,
      cancelFollowup: () => {},
      activeRun: shallowRef(null),
      stoppingRunId: shallowRef<string | null>(null),
      approvalViews: shallowRef([]),
      canMutateBranch: shallowRef(true),
      canSend: shallowRef(false),
      editingMessageId: shallowRef<string | null>(null),
      isMutatingBranch: shallowRef(false),
      isSending: shallowRef(false),
      resolvingApprovalActions: shallowRef(new Map<string, ChatApprovalDecision>()),
      resolvingApprovalIds: shallowRef(new Set<string>()),
      cancelActiveRun: async () => {},
      cancelEditUserMessage: () => {},
      editUserMessage: async () => true,
      regenerateAssistant: async () => true,
      resolveApproval: async () => {},
      send: async (payload: ChatComposerSubmitPayload | string) => {
        delivered.push({ mode: 'send', content: typeof payload === 'string' ? payload : payload.content })
        draft.value = ''
        return true
      },
      submitEditedMessage: async (payload: ChatComposerSubmitPayload) => {
        delivered.push({ mode: 'edit', content: payload.content })
        draft.value = ''
        return true
      },
    },
    language: shallowRef<BuddyLocale>('zh-CN'),
    welcomePreference: shallowRef<DesktopChatWelcomePreference>('writing'),
    welcomeItems: shallowRef([{ kind: 'preset' as const, id: 'writing' as const }]),
    welcomeEnabled: shallowRef(true),
    welcomeGreetingEnabled: shallowRef(true),
    welcomeCompanionEnabled: shallowRef(true),
    session: {
      members: { memberIds: shallowRef(['default']), busy: shallowRef(false), error: shallowRef(''), refresh: async () => {}, add: async () => true, remove: async () => true },
      selectedBuddyId: shallowRef<string | null>('default'),
      isSelectingBuddy: shallowRef(false),
      selectBuddy: async () => true,
      activeBranchId: shallowRef<string | null>(null),
      activeConversation: shallowRef(null),
      activeConversationId: shallowRef<string | null>(null),
      activeSpace: shallowRef<LocalSpace | null>(null),
      currentTitle: shallowRef(name),
      spaceId: shallowRef(null),
      listActiveConversationMessages: async () => [],
      openConversation: async () => {},
    },
    status: {
      isClosing: shallowRef(false),
      canRestartRuntime: shallowRef(false),
      errorMessage: shallowRef<string | null>(null),
      isLoading: shallowRef(true),
      runtimeError: shallowRef(null),
      runtimeState: shallowRef<LocalBuddyServiceSupervisorState>({ lastError: null, pid: null, restartAttempt: 0, status: 'starting' }),
      visibleChatBlocker: shallowRef(null),
      dismissChatBlocker: () => {},
      dismissError: () => {},
      restartRuntime: async () => true,
    },
    transcript: {
      branches: shallowRef([]),
      changeSets: shallowRef([]),
      hasOlderMessages: shallowRef(false),
      isLoadingOlderMessages: shallowRef(false),
      messages: shallowRef([]),
      runEventBuckets: shallowRef<TaskChatWorkspace['transcript']['runEventBuckets']['value']>(new Map()),
      runSignalEvents: shallowRef([]),
      runOutputs: shallowRef([]),
      runs: shallowRef([]),
      timelineItems: shallowRef([]),
      activateBranch: async () => true,
      loadOlderMessages: async () => false,
    },
    restoration: {
      state: shallowRef('ready' as const),
      conflict: shallowRef(null),
      restore: async () => {},
      resolveRemote: async () => true,
    },
    context: {
      getNodeDetail: async () => { throw new Error('Unused detail loader') },
      getChangeOverview: async () => { throw new Error('Unused fixture operation') },
      files: {
        listDirectory: async () => { throw new Error('Unused fixture operation') },
        readFile: async () => { throw new Error('Unused fixture operation') },
        revealFile: async () => { throw new Error('Unused fixture operation') },
      },
      getChangeSet: async () => { throw new Error('Unused fixture operation') },
      readArtifactText: async () => { throw new Error('Unused fixture operation') },
    },
  } satisfies TaskChatWorkspace
  return { delivered, workspace }
}

function bindWorkspace(owner: ReturnType<typeof createOwner>) {
  const props = shallowReactive<ChatWorkspaceProps>({
    revealMessageId: null,
    workspace: owner.workspace,
  })
  const scope = effectScope()
  const list = shallowRef<BuddyChatMessageListHandle | null>(null)
  const view = scope.run(() => useChatWorkspace(props, list))!
  cleanups.push(() => scope.stop())
  const composer = scope.run(() => useTaskComposer({
    focusReady: true,
    get composer() { return props.workspace.composer },
    get execution() { return props.workspace.execution },
    get language() { return props.workspace.language.value },
  }))!
  return { props, scope, view, composer, list }
}

describe('useChatWorkspace', () => {
  it('does not wait for an unmounted transcript while showing the canvas', async () => {
    const owner = createOwner('canvas')
    const { props, view } = bindWorkspace(owner)
    props.viewMode = 'canvas'
    owner.workspace.session.activeConversationId.value = 'conversation-canvas'
    owner.workspace.session.activeBranchId.value = 'branch-canvas'
    owner.workspace.status.isLoading.value = false
    await nextTick()
    expect(view.isLoading.value).toBe(false)
    props.viewMode = 'chat'
    expect(view.isLoading.value).toBe(true)
  })

  it('follows the tail again when the reader sends from a detached position', async () => {
    const owner = createOwner('send-follow')
    const { view, list } = bindWorkspace(owner)
    const metrics = { clientHeight: 400, scrollHeight: 1_000, scrollTop: 600 }
    list.value = {
      captureScrollAnchor: () => null,
      highlightMessage: () => {},
      readScrollMetrics: () => ({ ...metrics }),
      restoreScrollAnchor: () => null,
      scrollToMessage: () => null,
      scrollToTail: () => {
        metrics.scrollTop = metrics.scrollHeight - metrics.clientHeight
        return { ...metrics }
      },
    }
    owner.workspace.session.activeConversationId.value = 'conversation-send'
    owner.workspace.session.activeBranchId.value = 'branch-send'
    owner.workspace.status.isLoading.value = false
    await nextTick()
    await nextTick()
    expect(view.viewport.showReturnToLatest.value).toBe(false)

    metrics.scrollTop = 100
    view.viewport.handleScroll({ ...metrics })
    expect(view.viewport.showReturnToLatest.value).toBe(true)

    owner.workspace.execution.isSending.value = true
    await nextTick()
    await nextTick()

    expect(metrics.scrollTop).toBe(600)
    expect(view.viewport.showReturnToLatest.value).toBe(false)
  })

  it('isolates drafts, late updates, sends and edits when the workspace owner changes', async () => {
    const previous = createOwner('previous')
    const next = createOwner('next')
    const { props, view, composer } = bindWorkspace(previous)
    const { language } = view
    const { sendMessage } = composer
    next.workspace.language.value = 'en-US'
    props.workspace = next.workspace

    expect(composer.bindings.value.draft).toBe('next draft')
    expect(composer.bindings.value.draftId).toBe('next-draft')
    expect(language.value).toBe('en-US')
    await sendMessage({ content: 'new turn' })
    expect(next.delivered).toEqual([{ mode: 'send', content: 'new turn' }])
    expect(next.workspace.composer.draft.value).toBe('')
    expect(previous.delivered).toEqual([])
    expect(previous.workspace.composer.draft.value).toBe('previous draft')

    await Promise.resolve()
    previous.workspace.composer.draft.value = 'late previous draft'
    previous.workspace.language.value = 'en-US'
    next.workspace.composer.draft.value = 'updated next draft'
    next.workspace.language.value = 'zh-CN'
    await nextTick()

    expect(composer.bindings.value.draft).toBe('updated next draft')
    expect(language.value).toBe('zh-CN')

    next.workspace.execution.editingMessageId.value = 'message-edited'
    next.workspace.composer.draft.value = 'edited content'
    await sendMessage({ content: 'edited content' })

    expect(next.delivered).toEqual([
      { mode: 'send', content: 'new turn' },
      { mode: 'edit', content: 'edited content' },
    ])
    expect(next.workspace.composer.draft.value).toBe('')
    expect(previous.delivered).toEqual([])
  })
})
