// @vitest-environment jsdom
import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalSpaceFilePreview } from '@buddy-shared/spaces/spaceFileApi'
import type { TextModelPool } from '@/workbench/browser/TextModelPool'
import type { WorkbenchContext } from '@/workbench/browser/workbenchContext'
import type { ResourceRef } from '@/workbench/common/workbench'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, provide, shallowRef } from 'vue'
import { workbenchKey } from '@/workbench/browser/workbenchContext'
import { workbenchLabels } from '@/workbench/common/workbenchLabels'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import DesktopFileEditor from '../DesktopFileEditor.vue'
import DesktopFilePreview from '../DesktopFilePreview.vue'

vi.mock('naive-ui', () => ({ NButton: { render: () => null } }))
vi.mock('@/shared/ui/contributions/WorkbenchMenu.vue', () => ({ default: { render: () => null } }))
vi.mock('@/shared/ui/files/DesktopDocumentToolbar.vue', () => ({ default: { render: () => null } }))
vi.mock('@/shared/ui/monaco/desktopMonaco', () => ({ observeDesktopMonacoTheme: () => () => {} }))
vi.mock('@/shared/ui/markdown/DesktopMarkdownContent.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({
    props: ['content'],
    setup: props => () => h('pre', props.content),
  }) }
})

class Editor {
  readonly node = document.createElement('textarea')
  column = 1
  disposed = 0
  cursor?: () => void
  constructor(element: HTMLElement, text: string) {
    this.node.value = text
    element.append(this.node)
  }

  saveViewState() { return { column: this.column } }
  restoreViewState(state: { column: number }) {
    this.column = state.column
    state.column = -1
  }

  onDidChangeCursorPosition(callback: () => void) { this.cursor = callback }
  onDidScrollChange() {}
  updateOptions() {}
  move(column: number) {
    this.column = column
    this.cursor?.()
  }

