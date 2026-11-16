// @vitest-environment jsdom
import type { TaskChatWorkspace } from '../../../contracts'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, shallowRef } from 'vue'
import BuddyChatActionToolbar from '../../transcript/BuddyChatActionToolbar.vue'
import { useProvideChatContent } from '../../transcript/chatContentContext'
import { useChatWorkspace } from '../useChatWorkspace'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

describe('workspace message branch navigation', () => {
  it.each(['editing', 'sending', 'mutating'] as const)('disables both arrows while %s and restores navigation afterwards', async (state) => {
    const fixture = mountNavigation()
    fixture[state].value = true
    await nextTick()
    expect(fixture.previous().disabled).toBe(true)
    expect(fixture.next().disabled).toBe(true)
    expect(fixture.position()).toBe('2 / 3')
    fixture.previous().click()
    fixture.next().click()
    expect(fixture.activeBranchId.value).toBe('branch-2')

    fixture[state].value = false
    await nextTick()
    expect(fixture.previous().disabled).toBe(false)
    expect(fixture.next().disabled).toBe(false)
    fixture.next().click()
    await nextTick()
    expect(fixture.activeBranchId.value).toBe('branch-3')
    expect(fixture.position()).toBe('3 / 3')
    expect(fixture.next().disabled).toBe(true)
  })

  it.each(['running', 'archived'] as const)('keeps branch browsing enabled while %s disables message mutations', async (state) => {
    const fixture = mountNavigation()
    fixture[state].value = true
    await nextTick()
    expect(fixture.edit().disabled).toBe(true)
    expect(fixture.previous().disabled).toBe(false)
    expect(fixture.next().disabled).toBe(false)
    fixture.previous().click()
    await nextTick()
    expect(fixture.activeBranchId.value).toBe('branch-1')
    expect(fixture.position()).toBe('1 / 3')
    expect(fixture.previous().disabled).toBe(true)
    expect(fixture.next().disabled).toBe(false)
    fixture.next().click()
    await nextTick()
    expect(fixture.activeBranchId.value).toBe('branch-2')
    expect(fixture.edit().disabled).toBe(true)
  })
})

function mountNavigation() {
  const editing = shallowRef(false)
  const sending = shallowRef(false)
  const mutating = shallowRef(false)
  const running = shallowRef(false)
  const archived = shallowRef(false)
  const activeBranchId = shallowRef('branch-2')
  const branchIds = ['branch-1', 'branch-2', 'branch-3']
  const workspace = {
    session: {
      activeBranchId,
      activeConversationId: shallowRef('conversation'),
      listActiveConversationMessages: async () => [],
    },
    execution: {
      canMutateBranch: computed(() => !editing.value && !sending.value && !mutating.value && !running.value && !archived.value),
      editingMessageId: computed(() => editing.value ? 'message' : null),
      isSending: sending,
      isMutatingBranch: mutating,
      submissionRevision: shallowRef(0),
    },
    status: { isLoading: shallowRef(false) },
    transcript: {
      branches: shallowRef([]),
      changeSets: shallowRef([]),
      hasOlderMessages: shallowRef(false),
      isLoadingOlderMessages: shallowRef(false),
      runEventBuckets: shallowRef(new Map()),
      runOutputs: shallowRef([]),
      runs: shallowRef([]),
      timelineItems: shallowRef([]),
    },
    language: shallowRef('zh-CN'),
    questions: { records: shallowRef([]) },
    welcomePreference: shallowRef('none'),
    welcomeItems: shallowRef([]),
  } as unknown as TaskChatWorkspace
  const root = document.createElement('div')
  document.body.append(root)
  const content = defineComponent({
    setup() {
      useProvideChatContent({
        openWebLink: () => {},
        canPreviewFile: () => false,
        previewFile: () => {},
        writeClipboardText: async () => {},
      })
      const { transcriptBindings } = useChatWorkspace({ workspace, revealMessageId: null }, shallowRef(null))
      return () => {
        const bindings = transcriptBindings.value!
        const index = branchIds.indexOf(activeBranchId.value)
        return h(BuddyChatActionToolbar, {
          actions: { disabled: bindings.actionsDisabled, showCopy: false, showEdit: true, showRegenerate: false, showFollowup: false, showTime: false },
          branchNavigationDisabled: bindings.branchNavigationDisabled,
          branchNavigator: { activeBranchId: activeBranchId.value, count: branchIds.length, index: index + 1, previousBranchId: branchIds[index - 1] ?? null, nextBranchId: branchIds[index + 1] ?? null },
          copyText: '',
          createdAt: '2026-10-01T00:00:00Z',
          language: 'zh-CN',
          role: 'user',
          targetKey: 'message',
          onActivateBranch: (branchId: string) => activeBranchId.value = branchId,
        })
      }
    },
  })
  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(content) }) })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  return {
    editing,
    sending,
    mutating,
    running,
    archived,
    activeBranchId,
    edit: () => root.querySelector<HTMLButtonElement>('[data-testid="edit-message"]')!,
    previous: () => root.querySelector<HTMLButtonElement>('[aria-label="上一条分支"]')!,
    next: () => root.querySelector<HTMLButtonElement>('[aria-label="下一条分支"]')!,
    position: () => root.querySelector('[role="group"] > span')?.textContent,
  }
}
