// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApp, h } from 'vue'
import DesktopAccountAvatar from '../DesktopAccountAvatar.vue'

describe('desktopAccountAvatar', () => {
  it('renders an image when avatarUrl is provided', async () => {
    const root = document.createElement('div')
    const app = createApp({
      render() {
        return h(DesktopAccountAvatar, {
          avatarUrl: 'data:image/png;base64,sample',
          size: 'compact',
        })
      },
    })
    app.mount(root)

    const img = root.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,sample')
    expect(root.querySelector('.is-compact')).not.toBeNull()
    app.unmount()
  })

  it('renders initials with deterministic background when name is provided without avatarUrl', async () => {
    const root = document.createElement('div')
    const app = createApp({
      render() {
        return h(DesktopAccountAvatar, {
          name: 'shanyuhai',
          size: 'small',
        })
      },
    })
    app.mount(root)

    const initials = root.querySelector('.desktop-account-avatar__initials')
    expect(initials).not.toBeNull()
    expect(initials?.textContent?.trim()).toBe('S')
    app.unmount()
  })

  it('renders fallback icon when neither avatarUrl nor name is provided', async () => {
    const root = document.createElement('div')
    const app = createApp({
      render() {
        return h(DesktopAccountAvatar, {
          size: 'medium',
        })
      },
    })
    app.mount(root)

    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('.desktop-account-avatar__initials')).toBeNull()
    expect(root.querySelector('.desktop-account-avatar__portrait')).not.toBeNull()
    app.unmount()
  })
})
