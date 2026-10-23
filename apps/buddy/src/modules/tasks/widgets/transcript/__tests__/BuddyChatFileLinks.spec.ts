// @vitest-environment jsdom
import type { ContextPanelSource } from '@buddy-shared/context-panel/contextPanel'
import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'
import { DEFAULT_DESKTOP_CHAT_PREFERENCES } from '@buddy-electron/shared/desktopApi'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { useProvideDesktopUi } from '@/shared/ui/desktopUiContext'
import BuddyChatMessageContent from '../BuddyChatMessageContent.vue'
import BuddyChatNarrationBody from '../BuddyChatNarrationBody.vue'
import { useProvideChatContent } from '../chatContentContext'

vi.mock('naive-ui', () => vi.importActual('naive-ui/es/index.mjs'))

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

async function settle() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

async function mount(kind: 'message' | 'message-no-run' | 'narration', firstMenuGate?: Promise<void>) {
  const root = document.createElement('div')
  document.body.append(root)
  const content = '[Report](./report.md)'
  const message = shallowRef({
    attachments: [],
    branchId: 'branch-1',
    content,
    conversationId: 'message-conversation',
    createdAt: '2026-08-28T00:00:00.000Z',
    id: 'assistant-message',
    role: 'assistant',
    runId: kind === 'message-no-run' ? null : 'message-run',
  } as LocalMessage)
  const selected = shallowRef('')
  const fallbackSource: ContextPanelSource = { conversationId: 'injected-conversation', runId: 'injected-run' }
  let menuCount = 0
  const app = createApp({
    setup() {
      useProvideDesktopUi({
        userName: shallowRef(''),
        language: shallowRef('en-US'),
        isDark: shallowRef(false),
        appSidebarCollapsed: shallowRef(false),
        chat: shallowRef(DEFAULT_DESKTOP_CHAT_PREFERENCES),
      })
      useProvideChatContent({
        openWebLink: () => {},
        canPreviewFile: () => true,
        writeClipboardText: async () => {},
        previewFile: (href, source) => {
          selected.value = JSON.stringify({ href, source: source ?? fallbackSource })
        },
        fileLinkMenu: async (href, source) => {
          if (++menuCount === 1)
            await firstMenuGate
          return [{
            key: 'open',
            label: 'Open report',
            run: () => {
              selected.value = JSON.stringify({ href, source: source ?? fallbackSource })
            },
          }]
        },
      })
      return () => h('div', [
        kind === 'narration'
          ? h(BuddyChatNarrationBody, { language: 'en-US', text: content })
          : h(BuddyChatMessageContent, { message: message.value, language: 'en-US', writeClipboardText: async () => {} }),
        h('output', selected.value),
      ])
    },
  })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  await vi.waitFor(() => expect(root.querySelector('a')).not.toBeNull())
  return {
    root,
    message,
    selected,
    openMenu: async () => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      root.querySelector('a')!.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      await settle()
    },
    choose: async () => {
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Open report')!
      item.querySelector<HTMLElement>('.n-dropdown-option-body__label')!.click()
      await settle()
    },
    result: () => JSON.parse(root.querySelector('output')!.textContent!),
  }
}

it('uses the message source and discards a menu requested for a replaced message source', async () => {
  let resolve!: () => void
  const gate = new Promise<void>((done) => {
    resolve = done
  })
  const f = await mount('message', gate)
  f.root.querySelector('a')!.click()
  await settle()
  expect(f.result()).toEqual({ href: './report.md', source: { conversationId: 'message-conversation', runId: 'message-run' } })
  await f.openMenu()
  f.message.value = { ...f.message.value, conversationId: 'other-conversation', runId: 'other-run' }
  await nextTick()
  resolve()
  await settle()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  await f.openMenu()
  await f.choose()
  expect(f.result()).toEqual({ href: './report.md', source: { conversationId: 'other-conversation', runId: 'other-run' } })
})

it.each(['message-no-run', 'narration'] as const)('keeps the injected source for %s', async (kind) => {
  const f = await mount(kind)
  f.root.querySelector('a')!.click()
  await settle()
  expect(f.result()).toEqual({ href: './report.md', source: { conversationId: 'injected-conversation', runId: 'injected-run' } })
  f.selected.value = ''
  await f.openMenu()
  await f.choose()
  expect(f.result()).toEqual({ href: './report.md', source: { conversationId: 'injected-conversation', runId: 'injected-run' } })
})