  dispose() {
    this.disposed++
    this.node.remove()
  }
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function resource(path: string, revision = 1): ResourceRef {
  return { scheme: 'file', id: JSON.stringify(['directory', revision, path]), data: { spaceId: 'space', directoryId: 'directory', revision, path } }
}
function preview(text: string): LocalSpaceFilePreview {
  return { kind: 'text', text, sizeBytes: text.length, imageUrl: null }
}
async function mount(options: { deferredFirst?: boolean, preview?: boolean, readFile?: LocalChatApi['spaces']['readFile'] } = {}) {
  const registry = new ContributionRegistry()
  registry.register('files', scope => scope.view({ id: 'files.editor', renderer: 'files.editor', label: 'File', locations: ['main'], multiple: true, supports: () => true }))
  const controller = new WorkbenchController(registry)
  const id = (await controller.open(resource('first.md'), 'first.md'))!
  controller.updateView(id, { state: { mode: options.preview ? 'preview' : 'edit' } })
  const view = shallowRef(controller.layout.views[id]!)
  const subscription = controller.onDidChangeLayout(() => view.value = controller.layout.views[id]!)
  const copies = new WorkingCopyService({ read: async value => ({ text: String(value.data.path), etag: 'version' }), save: async (_, value) => ({ status: 'saved', document: value }) })
  const editors: Editor[] = []
  const leases: Array<{ resource: ResourceRef, releases: number }> = []
  const resume = Promise.withResolvers<void>()
  const models = { acquire: async (resource: ResourceRef) => {
    const held = { resource, releases: 0 }
    leases.push(held)
    if (options.deferredFirst && leases.length === 1)
      await resume.promise
    return {
      model: {},
      release: () => held.releases++,
      monaco: { editor: { create: (element: HTMLElement) => {
        const editor = new Editor(element, String(resource.data.path))
        editors.push(editor)
        return editor
      } } },
    }
  } } as unknown as TextModelPool
  const files = { readFile: options.readFile ?? (async () => preview('first')) } as LocalChatApi['spaces']
  const element = document.createElement('div')
  document.body.append(element)
  const errors: unknown[] = []
  const app = createApp({ setup() {
    provide(workbenchKey, { controller, copies, labels: shallowRef(workbenchLabels('en-US')) } as WorkbenchContext)
    return () => options.preview
      ? h(DesktopFilePreview, { view: view.value, files, language: 'en-US', writeClipboardText: async () => {}, visible: false })
      : h(DesktopFileEditor, { view: view.value, models, language: 'en-US', writeClipboardText: async () => {}, visible: false })
  } })
  app.config.errorHandler = error => errors.push(error)
  app.mount(element)
  cleanups.push(async () => {
    app.unmount()
    subscription.dispose()
    await controller.dispose()
    await copies.dispose()
    element.remove()
    expect(errors).toEqual([])
  })
  return { controller, copies, editors, leases, resume, element, id }
}

describe('file view semantic identity', () => {
  it('keeps the editor and its input through cursor persistence and layout state snapshots', async () => {
    const f = await mount()
    await vi.waitFor(() => expect(f.editors).toHaveLength(1))
    const editor = f.editors[0]!
    editor.node.value = 'ongoing input'
    editor.move(5)
    await vi.waitFor(() => expect(f.controller.layout.views[f.id]!.state.editor).toEqual({ column: 5 }))
    expect(f.editors).toHaveLength(1)
    f.controller.updateView(f.id, { title: 'renamed.md', state: { ...f.controller.layout.views[f.id]!.state, wrap: true } })
    await nextTick()
    expect(f.element.querySelector('textarea')).toBe(editor.node)
    expect(editor.node.value).toBe('ongoing input')
    expect(editor.disposed).toBe(0)
    expect(f.leases).toHaveLength(1)
  })

  it('does not write an old editor state into a rebound resource or freeze Monaco input', async () => {
    const f = await mount()
    await vi.waitFor(() => expect(f.editors).toHaveLength(1))
    const old = f.editors[0]!
    old.move(55)
    f.controller.updateView(f.id, { resource: resource('second.md', 2), state: { mode: 'edit', editor: { column: 7 } } })
    await vi.waitFor(() => expect(f.editors).toHaveLength(2))
    const current = f.editors[1]!
    expect(current.column).toBe(7)
    expect(old.disposed).toBe(1)
    expect(f.leases[0]!.releases).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(f.controller.layout.views[f.id]!.state.editor).toEqual({ column: 7 })
    expect(current.node.isConnected).toBe(true)
    expect(current.disposed).toBe(0)
  })

  it('releases a late model lease without removing the replacement editor', async () => {
    const f = await mount({ deferredFirst: true })
    await vi.waitFor(() => expect(f.leases).toHaveLength(1))
    f.controller.updateView(f.id, { resource: resource('second.md') })
    await vi.waitFor(() => expect(f.editors).toHaveLength(1))
    const current = f.editors[0]!
    f.resume.resolve()
    await vi.waitFor(() => expect(f.leases[0]!.releases).toBe(1))
    expect(f.element.querySelector('textarea')).toBe(current.node)
    expect(current.node.value).toBe('second.md')
    expect(current.disposed).toBe(0)
    expect(f.leases.at(-1)!.releases).toBe(0)
  })

  it('refreshes a changed authorization target and ignores late preview failures', async () => {
    const first = Promise.withResolvers<LocalSpaceFilePreview>()
    const second = Promise.withResolvers<LocalSpaceFilePreview>()
    const readFile = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const f = await mount({ preview: true, readFile })
    expect(readFile).toHaveBeenCalledTimes(1)
    f.controller.updateView(f.id, { state: { mode: 'preview', wrap: false } })
    await nextTick()
    expect(readFile).toHaveBeenCalledTimes(1)
    const current = f.controller.layout.views[f.id]!
    f.controller.updateView(f.id, { resource: { ...current.resource, data: { ...current.resource.data, revision: 2 } } })
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(2))
    second.resolve(preview('current authorized content'))
    await vi.waitFor(() => expect(f.element.textContent).toContain('current authorized content'))
    first.reject(new Error('retired request failure'))
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
    expect(f.element.textContent).toContain('current authorized content')
    expect(f.element.querySelector('[role="alert"]')).toBeNull()
  })
})
