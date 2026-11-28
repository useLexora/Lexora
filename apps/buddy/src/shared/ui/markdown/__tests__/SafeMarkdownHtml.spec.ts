// @vitest-environment jsdom
import type { MarkdownImageResolver, MarkdownRemoteImagePolicy } from '../markdownImage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef } from 'vue'
import ChatMarkdownBody from '../ChatMarkdownBody.vue'
import DesktopMarkdownContent from '../DesktopMarkdownContent.vue'
import { sanitizeMarkdownHtmlFragment } from '../safeMarkdownHtml'

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

async function mountDesktop(
  content: string,
  options: {
    resolveImage?: MarkdownImageResolver
    allowImages?: boolean
    remoteImages?: MarkdownRemoteImagePolicy
    final?: boolean
  } = {},
) {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(defineComponent({
    setup: () => () => h(DesktopMarkdownContent, {
      content,
      final: options.final ?? true,
      allowImages: options.allowImages ?? true,
      remoteImages: options.remoteImages ?? 'block',
      resolveImage: options.resolveImage,
      language: 'en-US',
      writeClipboardText: async () => {},
    }),
  }))
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  await nextTick()
  await Promise.resolve()
  await nextTick()
  return root
}

async function mountChatBody(content: string, options: { allowImages?: boolean } = {}) {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(defineComponent({
    setup: () => () => h(ChatMarkdownBody, {
      content,
      final: true,
      animate: false,
      allowImages: options.allowImages ?? true,
      isDark: false,
      writeClipboardText: async () => {},
    }),
  }))
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  await nextTick()
  await Promise.resolve()
  await nextTick()
  return root
}

