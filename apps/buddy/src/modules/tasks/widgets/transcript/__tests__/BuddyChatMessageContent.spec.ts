import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'
// @vitest-environment jsdom

import { DEFAULT_DESKTOP_CHAT_PREFERENCES } from '@buddy-electron/shared/desktopApi'
import { describe, expect, it } from 'vitest'
import { createSSRApp, h, shallowRef } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { useProvideDesktopUi } from '@/shared/ui/desktopUiContext'
import BuddyChatMessageContent from '../BuddyChatMessageContent.vue'

describe('buddyChatMessageContent', () => {
  it('renders user messages as literal plain text', async () => {
    const text = '升级 @earendil-works/pi-ai@0.84.1，参考 **说明** 和 [版本](https://example.com)'
    const document = parseHtml(await renderMessage('user', text))

    expect(document.body.textContent).toBe(text)
    expect(document.querySelector('a, strong')).toBeNull()
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

  it.each([false, true])('renders inline-only snapshots once above the body and keeps named references readable (independent attachment: %s)', async (panel) => {
    const html = await renderStructuredUserMessage(panel)
    const document = parseHtml(html)
    const body = document.querySelector('.buddy-chat-message-content__structured-body')
    const reference = document.querySelector('[data-resource-id="resource-1"]')

    expect(body?.textContent).toContain('先看@reference.png后@reference.png')
    expect(reference?.textContent).toBe('@reference.png')
    expect(document.querySelectorAll('.buddy-chat-message-content__attachment')).toHaveLength(1)
    expect(document.querySelectorAll('.buddy-chat-resource-reference')).toHaveLength(2)
    expect(document.querySelector(reference!.getAttribute('href')!)).not.toBeNull()
    expect(document.querySelector('[data-material-key] img')?.getAttribute('src')).toBe('lexora-attachment://preview/attachment-1')
  })
})

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

async function renderMessage(role: LocalMessage['role'], text: string): Promise<string> {
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

  return renderContent(message)
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

function renderContent(message: LocalMessage) {
  return renderToString(createSSRApp({
    setup() {
      useProvideDesktopUi({
        userName: shallowRef(''),
        language: shallowRef('zh-CN'),
        isDark: shallowRef(false),
        appSidebarCollapsed: shallowRef(false),
        chat: shallowRef({ ...DEFAULT_DESKTOP_CHAT_PREFERENCES, permissionMode: 'policy_approval' }),
      })
      return () => h(BuddyChatMessageContent, {
        language: 'zh-CN',
        message,
        writeClipboardText: async () => {},
      })
    },
  }))
}
