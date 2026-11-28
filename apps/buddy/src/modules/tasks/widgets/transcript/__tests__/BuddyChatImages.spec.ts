// @vitest-environment jsdom
import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { TaskFile, TaskFileLink } from '@buddy-shared/files/taskFileApi'
import { taskFileMediaUrl } from '@buddy-shared/files/mediaPreview'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { createChatImageResolver } from '@/modules/tasks/state/artifacts/createChatImageResolver'
import ChatInputImageThumbnail from '../../materials/ChatInputImageThumbnail.vue'
import BuddyChatMessageContent from '../BuddyChatMessageContent.vue'
import BuddyChatNarrationBody from '../BuddyChatNarrationBody.vue'
import { useProvideChatContent } from '../chatContentContext'

vi.mock('naive-ui', () => vi.importActual('naive-ui/es/index.mjs'))
vi.mock('@/modules/buddies', () => ({ useBuddyIdentity: () => shallowRef(null) }))
vi.mock('@/shared/ui/desktopUiContext', () => ({ useDesktopUi: () => ({ isDark: shallowRef(false) }) }))

beforeEach(() => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }))
})
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function file(conversationId: string): TaskFile {
  return { target: { conversationId, path: `/workspace/${conversationId}/cat.png` }, name: 'cat.png', kind: 'file', mimeType: 'image/png', sizeBytes: 20, updatedAt: '2026-08-28T00:00:00.000Z' }
}

function mount(kind: 'message' | 'narration', resolve: (link: TaskFileLink) => Promise<TaskFile>, content = '![Cat](cat.png)') {
  const root = document.createElement('div')
  document.body.append(root)
  const activeConversation = shallowRef('active-conversation')
  const message = shallowRef<LocalMessage>({
    attachments: [],
    branchId: 'branch-1',
    content,
    conversationId: 'message-conversation',
    createdAt: '2026-08-28T00:00:00.000Z',
    id: 'assistant-message',
    role: 'assistant',
    runId: 'message-run',
  })
  const app = createApp({
    setup() {
      useProvideChatContent({
        openWebLink() {},
        canPreviewFile: () => true,
        previewFile() {},
        writeClipboardText: async () => {},
        createImageResolver: conversationId => createChatImageResolver(conversationId ?? activeConversation.value, resolve),
      })
      return () => kind === 'message'
        ? h(BuddyChatMessageContent, { message: message.value, language: 'zh-CN', writeClipboardText: async () => {} })
        : h(BuddyChatNarrationBody, { text: content, language: 'zh-CN' })
    },
  })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  return { root, activeConversation, message }
}

it.each(['message', 'narration'] as const)('resolves %s images in their own task and ignores late results after the source changes', async (kind) => {
  let finish!: (value: TaskFile) => void
  const pending = new Promise<TaskFile>(resolve => finish = resolve)
  const requests: TaskFileLink[] = []
  const f = mount(kind, async (link) => {
    requests.push(link)
    return requests.length === 1 ? pending : file(link.conversationId)
  })
  const initial = kind === 'message' ? 'message-conversation' : 'active-conversation'
  await vi.waitFor(() => expect(requests).toEqual([{ conversationId: initial, href: 'cat.png' }]))
  expect(f.root.querySelector('img')).toBeNull()
  if (kind === 'message')
    f.message.value = { ...f.message.value, conversationId: 'next-conversation', runId: null }
  else
    f.activeConversation.value = 'next-conversation'
  const expected = taskFileMediaUrl(file('next-conversation').target)
  await vi.waitFor(() => expect(f.root.querySelector('img')?.getAttribute('src')).toBe(expected))
  finish(file(initial))
  await pending
  await vi.waitFor(() => {
    expect(f.root.querySelector('img')?.getAttribute('src')).toBe(expected)
    expect(f.root.querySelectorAll('img')).toHaveLength(1)
  })
})