describe('safe markdown html', () => {
  it('renders safe layout and inline HTML tags for documents and chat', async () => {
    const content = [
      '<h1 align="center">Lexora</h1>',
      '',
      '<p align="center"><strong>想你所想</strong> · <a href="https://uselexora.app/" target="_blank">官网</a></p>',
      '',
      'Press <kbd>Ctrl</kbd>+<kbd>C</kbd>, H<sub>2</sub>O, x<sup>2</sup>, <mark>hi</mark>, <u>u</u>, <del>old</del>, <ins>new</ins>.',
      '',
      '| A | B |',
      '| --- | --- |',
      '| line1<br>line2 | x<br/>y |',
      '',
      '<table><tr><td width="50%" valign="top" colspan="2"><h3>Card</h3><p>Body</p></td></tr></table>',
      '',
      '<details open>',
      '<summary>More details</summary>',
      '',
      'Nested **bold** text',
      '',
      '</details>',
    ].join('\n')

    const root = await mountDesktop(content)

    await vi.waitFor(() => {
      expect(root.querySelector('h1[align="center"]')?.textContent).toBe('Lexora')
      expect(root.querySelector('details[open]')).not.toBeNull()
    })

    const link = root.querySelector<HTMLAnchorElement>('a[href="https://uselexora.app/"]')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(root.querySelector('kbd')?.textContent).toBe('Ctrl')
    expect(root.querySelector('sub')?.textContent).toBe('2')
    expect(root.querySelector('sup')?.textContent).toBe('2')
    expect(root.querySelector('mark')?.textContent).toBe('hi')
    expect(root.querySelector('u')?.textContent).toBe('u')
    expect(root.querySelector('del')?.textContent).toBe('old')
    expect(root.querySelector('ins')?.textContent).toBe('new')
    expect(root.querySelectorAll('br').length).toBeGreaterThanOrEqual(2)

    const cell = root.querySelector('td[colspan="2"]')
    expect(cell?.getAttribute('width')).toBe('50%')
    expect(cell?.getAttribute('valign')).toBe('top')
    expect(cell?.querySelector('h3')?.textContent).toBe('Card')

    const details = root.querySelector('details')
    expect(details?.querySelector('summary')?.textContent).toBe('More details')
    expect(details?.querySelector('strong')?.textContent).toBe('bold')
  })

  it('hard-blocks dangerous tags, interactive controls, and unsafe attributes or protocols', async () => {
    const content = [
      '<script>window.__xss = 1</script>',
      '<style>body { display: none; }</style>',
      '<iframe src="https://evil.test"></iframe>',
      '<form action="https://evil.test"><button>Approve</button><input value="secret" /></form>',
      '<svg onload="alert(1)"><circle r="10" /></svg>',
      '<p style="position:fixed" class="spoof" id="top" data-x="1" onclick="alert(1)">Safe text</p>',
      '<p><a href="javascript:alert(1)">Bad link</a> <a href="file:///etc/passwd">File link</a> <img src="data:image/svg+xml,<svg/>" onerror="alert(1)" /></p>',
    ].join('\n\n')

    const root = await mountDesktop(content)
    await vi.waitFor(() => expect(root.textContent).toContain('Safe text'))

    expect(root.querySelector('script, style, iframe, form, button, input, svg')).toBeNull()
    expect(root.textContent).not.toContain('window.__xss')
    expect(root.textContent).not.toContain('display: none')
    expect(root.textContent).not.toContain('Approve')

    const paragraph = [...root.querySelectorAll('p')].find(p => p.textContent === 'Safe text')!
    expect(paragraph.getAttribute('style')).toBeNull()
    expect(paragraph.getAttribute('class')).toBeNull()
    expect(paragraph.getAttribute('id')).toBeNull()
    expect(paragraph.getAttribute('data-x')).toBeNull()
    expect(paragraph.getAttribute('onclick')).toBeNull()

    for (const anchor of root.querySelectorAll('a'))
      expect(anchor.getAttribute('href')).toBeNull()

    expect(root.querySelector('img')).toBeNull()
  })

  it('preserves unknown angle-bracket tags and generics as visible text', async () => {
    const content = 'Use Promise<User>, Array<string>, <YOUR_API_KEY>, and <MyComponent foo="1">bar</MyComponent>.'
    const root = await mountDesktop(content)

    await vi.waitFor(() => expect(root.textContent).toContain('Promise<User>'))
    expect(root.textContent).toContain('Array<string>')
    expect(root.textContent).toContain('<YOUR_API_KEY>')
    expect(root.textContent).toContain('<MyComponent foo="1">bar</MyComponent>')
    expect(root.querySelector('mycomponent')).toBeNull()
  })

  it('blocks HTML images when allowImages is false even without a desktop customId', async () => {
    const content = [
      '<p align="center"><img src="https://example.test/badge.png" alt="Badge" /><span>Keep text</span></p>',
      '<picture><source src="https://example.test/a.webp" /><img src="https://example.test/a.png" /></picture>',
    ].join('\n\n')

    const root = await mountChatBody(content, { allowImages: false })
    await vi.waitFor(() => expect(root.textContent).toContain('Keep text'))

    expect(root.querySelector('img, picture, source')).toBeNull()
  })

  it('resolves relative HTML images, loads https images with no-referrer when allowed, and degrades failures cleanly', async () => {
    const seen: string[] = []
    const content = [
      '<p align="center">',
      '  <img src="apps/website/src/public/favicon.png" width="112" height="112" alt="Lexora" />',
      '  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL-green" alt="License" /></a>',
      '  <img src="http://insecure.example/badge.png" alt="Insecure" />',
      '  <img src="missing/nope.png" alt="Missing" />',
      '</p>',
    ].join('\n')

    const root = await mountDesktop(content, {
      remoteImages: 'allow',
      resolveImage: (src) => {
        seen.push(src)
        return src.includes('favicon')
          ? { kind: 'local', src: 'lexora-file://media/?path=favicon.png' }
          : { kind: 'unavailable' }
      },
    })

    await vi.waitFor(() => {
      const local = root.querySelector<HTMLImageElement>('img[alt="Lexora"]')
      expect(local?.getAttribute('src')).toBe('lexora-file://media/?path=favicon.png')
    })

    const remote = root.querySelector<HTMLImageElement>('img[alt="License"]')
    expect(remote?.getAttribute('src')).toBe('https://img.shields.io/badge/license-AGPL-green')
    expect(remote?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(root.querySelector('img[alt="Insecure"]')).toBeNull()
    expect(root.querySelector('.buddy-markdown-html-img-blocked')?.textContent).toBe('Insecure')
    expect(root.querySelector('img[alt="Missing"]')).toBeNull()
    expect(root.textContent).toContain('Missing')
    expect(seen).toContain('apps/website/src/public/favicon.png')
    expect(seen).toContain('missing/nope.png')

    remote!.dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(root.querySelector('img[alt="License"]')).toBeNull())
    expect(root.querySelector('a[href="./LICENSE"]')?.textContent).toContain('License')
  })

  it('blocks remote HTML images by default while preserving surrounding links', async () => {
    const content = '<p align="center"><a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL-green" alt="License: AGPL-3.0-only" /></a></p>'
    const root = await mountDesktop(content)

    await vi.waitFor(() => expect(root.querySelector('.buddy-markdown-html-img-blocked')?.textContent).toBe('License: AGPL-3.0-only'))
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('a[href="./LICENSE"]')).not.toBeNull()
  })

  it('keeps streaming unclosed details readable and drops streaming scripts', async () => {
    const content = '<details>\n<summary>Streaming</summary>\n\n- step 1\n\n<script>alert(1)'
    const root = await mountDesktop(content, { final: false })

    await vi.waitFor(() => expect(root.querySelector('details summary')?.textContent).toBe('Streaming'))
    expect(root.querySelector('details li')?.textContent).toContain('step 1')
    expect(root.querySelector('script')).toBeNull()
    expect(root.textContent).not.toContain('alert(1)')
  })

  it('strips nested forbidden content while keeping sibling safe HTML intact', () => {
    const result = sanitizeMarkdownHtmlFragment(
      '<p>Before<form><button>Fake</button></form><UnknownTag a="1">mid</UnknownTag>After</p>',
      { allowImages: true },
    )
    const host = document.createElement('div')
    host.append(result.fragment)

    expect(host.querySelector('form, button')).toBeNull()
    expect(host.textContent).toBe('Before<UnknownTag a="1">mid</UnknownTag>After')
  })
})
