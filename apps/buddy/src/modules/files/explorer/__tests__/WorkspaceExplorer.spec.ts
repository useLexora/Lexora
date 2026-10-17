// @vitest-environment jsdom
import type { ExplorerNode } from '@/shared/ui/explorer/treeCollection'
import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import WorkspaceExplorer from '../WorkspaceExplorer.vue'

const { command } = vi.hoisted(() => ({ command: vi.fn() }))
const node: ExplorerNode = { key: 'note.md', label: 'note.md', kind: 'file' }

vi.mock('../useExplorerCommands', async () => {
  const { shallowRef } = await import('vue')
  return {
    useExplorerCommands: () => ({
      labels: shallowRef({}),
      busy: shallowRef(null),
      error: shallowRef(null),
      nameRequest: shallowRef(null),
      clipboard: shallowRef(null),
      command,
    }),
  }
})
vi.mock('@/platform/desktop/desktopCapabilities', () => ({
  loadDesktopAppInfo: async () => ({ platform: 'win32' }),
}))
vi.mock('@/shared/ui/explorer/ExplorerTree.vue', () => ({
  default: defineComponent({
    emits: ['contextmenu'],
    setup(_, { emit }) {
      return () => h('div', {
        'data-testid': 'tree',
        'onContextmenu': (event: MouseEvent) => emit('contextmenu', node, event),
      })
    },
  }),
}))
vi.mock('naive-ui', () => ({
  NDropdown: defineComponent({
    props: { show: Boolean, x: Number, y: Number, options: Array },
    emits: ['clickoutside', 'select'],
    setup(props, { emit }) {
      return () => h('div', {
        'data-testid': 'dropdown',
        'data-show': String(props.show),
        'data-x': props.x,
        'data-y': props.y,
      }, [
        h('button', { class: 'outside', onClick: () => emit('clickoutside') }),
        h('button', { class: 'select', onClick: () => emit('select', 'copy') }),
      ])
    },
  }),
  NSpin: defineComponent({ render: () => null }),
  NIcon: defineComponent({ render: () => null }),
}))
vi.mock('../ExplorerNameDialog.vue', () => ({ default: defineComponent({ render: () => null }) }))
vi.mock('../ExplorerRecovery.vue', () => ({ default: defineComponent({ render: () => null }) }))

describe('workspace explorer context menu position', () => {
  it.each(['outside', 'select'])('preserves the leave-transition anchor after %s and repositions on reopen', async (action) => {
    command.mockClear()
    const root = document.createElement('div')
    const app = createApp({
      render: () => h(WorkspaceExplorer, {
        nodes: [node],
        loadingKeys: new Set<string>(),
        expandedKeys: [],
        target: { spaceId: 'space', directoryId: 'directory', revision: 1, path: '' },
        language: 'zh-CN',
        api: {
          revealFile: vi.fn(),
          fileHistory: vi.fn().mockResolvedValue([]),
          acknowledgeFileOperation: vi.fn(),
          cancelFileOperation: vi.fn(),
          onFilesChanged: () => () => {},
        },
        load: async () => {},
        refresh: async () => {},
      }),
    })
    app.mount(root)
    try {
      const tree = root.querySelector('[data-testid="tree"]')!
      const dropdown = root.querySelector('[data-testid="dropdown"]')!
      tree.dispatchEvent(new MouseEvent('contextmenu', { clientX: 320, clientY: 240 }))
      await nextTick()
      expect(dropdown.getAttribute('data-show')).toBe('true')
      expect(dropdown.getAttribute('data-x')).toBe('320')
      expect(dropdown.getAttribute('data-y')).toBe('240')

      root.querySelector<HTMLButtonElement>(`.${action}`)!.click()
      await nextTick()
      expect(dropdown.getAttribute('data-show')).toBe('false')
      expect(dropdown.getAttribute('data-x')).toBe('320')
      expect(dropdown.getAttribute('data-y')).toBe('240')
      if (action === 'select')
        expect(command).toHaveBeenCalledWith('copy', node)
      else
        expect(command).not.toHaveBeenCalled()

      tree.dispatchEvent(new MouseEvent('contextmenu', { clientX: 480, clientY: 360 }))
      await nextTick()
      expect(dropdown.getAttribute('data-show')).toBe('true')
      expect(dropdown.getAttribute('data-x')).toBe('480')
      expect(dropdown.getAttribute('data-y')).toBe('360')
    }
    finally {
      app.unmount()
    }
  })
})
