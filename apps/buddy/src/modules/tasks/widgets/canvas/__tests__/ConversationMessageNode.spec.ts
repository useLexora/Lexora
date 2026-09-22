// @vitest-environment jsdom
import type { Node } from '@antv/x6'
import type { ConversationCanvasData } from '../conversationCanvasContext'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, provide, shallowRef } from 'vue'
import { conversationCanvasActions } from '../conversationCanvasContext'
import ConversationMessageNode from '../ConversationMessageNode.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function createMockNode(data: ConversationCanvasData): Node {
  return {
    getData: () => data,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Node
}

function mountNode(data: ConversationCanvasData) {
  const root = document.createElement('div')
  document.body.append(root)

  const Provider = defineComponent({
    setup() {
      provide(conversationCanvasActions, {
        language: shallowRef('zh-CN' as const),
        active: shallowRef(true),
        selectedNodeId: shallowRef(null),
        open: vi.fn(),
        edit: vi.fn(),
        followup: vi.fn(),
        retry: vi.fn(),
        openArtifact: vi.fn(),
        openQuote: vi.fn(),
      })
      return () => h(ConversationMessageNode, { node: createMockNode(data) })
    },
  })

  const app = createApp(Provider)
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  return root
}

describe('conversationMessageNode header layout and actions', () => {
  it.each([
    { status: 'running' as const, text: '生成中' },
    { status: 'queued' as const, text: '准备中' },
  ])('places active busy %s status in top-right trailing container without actions (cannot mutate during run)', async ({ status, text }) => {
    const root = mountNode({
      direction: 'horizontal',
      canMutate: false,
      message: {
        id: 'answer:busy',
        branchId: 'branch:1',
        parentId: 'question:1',
        kind: 'answer',
        messageId: 'msg:1',
        runId: 'run:1',
        text: '生成中...',
        quotes: [],
        quoteCount: 0,
        attachments: [],
        attachmentCount: 0,
        artifacts: [],
        artifactCount: 0,
        metadata: null,
        status,
        active: true,
        toolCount: 11,
        attempts: [],
      },
    })
    await nextTick()

    const article = root.querySelector('article.conversation-node')!
    expect(article).not.toBeNull()
    expect(article.classList.contains(`status-${status}`)).toBe(true)
    expect(article.getAttribute('data-status')).toBe(status)

    const header = root.querySelector('.conversation-node__header')!
    expect(header).not.toBeNull()

    const tools = header.querySelector('.conversation-node__tools')
    expect(tools?.textContent).toBe('11 次工具调用')

    const trailing = header.querySelector('.conversation-node__trailing')
    expect(trailing).not.toBeNull()
    expect(trailing?.contains(tools)).toBe(false)

    // status is placed in top-right trailing container
    const statusEl = trailing?.querySelector('.conversation-node__status')
    expect(statusEl?.textContent).toBe(text)
    expect(statusEl?.classList.contains(status)).toBe(true)

    // active busy runs must NOT render actions toolbar (no retrying while generating)
    expect(trailing?.querySelector('.conversation-node__actions')).toBeNull()
  })

  it.each([
    { status: 'failed' as const, text: '失败' },
    { status: 'cancelled' as const, text: '已停止' },
  ])('places terminal %s status alongside retry action in the top-right', async ({ status, text }) => {
    const root = mountNode({
      direction: 'horizontal',
      canMutate: true,
      message: {
        id: `answer:${status}`,
        branchId: 'branch:1',
        parentId: 'question:1',
        kind: 'answer',
        messageId: 'msg:1',
        runId: 'run:1',
        text: '已终止回答',
        quotes: [],
        quoteCount: 0,
        attachments: [],
        attachmentCount: 0,
        artifacts: [],
        artifactCount: 0,
        metadata: null,
        status,
        active: false,
        toolCount: 2,
        attempts: [],
      },
    })
    await nextTick()

    const article = root.querySelector('article.conversation-node')!
    expect(article).not.toBeNull()
    expect(article.classList.contains(`status-${status}`)).toBe(true)
    expect(article.getAttribute('data-status')).toBe(status)

    const trailing = root.querySelector('.conversation-node__trailing')!
    expect(trailing).not.toBeNull()

    const statusEl = trailing.querySelector('.conversation-node__status')
    expect(statusEl?.textContent).toBe(text)
    expect(statusEl?.classList.contains(status)).toBe(true)

    // retry action is available for terminal failed/cancelled runs
    const actions = trailing.querySelector('.conversation-node__actions')
    expect(actions).not.toBeNull()
    expect(actions?.querySelector('[data-testid="canvas-node-retry"]')).not.toBeNull()
  })

  it('renders completed node with actions in trailing and no status text', async () => {
    const root = mountNode({
      direction: 'horizontal',
      canMutate: true,
      message: {
        id: 'answer:completed',
        branchId: 'branch:1',
        parentId: 'question:1',
        kind: 'answer',
        messageId: 'msg:1',
        runId: 'run:1',
        text: '已完成的回答',
        quotes: [],
        quoteCount: 0,
        attachments: [],
        attachmentCount: 0,
        artifacts: [],
        artifactCount: 0,
        metadata: null,
        status: 'completed',
        active: false,
        toolCount: 0,
        attempts: [],
      },
    })
    await nextTick()

    const trailing = root.querySelector('.conversation-node__trailing')!
    expect(trailing).not.toBeNull()
    expect(trailing.querySelector('.conversation-node__status')).toBeNull()
    expect(trailing.querySelector('.conversation-node__actions')).not.toBeNull()
    expect(trailing.querySelector('[data-testid="canvas-node-retry"]')).not.toBeNull()
    expect(trailing.querySelector('[data-testid="canvas-node-followup"]')).not.toBeNull()
  })

  it('renders draft node with status in trailing and no actions', async () => {
    const root = mountNode({
      direction: 'horizontal',
      canMutate: false,
      message: {
        id: 'draft:1',
        branchId: 'branch:1',
        parentId: 'answer:1',
        kind: 'draft',
        messageId: null,
        runId: null,
        text: '',
        quotes: [],
        quoteCount: 0,
        attachments: [],
        attachmentCount: 0,
        artifacts: [],
        artifactCount: 0,
        metadata: null,
        status: null,
        active: false,
        toolCount: 0,
        attempts: [],
      },
    })
    await nextTick()

    const trailing = root.querySelector('.conversation-node__trailing')!
    expect(trailing).not.toBeNull()
    const statusEl = trailing.querySelector('.conversation-node__status')
    expect(statusEl?.textContent).toBe('新追问')
    expect(trailing.querySelector('.conversation-node__actions')).toBeNull()
  })
})