it('keeps a resolved image mounted while later message text grows', async () => {
  const prefix = '![Cat](cat.png)\n\n'
  const f = mount('message', async ({ conversationId }) => file(conversationId), prefix)
  await vi.waitFor(() => expect(f.root.querySelector('img')?.getAttribute('src')).toBe(taskFileMediaUrl(file('message-conversation').target)))
  const image = f.root.querySelector('img')
  for (const tail of ['First paragraph.', 'First paragraph.\n\nSecond paragraph.']) {
    f.message.value = { ...f.message.value, content: prefix + tail }
    await vi.waitFor(() => expect(f.root.textContent).toContain(tail.split('\n\n').at(-1)))
    expect(f.root.querySelector('img')).toBe(image)
  }
})

it('keeps denied local images out of the browser and retries through the resolver', async () => {
  let denied = true
  const f = mount('message', async ({ conversationId }) => {
    if (denied)
      throw new Error('ACCESS_DENIED')
    return file(conversationId)
  })
  await vi.waitFor(() => expect(f.root.textContent).toContain('图片加载失败'))
  expect(f.root.querySelector('img')).toBeNull()
  denied = false
  f.root.querySelector('button')!.click()
  await vi.waitFor(() => expect(f.root.querySelector('img')?.getAttribute('src')).toBe(taskFileMediaUrl(file('message-conversation').target)))
})

it('preserves encoded local paths and blocks remote images in chat by default', async () => {
  const requests: TaskFileLink[] = []
  const f = mount('message', async (link) => {
    requests.push(link)
    return file(link.conversationId)
  }, '![Local](%E7%8C%AB%20%231%20%2520.png)\n\n![Remote](https://example.test/cat.png)')
  await vi.waitFor(() => expect(f.root.querySelectorAll('img')).toHaveLength(1))
  expect(requests).toEqual([{ conversationId: 'message-conversation', href: '%E7%8C%AB%20%231%20%2520.png' }])
  expect(f.root.querySelector('img[alt="Local"]')?.getAttribute('src')).toBe(taskFileMediaUrl(file('message-conversation').target))
  expect(f.root.querySelector('img[alt="Remote"]')).toBeNull()
  expect(f.root.querySelector('.desktop-markdown-image-blocked')?.textContent).toBe('Remote')
})

it('loads a sent photo only near the viewport and retries inside the same slot without a caption', async () => {
  let intersect!: (visible: boolean) => void
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      intersect = visible => callback([{ isIntersecting: visible }])
    }

    observe() {}
    disconnect() {}
  })
  const root = document.createElement('div')
  const app = createApp(ChatInputImageThumbnail, {
    src: 'lexora-attachment://preview/photo',
    name: 'photo.jpg',
    label: 'photo.jpg',
    detail: '2 KB',
    language: 'zh-CN',
    expanded: true,
  })
  try {
    app.mount(root)
    await nextTick()
    intersect(false)
    await nextTick()
    expect(root.querySelector('img')).toBeNull()
    intersect(true)
    await nextTick()
    expect(root.querySelector('[role="status"]')?.textContent).toContain('加载中')
    const img = root.querySelector('img')!
    expect(img.getAttribute('src')).toBe('lexora-attachment://preview/photo')
    img.dispatchEvent(new Event('error'))
    await nextTick()
    expect(root.querySelector('button')!.textContent).toContain('重试')
    root.querySelector('button')!.click()
    await nextTick()
    const retried = root.querySelector('img')!
    expect(retried).not.toBe(img)
    retried.dispatchEvent(new Event('load'))
    await nextTick()
    expect(root.querySelector('[role="status"]')).toBeNull()
    expect(root.textContent?.trim()).toBe('')
    expect(retried.alt).toBe('photo.jpg')
  }
  finally {
    app.unmount()
    vi.unstubAllGlobals()
  }
})

it('does not turn missing task ownership, directories or non-images into media URLs', async () => {
  const resolve = async () => file('task')
  expect(await createChatImageResolver(null, resolve)('cat.png')).toEqual({ kind: 'unavailable' })
  for (const src of ['https://example.test/cat.png', '//example.test/cat.png', 'data:image/png;base64,AA=='])
    expect(await createChatImageResolver('task', resolve)(src)).toEqual({ kind: 'default' })
  for (const invalid of [{ ...file('task'), kind: 'directory' as const }, { ...file('task'), mimeType: 'text/plain' }])
    expect(await createChatImageResolver('task', async () => invalid)('cat.png')).toEqual({ kind: 'unavailable' })
})
