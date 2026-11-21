// @vitest-environment jsdom
import type { ReaderActionInput, ReaderMessage } from '../readerProtocol'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { readerTurnWindowKey } from '../readerLoadingPolicy'
import ReaderMessageView from '../ReaderMessage.vue'
import { readerActionSchema } from '../readerProtocol'
import { readerLanguageKey } from '../readerStrings'

type Resource = ReaderMessage['resources'][number]
const thumbnail = `https://appassets.androidplatform.net/artifacts/${'a'.repeat(64)}.png`
const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.splice(0).forEach(fn => fn())
  vi.unstubAllGlobals()
})

async function mount(turnWindow = false) {
  let intersect: (near: boolean) => void
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      intersect = near => callback([{ isIntersecting: near }])
    }

    observe() {}
    disconnect() {}
  })
  const photo = shallowRef<NonNullable<Resource['photo']>>({ revision: 'v1', status: 'idle' })
  const image = { id: 'attachment:photo', name: 'camera.jpg', description: 'Image · 18 KB', available: true }
  const file = { id: 'attachment:doc', name: 'notes.txt', description: 'Text · 1 KB', available: true }
  const actions: ReaderActionInput[] = []
  const app = createApp({
    render: () => h(ReaderMessageView, {
      message: {
        id: 'msg',
        runId: null,
        role: 'user',
        authorId: null,
        author: '',
        text: 'caption',
        final: true,
        markdown: false,
        interrupted: false,
        truncated: false,
        showIdentity: false,
        intermediate: false,
        toolName: null,
        toolSummary: '',
        toolTitle: '',
        toolError: false,
        needsDetail: false,
        loading: false,
        error: null,
        notice: null,
        hasDetail: false,
        detailResource: null,
        actionsVisible: true,
        canEdit: false,
        canRegenerate: false,
        canFollowup: false,
        canCopy: true,
        resources: [{ ...image, photo: photo.value }, file],
      },
      send: action => actions.push(action),
      dark: false,
    }),
  })
  app.provide(readerLanguageKey, shallowRef('en'))
  app.provide(readerTurnWindowKey, shallowRef(turnWindow))
  const root = document.createElement('div')
  root.className = 'reader-viewport'
  document.body.append(root)
  app.mount(root)
  cleanup.push(() => {
    app.unmount()
    root.remove()
  })
  await nextTick()
  async function visible(near: boolean) {
    intersect?.(near)
    await nextTick()
  }
  return { root, photo, actions, visible }
}

it('opens a versioned photo from its filename without fetching it on a compact connection; a cached thumbnail stays visible', async () => {
  const { root, actions, photo, visible } = await mount(true)
  await visible(true)
  const button = root.querySelector<HTMLButtonElement>('.resource-link')!
  expect(button.textContent).toContain('camera.jpg')
  expect(actions).toEqual([])
  button.click()
  expect(actions).toEqual([{ action: 'resource', id: 'msg', resourceId: 'attachment:photo', revision: 'v1' }])
  photo.value = { ...photo.value, status: 'ready', thumbnail }
  await nextTick()
  await visible(true)
  expect(root.querySelector('img')?.src).toBe(thumbnail)
  expect(actions).toHaveLength(1)
})

it('requests only near the viewport, keeps retry inside the slot and preserves native preview for both kinds of file', async () => {
  const { root, photo, actions, visible } = await mount()
  await visible(false)
  expect(actions).toEqual([])
  const slot = root.querySelector<HTMLElement>('.message-photo')!
  await visible(true)
  const request = { action: 'photo-thumbnail', id: 'msg', resourceId: 'attachment:photo', revision: 'v1' }
  expect(actions).toEqual([request])
  photo.value = { ...photo.value, status: 'loading' }
  await nextTick()
  expect(slot.querySelector('[role="status"]')?.getAttribute('aria-label')).toContain('Loading image')
  photo.value = { ...photo.value, status: 'failed' }
  await nextTick()
  await visible(false)
  await visible(true)
  expect(actions).toEqual([request])
  expect(slot.textContent).toContain('Image unavailable')
  slot.querySelector<HTMLButtonElement>('.photo-retry')!.click()
  expect(actions.at(-1)).toEqual({ ...request, retry: true })
  photo.value = { ...photo.value, status: 'ready', thumbnail }
  await nextTick()
  const img = slot.querySelector('img')!
  expect(img.src).toBe(thumbnail)
  img.dispatchEvent(new Event('load'))
  await nextTick()
  const preview = slot.querySelector<HTMLButtonElement>('.photo-preview')!
  expect(preview.getAttribute('aria-label')).toContain('camera.jpg · Image · 18 KB')
  preview.click()
  const ordinary = root.querySelector<HTMLButtonElement>('.resource-link')!
  expect(ordinary.textContent).toContain('notes.txt')
  ordinary.click()
  expect(actions.slice(-2)).toEqual([
    { action: 'resource', id: 'msg', resourceId: 'attachment:photo', revision: 'v1' },
    { action: 'resource', id: 'msg', resourceId: 'attachment:doc' },
  ])
  img.dispatchEvent(new Event('error'))
  await nextTick()
  expect(slot.querySelector('img')).toBeNull()
  slot.querySelector<HTMLButtonElement>('.photo-retry')!.click()
  await nextTick()
  expect(slot.querySelector('img')?.src).toBe(thumbnail)
  expect(actions.every(action => readerActionSchema.safeParse({ ...action, topic: 'task' }).success)).toBe(true)
})
