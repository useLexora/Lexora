// @vitest-environment jsdom
import type { Node } from '@antv/x6'
import type { ConversationCanvasData } from '../conversationCanvasContext'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, provide, shallowRef } from 'vue'
import { conversationCanvasActions, conversationCanvasRendering } from '../conversationCanvasContext'
import ConversationMessageNode from '../ConversationMessageNode.vue'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.useRealTimers()
})

function createMockNode(data: ConversationCanvasData): Node {
  return {
    getData: () => data,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Node
}

function mountNode(data: ConversationCanvasData, rendering = { simplified: shallowRef(false), interacting: shallowRef(false) }, active = shallowRef(true)) {
  const root = document.createElement('div')
  document.body.append(root)

  const Provider = defineComponent({
    setup() {
      provide(conversationCanvasRendering, rendering)
      provide(conversationCanvasActions, {
        language: shallowRef('zh-CN' as const),
        active,
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

function richNode(): ConversationCanvasData {
  return {
    direction: 'horizontal',
    canMutate: true,
    message: {
      id: 'answer:rich',
      branchId: 'branch:1',
      parentId: null,
      kind: 'answer',
      messageId: 'msg:1',
      runId: 'run:1',
      text: '第一行摘要\n第二行正文',
      quotes: [],
      quoteCount: 1,
      attachments: [],
      attachmentCount: 1,
      artifacts: [],
      artifactCount: 1,
      metadata: { modelId: 'model:1', startedAt: '2026-10-08T00:00:00.000Z', completedAt: null, usage: null },
      status: 'running',
      active: true,
      toolCount: 2,
      attempts: [],
    },
  }
}

describe('conversationMessageNode simplified rendering', () => {
  it('removes resource sections and footer without replacing the node, then restores them', async () => {
    const rendering = { simplified: shallowRef(true), interacting: shallowRef(false) }
    const root = mountNode(richNode(), rendering)
    const article = root.querySelector('article')!
    expect(article.classList.contains('active-branch')).toBe(true)
    expect(root.querySelector('.conversation-node__summary-text')?.textContent).toBe('第一行摘要 第二行正文')
    expect(root.querySelector('.conversation-node__body')).toBeNull()
    expect(root.querySelector('.conversation-node__footer')).toBeNull()
    expect(root.querySelector('.conversation-node__status.running')).not.toBeNull()
    rendering.simplified.value = false
    await nextTick()
    expect(root.querySelector('article')).toBe(article)
    for (const section of ['attachments', 'quotes', 'artifacts', 'footer'])
      expect(root.querySelector(`.conversation-node__${section}`)).not.toBeNull()
  })

  it('pauses the busy clock while hidden, interacting or simplified, then resumes', async () => {
    vi.useFakeTimers()
    const rendering = { simplified: shallowRef(false), interacting: shallowRef(false) }
    const active = shallowRef(true)
    mountNode(richNode(), rendering, active)
    expect(vi.getTimerCount()).toBe(1)
    active.value = false
    await nextTick()
    expect(vi.getTimerCount()).toBe(0)
    active.value = true
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)
    rendering.interacting.value = true
    await nextTick()
    expect(vi.getTimerCount()).toBe(0)
    rendering.interacting.value = false
    rendering.simplified.value = true
    await nextTick()
    expect(vi.getTimerCount()).toBe(0)
    rendering.simplified.value = false
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)
  })
})

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
