// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { deferred } from '../../../../../__tests__/deferred'
import DesktopMediaPreview from '../DesktopMediaPreview.vue'

vi.mock('@/shared/ui/desktopUiContext', () => ({ useDesktopUi: () => ({ isDark: false }) }))
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mountMedia(src = 'lexora-artifact://media/first?v=1') {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const source = shallowRef(src)
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(() => h(DesktopMediaPreview, { kind: 'video', src: source.value, name: 'clip.mp4', language: 'zh-CN' }))
  app.mount(root)
  let mounted = true
  const stop = () => {
    if (mounted)
      app.unmount()
    mounted = false
    root.remove()
  }
  cleanups.push(stop)
  return { root, source, stop, fail: () => root.querySelector('video')!.dispatchEvent(new Event('error')) }
}

it('retries a missing media file with a new player URL and returns to playback', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
  const f = mountMedia()
  const before = f.root.querySelector('video')!
  f.fail()
  await vi.waitFor(() => expect(f.root.querySelector('[role="alert"]')?.textContent).toContain('文件已被移动或删除'))
  const retry = [...f.root.querySelectorAll('button')].find(button => button.textContent?.includes('重试'))!
  retry.click()
  await nextTick()
  const current = f.root.querySelector('video')!
  expect(current.src).not.toBe(before.src)
  expect(f.root.querySelector('[role="alert"]')).toBeNull()
  current.dispatchEvent(new Event('loadedmetadata'))
  await nextTick()
  expect(f.root.querySelector('[role="status"]')).toBeNull()
  expect(current.style.display).not.toBe('none')
})

it('cancels stale diagnostics on source change, retry and unmount', async () => {
  const first = deferred<Response>()
  const second = deferred<Response>()
  const third = deferred<Response>()
  const fetch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise)
  vi.stubGlobal('fetch', fetch)
  const f = mountMedia()
  const oldPlayer = f.root.querySelector('video')!
  f.fail()
  f.source.value = 'lexora-artifact://media/second?v=1'
  await nextTick()
  expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true)
  first.resolve(new Response(null, { status: 404 }))
  await nextTick()
  await nextTick()
  expect(f.root.querySelector('[role="alert"]')).toBeNull()
  oldPlayer.dispatchEvent(new Event('error'))
  expect(fetch).toHaveBeenCalledTimes(1)
  f.fail()
  await nextTick()
  f.root.querySelector('button')!.click()
  await nextTick()
  expect(fetch.mock.calls[1]![1].signal.aborted).toBe(true)
  second.resolve(new Response(null, { status: 403 }))
  await nextTick()
  await nextTick()
  expect(f.root.querySelector('[role="alert"]')).toBeNull()
  f.fail()
  f.stop()
  expect(fetch.mock.calls[2]![1].signal.aborted).toBe(true)
  third.resolve(new Response(null, { status: 413 }))
  await nextTick()
  expect(document.querySelector('[role="alert"]')).toBeNull()
})

it('retains the playback fallback without probing external media', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const f = mountMedia('https://example.com/video.mp4')
  f.fail()
  await vi.waitFor(() => expect(f.root.textContent).toContain('无法播放此文件'))
  expect(fetch).not.toHaveBeenCalled()
})
