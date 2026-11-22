// @vitest-environment jsdom
import type { DesktopAppInfo } from '@buddy-electron/shared/desktopApi'
import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import DesktopTitleBar from '../window/DesktopTitleBar.vue'

vi.mock('naive-ui', async () => {
  const { defineComponent, h: createVNode } = await import('vue')
  return {
    NDropdown: defineComponent({
      name: 'NDropdown',
      setup(_, { slots }) {
        return () => createVNode('div', { class: 'mock-dropdown' }, slots.default?.())
      },
    }),
    NIcon: defineComponent({
      name: 'NIcon',
      setup(_, { slots }) {
        return () => createVNode('span', { class: 'mock-icon' }, slots.default?.())
      },
    }),
    NModal: defineComponent({
      name: 'NModal',
      props: { show: Boolean },
      setup(props, { slots }) {
        return () => props.show ? createVNode('div', { class: 'mock-modal' }, slots.default?.()) : null
      },
    }),
    NTooltip: defineComponent({
      name: 'NTooltip',
      setup(_, { slots }) {
        return () => createVNode('div', { class: 'mock-tooltip' }, slots.trigger?.())
      },
    }),
    useMessage: () => ({
      error: vi.fn(),
    }),
  }
})

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}))

vi.mock('@/app/workbench/desktopWorkbenchContext', () => ({
  useDesktopWorkbenchContext: () => ({
    controller: {
      registry: {
        register: vi.fn(() => vi.fn()),
      },
    },
  }),
}))

vi.mock('@/modules/updates', () => ({
  useDesktopUpdatesContext: () => ({
    check: vi.fn(),
  }),
}))

vi.mock('@/platform/desktop/desktopApi', () => ({
  requireDesktopApi: () => ({
    app: {
      openFeedbackIssue: vi.fn(),
    },
    commands: {
      execute: vi.fn(),
    },
    window: {
      getState: vi.fn().mockResolvedValue({ isMaximized: false }),
      minimize: vi.fn(),
      onStateChanged: vi.fn(() => vi.fn()),
      toggleMaximize: vi.fn().mockResolvedValue({ isMaximized: true }),
    },
  }),
}))

function createAppInfo(platform: DesktopAppInfo['platform']): DesktopAppInfo {
  return {
    arch: 'x64',
    chromeVersion: '134.0.0',
    electronVersion: '35.0.0',
    isPackaged: false,
    name: 'Lexora Buddy',
    nodeVersion: '22.0.0',
    platform,
    version: '0.20.0',
  }
}

function mountTitleBar(options: {
  contextAvailable?: boolean
  contextOpen?: boolean
  platform: DesktopAppInfo['platform']
  sidebarCollapsed?: boolean
}) {
  const root = document.createElement('div')
  const app = createApp({
    render() {
      return h(DesktopTitleBar, {
        appInfo: createAppInfo(options.platform),
        contextAvailable: options.contextAvailable ?? true,
        contextOpen: options.contextOpen ?? true,
        language: 'zh-CN',
        shortcutBindings: {},
        sidebarCollapsed: options.sidebarCollapsed ?? false,
        sidebarTarget: 'app',
      })
    },
  })
  app.mount(root)
  return { app, root }
}

describe('desktopTitleBar', () => {
  it('hides custom window control buttons on win32 and enables native overlay layout class', async () => {
    const { app, root } = mountTitleBar({
      contextOpen: true,
      platform: 'win32',
      sidebarCollapsed: false,
    })
    await nextTick()

    const header = root.querySelector('.desktop-title-bar')
    expect(header?.classList.contains('is-native-controls')).toBe(true)
    expect(header?.classList.contains('is-win-native-controls')).toBe(true)
    expect(header?.classList.contains('is-mac-native-controls')).toBe(false)
    expect(root.querySelector('[data-window-control-icon="minimize"]')).toBeNull()
    expect(root.querySelector('[data-window-control-icon="maximize"]')).toBeNull()
    expect(root.querySelector('[data-window-control-icon="close"]')).toBeNull()

    const sidebarButton = root.querySelector('.desktop-window-menu__sidebar-trigger')
    expect(sidebarButton?.getAttribute('aria-expanded')).toBe('true')
    expect(root.querySelector('[data-testid="context-panel-toggle"]')?.classList.contains('is-active')).toBe(true)

    app.unmount()
  })

  it('hides custom window control buttons on darwin and reserves left traffic-light area', async () => {
    const { app, root } = mountTitleBar({
      contextOpen: true,
      platform: 'darwin',
      sidebarCollapsed: false,
    })
    await nextTick()

    const header = root.querySelector('.desktop-title-bar')
    expect(header?.classList.contains('is-native-controls')).toBe(true)
    expect(header?.classList.contains('is-mac-native-controls')).toBe(true)
    expect(header?.classList.contains('is-win-native-controls')).toBe(false)
    expect(root.querySelector('[data-window-control-icon="minimize"]')).toBeNull()
    expect(root.querySelector('[data-window-control-icon="maximize"]')).toBeNull()
    expect(root.querySelector('[data-window-control-icon="close"]')).toBeNull()

    app.unmount()
  })

  it('keeps custom window control buttons on linux', async () => {
    const { app, root } = mountTitleBar({
      contextOpen: false,
      platform: 'linux',
      sidebarCollapsed: true,
    })
    await nextTick()

    const header = root.querySelector('.desktop-title-bar')
    expect(header?.classList.contains('is-native-controls')).toBe(false)
    expect(root.querySelector('[data-window-control-icon="minimize"]')).not.toBeNull()
    expect(root.querySelector('[data-window-control-icon="maximize"]')).not.toBeNull()
    expect(root.querySelector('[data-window-control-icon="close"]')).not.toBeNull()

    const sidebarButton = root.querySelector('.desktop-window-menu__sidebar-trigger')
    expect(sidebarButton?.getAttribute('aria-expanded')).toBe('false')

    app.unmount()
  })
})
