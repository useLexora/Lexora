// @vitest-environment jsdom
import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { TaskFile, TaskFileLink } from '@buddy-shared/files/taskFileApi'
import { taskFileMediaUrl } from '@buddy-shared/files/mediaPreview'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, shallowRef } from 'vue'
import { createChatImageResolver } from '@/modules/tasks/state/artifacts/createChatImageResolver'
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

it('preserves encoded local paths and leaves remote images to the existing renderer', async () => {
  const requests: TaskFileLink[] = []
  const f = mount('message', async (link) => {
    requests.push(link)
    return file(link.conversationId)
  }, '![Local](%E7%8C%AB%20%231%20%2520.png)\n\n![Remote](https://example.test/cat.png)')
  await vi.waitFor(() => expect(f.root.querySelectorAll('img')).toHaveLength(2))
  expect(requests).toEqual([{ conversationId: 'message-conversation', href: '%E7%8C%AB%20%231%20%2520.png' }])
  expect(f.root.querySelector('img[alt="Local"]')?.getAttribute('src')).toBe(taskFileMediaUrl(file('message-conversation').target))
  expect(f.root.querySelector('img[alt="Remote"]')?.getAttribute('src')).toBe('https://example.test/cat.png')
})

it('does not turn missing task ownership, directories or non-images into media URLs', async () => {
  const resolve = async () => file('task')
  expect(await createChatImageResolver(null, resolve)('cat.png')).toEqual({ kind: 'unavailable' })
  for (const src of ['https://example.test/cat.png', '//example.test/cat.png', 'data:image/png;base64,AA=='])
    expect(await createChatImageResolver('task', resolve)(src)).toEqual({ kind: 'default' })
  for (const invalid of [{ ...file('task'), kind: 'directory' as const }, { ...file('task'), mimeType: 'text/plain' }])
    expect(await createChatImageResolver('task', async () => invalid)('cat.png')).toEqual({ kind: 'unavailable' })
})
