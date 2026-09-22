import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'
// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createApp, createSSRApp, h, nextTick, shallowRef } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { useProvideDesktopUi } from '@/shared/ui/desktopUiContext'
import BuddyChatMessageContent from '../BuddyChatMessageContent.vue'
import { useProvideChatContent } from '../chatContentContext'

describe('buddyChatMessageContent', () => {
  it('renders user messages as literal plain text', async () => {
    const text = '升级 @earendil-works/pi-ai@0.84.1，参考 **说明** 和 [版本](https://example.com)'
    const html = await renderMessage('user', text)

    expect(html).toContain('@earendil-works/pi-ai@0.84.1')
    expect(html).toContain('**说明**')
    expect(html).toContain('[版本](https://example.com)')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('<strong>')
  })

  it('renders assistant Markdown links while leaving raw HTML inert', async () => {
    const html = await renderMessage('assistant', '参考 **说明** 和 [版本](https://example.com)，不要加载 <img src="https://example.com/pixel.png" alt="像素">')
    const document = parseHtml(html)
    const link = document.querySelector('a')

    expect(document.querySelector('strong')?.textContent).toBe('说明')
    expect(link?.textContent).toBe('版本')
    expect(link?.getAttribute('href')).toBe('https://example.com')
    expect(document.querySelector('img')).toBeNull()
    expect(document.body.textContent).toContain('<img src="https://example.com/pixel.png" alt="像素">')
  })

  it.each([false, true])('propagates the application dark mode to nested Markdown: %s', async (isDark) => {
    const html = await renderMessage('assistant', '- 外层列表\n\n  > 嵌套引用与 `code`', isDark)
    const roots = [...parseHtml(html).querySelectorAll('.markstream-vue')]
    expect(roots.length).toBeGreaterThan(1)
    for (const root of roots)
      expect(root.classList.contains('dark')).toBe(isDark)
  })

  it('renders a retired directive as plain text and keeps live directives highlighted', async () => {
    const document = parseHtml(await renderDirectiveMessage())
    const body = document.querySelector('.buddy-chat-message-content__structured-body')
    const retired = body?.querySelector('span')
    const directives = [...(body?.querySelectorAll('.buddy-chat-message-content__directive') ?? [])]

    expect(body?.textContent).toBe('/plan 与 /review')
    expect(retired?.getAttribute('class')).toBeNull()
    expect(retired?.textContent).toBe('/plan')
    expect(directives.map(element => element.textContent)).toEqual(['/review'])
  })

  it.each([false, true])('renders inline-only snapshots once above the body and keeps named references readable (independent attachment: %s)', async (panel) => {
    const html = await renderStructuredUserMessage(panel)
    const document = parseHtml(html)
    const body = document.querySelector('.buddy-chat-message-content__structured-body')
    const reference = document.querySelector('[data-resource-id="resource-1"]')

    expect(body?.textContent).toContain('先看@reference.png后@reference.png')
    expect(reference?.textContent).toBe('@reference.png')
    expect(document.querySelector('.buddy-chat-message-content__attachments')?.textContent)
      .toContain('reference.png')
    expect(document.querySelectorAll('.buddy-chat-message-content__attachment')).toHaveLength(1)
    expect(document.querySelectorAll('.buddy-chat-resource-reference')).toHaveLength(2)
    expect(reference?.getAttribute('aria-label')).toBe('定位附件 reference.png')
    expect(reference?.getAttribute('href')).toBe('#buddy-resource-resource-1')
    expect(document.getElementById('buddy-resource-resource-1')?.classList.contains('buddy-chat-message-content__attachment')).toBe(true)
    expect(document.querySelector('.buddy-chat-message-content__preview-trigger img')?.getAttribute('src')).toBe('lexora-attachment://preview/attachment-1')
    expect(html).toContain('attachment-1')
  })

  it('previews matching file link on click and opens external https link', async () => {
    const previewFile = vi.fn()
    const canPreviewFile = vi.fn((path: string) => path.includes('hello1.md'))
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      setup() {
        useProvideDesktopUi({
          language: shallowRef('zh-CN'),
          isDark: shallowRef(false),
          appSidebarCollapsed: shallowRef(false),
          chat: shallowRef({ outlinePosition: 'top-right', welcome: 'random' }),
        })
        useProvideChatContent({
          canPreviewFile,
          previewFile,
          writeClipboardText: async () => {},
        })
        return () => h(BuddyChatMessageContent, {
          language: 'zh-CN',
          message: {
            attachments: [],
            branchId: 'branch-1',
            content: '已将文件重命名为 [hello1.md](sandbox:/workspace/hello1.md)，请查看 [外部官网](https://example.com)',
            conversationId: 'conversation-1',
            createdAt: '2026-08-28T00:00:00.000Z',
            id: 'assistant-message',
            role: 'assistant',
            runId: null,
          } as LocalMessage,
          writeClipboardText: async () => {},
        })
      },
    })
    app.mount(container)
    await nextTick()

    const links = container.querySelectorAll('a')
    expect(links.length).toBeGreaterThanOrEqual(2)

    const fileLink = [...links].find(a => a.textContent === 'hello1.md')
    expect(fileLink).toBeDefined()
    fileLink!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(canPreviewFile).toHaveBeenCalledWith('sandbox:/workspace/hello1.md')
    expect(previewFile).toHaveBeenCalledWith('sandbox:/workspace/hello1.md')
    expect(openSpy).not.toHaveBeenCalled()

    const externalLink = [...links].find(a => a.textContent === '外部官网')
    expect(externalLink).toBeDefined()
    externalLink!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')

    app.unmount()
    container.remove()
    openSpy.mockRestore()
  })
})

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

