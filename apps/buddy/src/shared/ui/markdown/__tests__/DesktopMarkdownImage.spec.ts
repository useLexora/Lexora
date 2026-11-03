// @vitest-environment jsdom
import type { MarkdownImageResolution, MarkdownImageResolver } from '../markdownImage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef } from 'vue'
import DesktopMarkdownContent from '../DesktopMarkdownContent.vue'

vi.mock('naive-ui', () => vi.importActual('naive-ui/es/index.mjs'))
vi.mock('@/shared/ui/desktopUiContext', () => ({
  useDesktopUi: () => ({ isDark: shallowRef(false) }),
}))

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
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value() {} })
})

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

async function mount(content: string | (() => string), options: { resolveImage?: MarkdownImageResolver, allowImages?: boolean } = {}) {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(defineComponent({
    setup: () => () => h(DesktopMarkdownContent, {
      content: typeof content === 'function' ? content() : content,
      final: true,
      language: 'en-US',
      writeClipboardText: async () => {},
      ...options,
    }),
  }))
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  await vi.waitFor(() => expect(root.querySelector('p')).not.toBeNull())
  return root
}

describe('markdown local images', () => {
  it('loads an image through the resolved address and leaves other images to the stock renderer', async () => {
    const seen: string[] = []
    const root = await mount('![截图](截图/a.png)\n\n![远程](https://example.test/b.png)', {
      resolveImage: (src) => {
        seen.push(src)
        return src.startsWith('http') ? { kind: 'default' } : { kind: 'local', src: 'lexora-file://media/?path=a.png' }
      },
    })
    await vi.waitFor(() => expect(root.querySelectorAll('img')).toHaveLength(2))

    const [local, remote] = [...root.querySelectorAll('img')]
    expect(local!.getAttribute('src')).toBe('lexora-file://media/?path=a.png')
    expect(local!.getAttribute('alt')).toBe('截图')
    expect(local!.classList.contains('desktop-markdown-image')).toBe(true)
    expect(remote!.getAttribute('src')).toBe('https://example.test/b.png')
    expect(remote!.classList.contains('desktop-markdown-image')).toBe(false)
    expect(seen).toContain('%E6%88%AA%E5%9B%BE/a.png')
  })

  it('keeps failures local and retries without requesting the original relative URL', async () => {
    const url = 'lexora-file://media/?path=missing.png'
    const root = await mount('![截图](截图/a.png)', { resolveImage: () => ({ kind: 'local', src: url }) })
    await vi.waitFor(() => expect(root.querySelector('img.desktop-markdown-image')).not.toBeNull())
    root.querySelector('img')!.dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(root.querySelector('img')).toBeNull())
    expect(root.textContent).toContain('Image failed to load')
    root.querySelector('button')!.click()
    await vi.waitFor(() => expect(root.querySelector('img')?.getAttribute('src')).toBe(url))
  })

  it('ignores stale document resolutions and renders rejected local paths without an image', async () => {
    const content = shallowRef('![old](old.png)')
    let finishOld!: (value: MarkdownImageResolution) => void
    const old = new Promise<MarkdownImageResolution>(resolve => finishOld = resolve)
    const root = await mount(() => content.value, { resolveImage: src => src === 'old.png' ? old : { kind: 'unavailable' } })
    content.value = '![rejected](../../private.png)'
    await vi.waitFor(() => expect(root.textContent).toContain('Image failed to load'))
    finishOld({ kind: 'local', src: 'lexora-file://media/?path=old.png' })
    await nextTick()
    expect(root.querySelector('img')).toBeNull()
    expect(root.textContent).toContain('Image failed to load')
  })

  it('renders no image without a resolver rewrite and none when images are disabled', async () => {
    const plain = await mount('![截图](截图/a.png)')
    expect(plain.querySelector('img.desktop-markdown-image')).toBeNull()

    const disabled = await mount('![截图](截图/a.png)', { allowImages: false, resolveImage: () => ({ kind: 'local', src: 'lexora-file://media/?path=a.png' }) })
    expect(disabled.querySelector('img')).toBeNull()
  })
})
