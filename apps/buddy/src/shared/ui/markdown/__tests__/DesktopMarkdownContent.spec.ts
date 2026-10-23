// @vitest-environment jsdom
import type { FileLinkMenuAction, FileLinkMenuProvider } from '../fileLinkMenu'
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function settle() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function menuItem(label: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(item => item.textContent === label)!
}

function clickMenuItem(label: string) {
  menuItem(label).querySelector<HTMLElement>('.n-dropdown-option-body__label')!.click()
}

function contextMenu(target: Element) {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })
  target.dispatchEvent(event)
  return event
}

function key(target: EventTarget, value: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

async function mount(options: {
  provider?: FileLinkMenuProvider
  noProvider?: boolean
  noErrorCallback?: boolean
  onLinkError?: (error: unknown) => void
} = {}) {
  const root = document.createElement('div')
  document.body.append(root)
  const selected = shallowRef('')
  const content = shallowRef('[**Report**](file:///tmp/report.md) [Second](./second.txt) [Website](https://example.test) [Email](mailto:hello@example.test) [Section](#section)')
  const linkErrors: unknown[] = []
  const appErrors: unknown[] = []
  let bubbled = 0
  const provider: FileLinkMenuProvider = options.provider ?? (async href => [
    { key: 'disabled', label: 'Unavailable', disabled: true, run: () => { selected.value = 'disabled' } },
    { key: 'open', label: 'Open file', run: () => { selected.value = href } },
    {
      key: 'more',
      label: 'More',
      children: [{ key: 'copy', label: 'Copy path', run: () => { selected.value = `copy:${href}` } }],
    },
  ])
  const app = createApp(defineComponent({
    setup: () => () => h('section', { onContextmenu: () => bubbled++ }, [
      h(DesktopMarkdownContent, {
        content: content.value,
        final: true,
        language: 'en-US',
        writeClipboardText: async () => {},
        fileLinkMenu: options.noProvider ? undefined : provider,
        onLinkError: options.noErrorCallback ? undefined : options.onLinkError ?? (error => linkErrors.push(error)),
        openWebLink: (href) => { selected.value = `web:${href}` },
        onOpenLink: (href) => { selected.value = `click:${href}` },
      }),
      h('output', selected.value),
    ]),
  }))
  app.config.errorHandler = error => appErrors.push(error)
  app.mount(root)
  let mounted = true
  const unmount = () => {
    if (!mounted)
      return
    mounted = false
    app.unmount()
    root.remove()
  }
  cleanups.push(unmount)
  await vi.waitFor(() => expect(root.querySelectorAll('a')).toHaveLength(5))
  return {
    root,
    content,
    selected,
    linkErrors,
    appErrors,
    bubbled: () => bubbled,
    unmount,
    link: (label: string) => [...root.querySelectorAll<HTMLAnchorElement>('a')].find(anchor => anchor.textContent === label)!,
  }
}

describe('markdown local file menus', () => {
  it('requires a real menu selection and binds the action to the href at invocation', async () => {
    const f = await mount()
    const anchor = f.link('Report')
    expect(contextMenu(anchor.querySelector('strong')!).defaultPrevented).toBe(true)
    await settle()
    expect(f.bubbled()).toBe(0)
    expect(f.root.querySelector('output')!.textContent).toBe('')
    expect(menuItem('Unavailable').getAttribute('aria-disabled')).toBe('true')
    clickMenuItem('Unavailable')
    await settle()
    expect(f.selected.value).toBe('')
    anchor.setAttribute('href', '/tmp/changed.md')
    clickMenuItem('Open file')
    await settle()
    expect(f.root.querySelector('output')!.textContent).toBe('file:///tmp/report.md')
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it.each([['ContextMenu', false], ['F10', true]] as const)('opens with %s and selects using the keyboard', async (name, shift) => {
    const f = await mount()
    const anchor = f.link('Report')
    anchor.focus()
    expect(key(anchor, name, shift).defaultPrevented).toBe(true)
    await settle()
    expect(menuItem('Open file')).toBeDefined()
    key(anchor, 'ArrowDown')
    await settle()
    key(anchor, 'Enter')
    await settle()
    expect(f.root.querySelector('output')!.textContent).toBe('file:///tmp/report.md')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(anchor)
  })

  it('renders nested actions and executes the selected child', async () => {
    const f = await mount()
    const anchor = f.link('Report')
    key(anchor, 'ContextMenu')
    await settle()
    key(anchor, 'ArrowDown')
    await settle()
    key(anchor, 'ArrowDown')
    await settle()
    key(anchor, 'ArrowRight')
    await settle()
    expect(menuItem('Copy path')).toBeDefined()
    key(anchor, 'Enter')
    await settle()
    expect(f.root.querySelector('output')!.textContent).toBe('copy:file:///tmp/report.md')
  })

  it.each(['Website', 'Email', 'Section'])('preserves the native context and keyboard interactions for %s', async (label) => {
    const f = await mount()
    expect(contextMenu(f.link(label)).defaultPrevented).toBe(false)
    expect(key(f.link(label), 'ContextMenu').defaultPrevented).toBe(false)
    expect(key(f.link(label), 'F10', true).defaultPrevented).toBe(false)
    await settle()
    expect(f.bubbled()).toBe(1)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    if (label === 'Website') {
      f.link(label).click()
      await settle()
      expect(f.root.querySelector('output')!.textContent).toBe('web:https://example.test')
    }
  })

  it('leaves local context menus alone without a provider and retains ordinary link activation', async () => {
    const f = await mount({ noProvider: true })
    expect(contextMenu(f.link('Report')).defaultPrevented).toBe(false)
    expect(key(f.link('Report'), 'ContextMenu').defaultPrevented).toBe(false)
    f.link('Report').click()
    await settle()
    expect(f.root.querySelector('output')!.textContent).toBe('click:file:///tmp/report.md')
  })

  it.each(['resolve', 'reject'] as const)('ignores an older request that later %ss while the newer menu is open', async (result) => {
    const first = deferred<readonly FileLinkMenuAction[]>()
    const second = deferred<readonly FileLinkMenuAction[]>()
    let selected = ''
    const f = await mount({ provider: href => href.includes('report') ? first.promise : second.promise })
    contextMenu(f.link('Report'))
    contextMenu(f.link('Second'))
    second.resolve([{ key: 'open', label: 'Open second', run: () => {
      selected = 'second'
    } }])
    await settle()
    if (result === 'resolve') {
      first.resolve([{ key: 'open', label: 'Open stale', run: () => {
        selected = 'stale'
      } }])
    }
    else {
      first.reject(new Error('Old menu failed'))
    }
    await settle()
    expect(menuItem('Open stale')).toBeUndefined()
    expect(f.linkErrors).toEqual([])
    clickMenuItem('Open second')
    await settle()
    expect(selected).toBe('second')
  })

  it.each(['escape', 'tab', 'pointer', 'context', 'content', 'unmount'])('does not reopen a pending menu after %s', async (dismiss) => {
    const pending = deferred<readonly FileLinkMenuAction[]>()
    const f = await mount({ provider: () => pending.promise })
    contextMenu(f.link('Report'))
    if (dismiss === 'escape')
      key(document, 'Escape')
    else if (dismiss === 'tab')
      key(document, 'Tab')
    else if (dismiss === 'pointer')
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    else if (dismiss === 'context')
      contextMenu(document.body)
    else if (dismiss === 'content')
      f.content.value = 'Changed content'
    else
      f.unmount()
    await settle()
    pending.resolve([{ key: 'open', label: 'Too late' }])
    await settle()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(f.linkErrors).toEqual([])
    expect(f.appErrors).toEqual([])
  })

  it('closes on provider failure and handles rejected actions through the owner callback', async () => {
    const failure = new Error('Action failed')
    const f = await mount({
      provider: async (href) => {
        if (href.includes('second'))
          throw new Error('Menu failed')
        return [{ key: 'fail', label: 'Fail action', run: async () => {
          throw failure
        } }]
      },
    })
    contextMenu(f.link('Second'))
    await settle()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(f.linkErrors).toEqual([])
    contextMenu(f.link('Report'))
    await settle()
    clickMenuItem('Fail action')
    await settle()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(f.linkErrors).toEqual([failure])
    expect(f.appErrors).toEqual([])
  })

  it.each(['pointer', 'keyboard'])('closes another Markdown instance before opening a new %s menu', async (gesture) => {
    const first = await mount()
    const second = await mount()
    contextMenu(first.link('Report'))
    await settle()
    if (gesture === 'pointer')
      contextMenu(second.link('Second'))
    else
      key(second.link('Second'), 'ContextMenu')
    await settle()
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
    clickMenuItem('Open file')
    await settle()
    expect(first.selected.value).toBe('')
    expect(second.selected.value).toBe('./second.txt')
  })

  it('forwards action failures to the Vue error handler when no callback is provided', async () => {
    const failure = new Error('Action failed')
    const f = await mount({
      noErrorCallback: true,
      provider: async () => [{ key: 'fail', label: 'Fail action', run: () => {
        throw failure
      } }],
    })
    contextMenu(f.link('Report'))
    await settle()
    clickMenuItem('Fail action')
    await settle()
    expect(f.appErrors).toEqual([failure])
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('does not report a late action failure after unmount', async () => {
    const pending = deferred<void>()
    const f = await mount({ provider: async () => [{ key: 'fail', label: 'Pending action', run: () => pending.promise }] })
    contextMenu(f.link('Report'))
    await settle()
    clickMenuItem('Pending action')
    await settle()
    f.unmount()
    pending.reject(new Error('Late action failure'))
    await settle()
    expect(f.linkErrors).toEqual([])
    expect(f.appErrors).toEqual([])
  })
})