async function renderMessage(role: LocalMessage['role'], text: string, isDark = false): Promise<string> {
  const message = {
    attachments: [],
    branchId: 'branch-1',
    content: text,
    conversationId: 'conversation-1',
    createdAt: '2026-08-28T00:00:00.000Z',
    id: `${role}-message`,
    role,
    runId: null,
  } as LocalMessage

  return renderContent(message, isDark)
}

async function renderStructuredUserMessage(panel: boolean): Promise<string> {
  const message = {
    attachments: [{
      attachmentId: 'attachment-1',
      kind: 'image',
      mimeType: 'image/png',
      name: 'reference.png',
      previewUrl: null,
      sizeBytes: 2048,
    }],
    branchId: 'branch-1',
    content: {
      resourceSnapshots: [{ attachmentId: 'attachment-1', resourceId: 'resource-1' }],
      userContent: {
        body: [{
          content: [
            { text: '先看', type: 'text' },
            { resourceId: 'resource-1', type: 'resource_ref' },
            { text: '后', type: 'text' },
            { resourceId: 'resource-1', type: 'resource_ref' },
          ],
          type: 'paragraph',
        }],
        panelResourceIds: panel ? ['resource-1'] : [],
        version: 1,
      },
    },
    conversationId: 'conversation-1',
    createdAt: '2026-08-28T00:00:00.000Z',
    id: 'user-structured-message',
    role: 'user',
    runId: null,
  } as LocalMessage

  return renderContent(message)
}

async function renderDirectiveMessage(): Promise<string> {
  const message = {
    attachments: [],
    branchId: 'branch-1',
    content: {
      resourceSnapshots: [],
      userContent: {
        body: [{
          content: [
            { commandMode: 'prompt', directive: 'slash_command', type: 'prompt_directive', value: '/plan' },
            { text: ' 与 ', type: 'text' },
            { commandMode: 'prompt', directive: 'slash_command', type: 'prompt_directive', value: '/review' },
          ],
          type: 'paragraph',
        }],
        panelResourceIds: [],
        version: 1,
      },
    },
    conversationId: 'conversation-1',
    createdAt: '2026-08-28T00:00:00.000Z',
    id: 'user-directive-message',
    role: 'user',
    runId: null,
  } as LocalMessage

  return renderContent(message)
}

function renderContent(message: LocalMessage, isDark = false) {
  return renderToString(createSSRApp({
    setup() {
      useProvideDesktopUi({
        language: shallowRef('zh-CN'),
        isDark: shallowRef(isDark),
        appSidebarCollapsed: shallowRef(false),
        chat: shallowRef({ outlinePosition: 'top-right', welcome: 'random' }),
      })
      return () => h(BuddyChatMessageContent, {
        language: 'zh-CN',
        message,
        writeClipboardText: async () => {},
      })
    },
  }))
}
