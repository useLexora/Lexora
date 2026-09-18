// @vitest-environment jsdom
import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { PropType } from 'vue'
import type { ChatOutlineItem } from '../../../model/transcript/chatOutline'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { useProvideDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopChatTranscript from '../DesktopChatTranscript.vue'

vi.mock('../BuddyChatMessageList.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      props: {
        outlineItems: { type: Array as PropType<readonly ChatOutlineItem[]>, default: () => [] },
        outlineLoading: Boolean,
      },
      emits: ['prepareOutline'],
      setup(props, { emit }) {
        return () => h('div', [
          h('button', { onClick: () => emit('prepareOutline') }, 'outline'),
          h('output', { 'data-loading': String(props.outlineLoading) }, props.outlineItems.map(item => item.text).join('|')),
        ])
      },
    }),
  }
})

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

describe('desktopChatTranscript outline inputs', () => {
  it('prepares the full outline automatically with the current task loader', async () => {
    const fixture = mountTranscript(async () => [message('old', 'old loader')])
    await vi.waitFor(() => expect(fixture.output()).toBe('old loader'))
    fixture.props.value = {
      ...fixture.props.value,
      conversationId: 'conversation-2',
      activeBranchId: 'branch-2',
      loadOutlineMessages: async () => [message('new', 'replacement loader', 'conversation-2')],
    }

    await vi.waitFor(() => expect(fixture.output()).toBe('replacement loader'))
  })

  it('updates outline refs after task props change and ignores the old task response', async () => {
    const first = deferred<readonly LocalMessage[]>()
    const second = deferred<readonly LocalMessage[]>()
    const fixture = mountTranscript(() => first.promise)
    await nextTick()
    expect(fixture.loading()).toBe(true)
    fixture.props.value = {
      ...fixture.props.value,
      activeBranchId: 'branch-2',
      conversationId: 'conversation-2',
      loadOutlineMessages: () => second.promise,
    }
    await nextTick()
    expect(fixture.loading()).toBe(true)

    first.resolve([message('old', 'late old task')])
    await nextTick()
    expect(fixture.output()).toBe('')
    expect(fixture.loading()).toBe(true)
    second.resolve([message('new', 'current task', 'conversation-2')])

    await vi.waitFor(() => expect(fixture.output()).toBe('current task'))
    expect(fixture.loading()).toBe(false)
  })
})

function mountTranscript(loadOutlineMessages: () => Promise<readonly LocalMessage[]>) {
  const props = shallowRef({
    activeBranchId: 'branch-1',
    actionsDisabled: false,
    branches: [],
    changeSets: [],
    conversationId: 'conversation-1',
    editingMessageId: null,
    hasOlderMessages: false,
    isLoadingOlderMessages: false,
    language: 'zh-CN' as const,
    loadOutlineMessages,
    runEventBuckets: new Map(),
    runOutputs: [],
    runs: [],
    showReturnToLatest: false,
    timelineItems: [],
  })
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    setup() {
      useProvideDesktopUi({
        language: shallowRef('zh-CN'),
        isDark: shallowRef(false),
        appSidebarCollapsed: shallowRef(false),
        chat: shallowRef({ outlinePosition: 'top-right', welcome: 'random' }),
      })
      return () => h(DesktopChatTranscript, props.value)
    },
  })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  return {
    props,
    prepare: () => root.querySelector<HTMLButtonElement>('button')!.click(),
    loading: () => root.querySelector('output')?.getAttribute('data-loading') === 'true',
    output: () => root.querySelector('output')?.textContent,
  }
}

function message(id: string, text: string, conversationId = 'conversation-1'): LocalMessage {
  return {
    attachments: [],
    branchId: conversationId === 'conversation-1' ? 'branch-1' : 'branch-2',
    content: { text },
    conversationId,
    createdAt: '2026-09-08T00:00:00.000Z',
    id,
    role: 'user',
    runId: null,
  }
}
