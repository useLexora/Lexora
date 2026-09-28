// @vitest-environment jsdom
import type { Ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { useProvideDesktopUi } from '@/shared/ui/desktopUiContext'
import { BRAND_ASSET_URLS } from '@/shared/branding/brandAssets'
import BuddyChatAgentIdentity from '../BuddyChatAgentIdentity.vue'

interface AgentIdentityInput {
  avatar: string
  avatarColor: string | null
  initials: string | null
  name: string
}

function render(agentIdentity: Ref<AgentIdentityInput>) {
  const root = document.createElement('div')
  const app = createApp({
    setup() {
      useProvideDesktopUi({
        language: shallowRef('zh-CN'),
        isDark: shallowRef(false),
        sidebarCollapsed: shallowRef(false),
        chat: shallowRef({ outlinePosition: 'top-right', permissionMode: 'policy_approval', welcome: 'random' }),
        agentIdentity,
      })
      return () => h(BuddyChatAgentIdentity, { language: 'zh-CN' })
    },
  })
  app.mount(root)
  return { app, root }
}

function identity(overrides: Partial<AgentIdentityInput> = {}): AgentIdentityInput {
  return { avatar: '', avatarColor: null, initials: null, name: '', ...overrides }
}

describe('buddyChatAgentIdentity', () => {
  it('falls back to the brand avatar and default name', async () => {
    const { app, root } = render(shallowRef(identity()))
    await nextTick()

    expect(root.querySelector('img')?.getAttribute('src')).toBe(BRAND_ASSET_URLS.chatAvatar)
    expect(root.querySelector('.buddy-chat-agent-identity__name')?.textContent.trim()).toBe('Lexora Buddy')

    app.unmount()
  })

  it('renders the configured agent name and avatar', async () => {
    const { app, root } = render(shallowRef(identity({ avatar: 'data:image/png;base64,abc', name: '小助手' })))
    await nextTick()

    expect(root.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,abc')
    expect(root.querySelector('.buddy-chat-agent-identity__name')?.textContent.trim()).toBe('小助手')

    app.unmount()
  })

  it('mirrors the profile initials avatar when syncing with the user profile', async () => {
    const { app, root } = render(shallowRef(identity({ avatarColor: '#4a72b0', initials: 'AQ', name: 'Ayong Q' })))
    await nextTick()

    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('.buddy-chat-agent-identity__initials')?.textContent.trim()).toBe('AQ')
    expect(root.querySelector('.buddy-chat-agent-identity__avatar')?.getAttribute('style')).toContain('rgb(74, 114, 176)')
    expect(root.querySelector('.buddy-chat-agent-identity__name')?.textContent.trim()).toBe('Ayong Q')

    app.unmount()
  })
})
