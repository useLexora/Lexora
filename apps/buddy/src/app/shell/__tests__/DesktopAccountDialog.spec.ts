// @vitest-environment jsdom
import type { ResolvedUserProfile } from '../userProfile'
import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import DesktopAccountDialog from '../DesktopAccountDialog.vue'

describe('desktopAccountDialog', () => {
  const mockResolvedProfile: ResolvedUserProfile = {
    avatarColor: '#4a72b0',
    avatarUrl: null,
    configPath: '/home/test/.lexora/config.toml',
    deviceName: 'test-host',
    initials: 'TU',
    isCustomAvatar: false,
    isCustomDeviceName: false,
    isCustomUserName: false,
    platform: 'linux',
    systemAvatarUrl: 'data:image/png;base64,system-avatar',
    systemDisplayName: 'Test User',
    systemHostname: 'test-host',
    systemUsername: 'testuser',
    userName: 'Test User',
  }

  it('renders streamlined dialog with avatar and inputs, without redundant system info or local ready tag', () => {
    const root = document.createElement('div')
    const app = createApp({
      render() {
        return h(DesktopAccountDialog, {
          customProfile: { avatar: '', deviceName: '', userName: '' },
          language: 'zh-CN',
          resolvedProfile: mockResolvedProfile,
          show: true,
          updateProfile: async () => true,
        })
      },
    })
    app.mount(root)

    // Form inputs and title are present
    expect(document.body.textContent).toContain('个人资料')
    expect(document.body.textContent).toContain('用户昵称')

    // Inputs have maxlength 30 and show-count
    const inputs = document.body.querySelectorAll('.desktop-account-dialog__form input')
    expect(inputs.length).toBe(1)
    expect(inputs[0]?.getAttribute('maxlength')).toBe('30')

    // Device name, redundant system boxes, and status tags are hidden/removed
    expect(document.body.textContent).not.toContain('设备名称')
    expect(document.body.textContent).not.toContain('操作系统')
    expect(document.body.textContent).not.toContain('本地就绪')
    expect(document.body.textContent).not.toContain('本地存储模式')
    expect(document.body.textContent).not.toContain('数据完整保存在本机')

    app.unmount()
  })

  it('emits update:show false when cancel is clicked', () => {
    const root = document.createElement('div')
    const onUpdateShow = vi.fn()
    const app = createApp({
      render() {
        return h(DesktopAccountDialog, {
          'customProfile': { avatar: '', deviceName: '', userName: '' },
          'language': 'zh-CN',
          'onUpdate:show': onUpdateShow,
          'resolvedProfile': mockResolvedProfile,
          'show': true,
          'updateProfile': async () => true,
        })
      },
    })
    app.mount(root)

    const buttons = document.body.querySelectorAll('button')
    const cancelButton = Array.from(buttons).find(b => b.textContent?.includes('取消'))
    expect(cancelButton).toBeDefined()
    cancelButton?.click()

    expect(onUpdateShow).toHaveBeenCalledWith(false)
    app.unmount()
  })

  it('keeps the dialog open and reports an error when saving fails', async () => {
    const root = document.createElement('div')
    const onUpdateShow = vi.fn()
    const updateProfile = vi.fn(async () => false)
    const app = createApp({
      render() {
        return h(DesktopAccountDialog, {
          'customProfile': { avatar: 'data:image/png;base64,custom-avatar', deviceName: '', userName: '' },
          'language': 'zh-CN',
          'onUpdate:show': onUpdateShow,
          'resolvedProfile': { ...mockResolvedProfile, avatarUrl: 'data:image/png;base64,custom-avatar', isCustomAvatar: true },
          'show': true,
          'updateProfile': updateProfile,
        })
      },
    })
    app.mount(root)

    const resetButton = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent?.includes('恢复默认头像'))
    resetButton?.click()
    await nextTick()

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent?.includes('保存更改'))
    saveButton?.click()
    await Promise.resolve()
    await nextTick()

    expect(updateProfile).toHaveBeenCalledWith({ avatar: '', userName: '' })
    expect(onUpdateShow).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('保存失败，请重试')
    app.unmount()
  })

  it('previews the system avatar after resetting a custom avatar', async () => {
    const root = document.createElement('div')
    const app = createApp({
      render() {
        return h(DesktopAccountDialog, {
          customProfile: { avatar: 'data:image/png;base64,custom-avatar', deviceName: '', userName: '' },
          language: 'zh-CN',
          resolvedProfile: { ...mockResolvedProfile, avatarUrl: 'data:image/png;base64,custom-avatar', isCustomAvatar: true },
          show: true,
          updateProfile: async () => true,
        })
      },
    })
    app.mount(root)

    const resetButton = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent?.includes('恢复默认头像'))
    resetButton?.click()
    await nextTick()

    expect(document.body.querySelector('.desktop-account-avatar__image')?.getAttribute('src'))
      .toBe('data:image/png;base64,system-avatar')
    app.unmount()
  })
})
