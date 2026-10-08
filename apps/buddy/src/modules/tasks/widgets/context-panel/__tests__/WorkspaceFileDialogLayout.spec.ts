// @vitest-environment jsdom
import { NMessageProvider } from 'naive-ui'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import DesktopWorkspaceFileMenu from '../DesktopWorkspaceFileMenu.vue'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.unstubAllGlobals()
})

it.each(['Rename', 'New file', 'New folder', 'Move to Recycle Bin'])('bounds the real teleported %s dialog', async (action) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const control = shallowRef<InstanceType<typeof DesktopWorkspaceFileMenu> | null>(null)
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ render: () => h(NMessageProvider, null, {
    default: () => h(DesktopWorkspaceFileMenu, {
      ref: control,
      tab: { id: 'files:one', scope: 'workspace', kind: 'files', rootName: 'fixture', target: { spaceId: 'space', directoryId: 'directory', revision: 1, path: '' } },
      files: { mutateEntry: vi.fn(), listDirectory: vi.fn(), readFile: vi.fn(), revealFile: vi.fn() },
      language: 'en-US',
      writeClipboardText: vi.fn(),
      refresh: vi.fn(),
      expand: vi.fn(),
    }),
  }) })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  control.value!.show({ event: new MouseEvent('contextmenu'), path: 'src', name: 'src', kind: 'directory', writable: true, unavailable: false })
  await nextTick()
  await nextTick()
  const option = [...document.querySelectorAll<HTMLElement>('.n-dropdown-option-body')].find(node => node.textContent?.trim() === action)
  expect(option).toBeTruthy()
  option!.click()
  await nextTick()
  await nextTick()
  const dialog = document.querySelector<HTMLElement>('.n-card.workspace-entry-dialog')
  expect(dialog).not.toBeNull()
  expect(dialog!.style.width).toBe('440px')
  expect(dialog!.style.maxWidth).toBe('calc(100vw - 32px)')
  if (action !== 'Move to Recycle Bin') {
    const label = dialog!.querySelector<HTMLLabelElement>('.workspace-entry-label')!
    expect(label).not.toBeNull()
    expect(dialog!.querySelector('input')?.id).toBe(label.htmlFor)
  }
})
