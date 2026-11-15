// @vitest-environment jsdom
import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalSpaceFilePreview } from '@buddy-shared/spaces/spaceFileApi'
import type { TextModelPool } from '@/workbench/browser/TextModelPool'
import type { WorkbenchContext } from '@/workbench/browser/workbenchContext'
import type { ResourceRef } from '@/workbench/common/workbench'
import type { WorkingCopyProvider } from '@/workbench/services/WorkingCopyService'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, provide, shallowRef } from 'vue'
import DesktopFileLoading from '@/shared/ui/loading/DesktopFileLoading.vue'
import { TextEditorPool } from '@/workbench/browser/TextEditorPool'
import { workbenchKey } from '@/workbench/browser/workbenchContext'
import { workbenchLabels } from '@/workbench/common/workbenchLabels'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import DesktopFileEditor from '../DesktopFileEditor.vue'
import DesktopFilePreview from '../DesktopFilePreview.vue'

vi.mock('naive-ui', () => ({ NButton: { render: () => null }, useMessage: () => ({ success: vi.fn(), info: vi.fn(), warning: vi.fn() }) }))
vi.mock('@/shared/ui/contributions/WorkbenchMenu.vue', () => ({ default: { render: () => null } }))
vi.mock('@/shared/ui/files/DesktopDocumentToolbar.vue', () => ({ default: { render: () => null } }))
vi.mock('@/shared/ui/monaco/desktopMonaco', () => ({ observeDesktopMonacoTheme: () => () => {} }))
vi.mock('@/shared/ui/monaco/desktopMonacoLayout', () => ({ observeDesktopMonacoLayout: () => () => {} }))
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

  onDidChangeCursorPosition(callback: () => void) {
    this.cursor = callback
    return { dispose: () => this.cursor = undefined }
  }

  onDidScrollChange() { return { dispose() {} } }
  updateOptions() {}
  layout() {}
  setModel(model: { text: string } | null) {
    this.column = 1
    this.node.value = model?.text ?? ''
  }

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
async function mount(options: { deferredFirst?: boolean, preview?: boolean, readFile?: LocalChatApi['spaces']['readFile'], readDocument?: WorkingCopyProvider['read'] } = {}) {
  const registry = new ContributionRegistry()
  registry.register('files', scope => scope.view({ id: 'files.editor', renderer: 'files.editor', label: 'File', locations: ['main'], multiple: true, supports: () => true }))
  const controller = new WorkbenchController(registry)
  const id = (await controller.open(resource('first.md'), 'first.md'))!
  controller.updateView(id, { state: { mode: options.preview ? 'preview' : 'edit' } })
  const view = shallowRef(controller.layout.views[id]!)
  const subscription = controller.onDidChangeLayout(() => view.value = controller.layout.views[id]!)
  const copies = new WorkingCopyService({ read: options.readDocument ?? (async value => ({ text: String(value.data.path), etag: 'version' })), save: async (_, value) => ({ status: 'saved', document: value }) })
  const editors: Editor[] = []
  const editorPool = new TextEditorPool()
  const visible = shallowRef(true)
  const leases: Array<{ resource: ResourceRef, releases: number }> = []
  const resume = Promise.withResolvers<void>()
  const models = { acquire: async (resource: ResourceRef) => {
    const held = { resource, releases: 0 }
    leases.push(held)
    if (options.deferredFirst && leases.length === 1)
      await resume.promise
    return {
      model: { text: String(resource.data.path) },
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
      : h(DesktopFileEditor, { view: view.value, models, editors: editorPool, language: 'en-US', writeClipboardText: async () => {}, visible: visible.value })
  } })
  app.config.errorHandler = error => errors.push(error)
  app.mount(element)
  cleanups.push(async () => {
    app.unmount()
    editorPool.dispose()
    subscription.dispose()
    await controller.dispose()
    await copies.dispose()
    element.remove()
    expect(errors).toEqual([])
  })
  return { controller, copies, editors, leases, resume, element, id, visible }
}

describe('file view semantic identity', () => {
  it.each(['FILE_NOT_FOUND', 'LOCAL_CHAT_OPERATION_FAILED'])('renders %s preview failures and recovers through retry', async (code) => {
    let restored = false
    const f = await mount({ preview: true, readFile: async () => {
      if (!restored)
        throw new Error(`Error invoking remote method: Error: LEXORA_LOCAL_CHAT_ERROR:${code}:0`)
      return preview('restored preview')
    } })
    const labels = workbenchLabels('en-US')
    await vi.waitFor(() => expect(f.element.querySelector('[role="alert"]')?.textContent).toContain(code === 'FILE_NOT_FOUND' ? labels.fileMissing : labels.failed))
    restored = true
    f.element.querySelector<HTMLButtonElement>('.file-preview__retry')!.click()
    await vi.waitFor(() => expect(f.element.textContent).toContain('restored preview'))
    expect(f.element.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows a missing document without discarding edits and clears the error after external recovery', async () => {
    let missing = false
    let document = { text: 'original', etag: 'a' }
    const f = await mount({ readDocument: async () => {
      if (missing)
        throw new Error('LEXORA_LOCAL_CHAT_ERROR:FILE_NOT_FOUND:0')
      return document
    } })
    const target = f.controller.layout.views[f.id]!.resource
    await vi.waitFor(() => expect(f.copies.get(target)?.etag).toBe('a'))
    f.copies.edit(target, 'local edits')
    missing = true
    await f.copies.refresh(target)
    await nextTick()
    expect(f.element.querySelector('.file-editor__error')?.textContent).toContain(workbenchLabels('en-US').fileMissing)
    expect(f.copies.get(target)).toMatchObject({ text: 'local edits', dirty: true })
    missing = false
    document = { text: 'restored disk', etag: 'b' }
    await f.copies.refresh(target)
    await nextTick()
    expect(f.element.querySelector('.file-editor__error')).toBeNull()
    expect(f.copies.get(target)).toMatchObject({ text: 'local edits', dirty: true, conflict: document, error: null })
  })

  it('retries an initially missing document and removes the error when the file returns', async () => {
    let missing = true
    const f = await mount({ readDocument: async () => {
      if (missing)
        throw new Error('LEXORA_LOCAL_CHAT_ERROR:FILE_NOT_FOUND:0')
      return { text: 'restored document', etag: 'a' }
    } })
    await vi.waitFor(() => expect(f.element.querySelector('.file-editor__error')?.textContent).toContain(workbenchLabels('en-US').fileMissing))
    missing = false
    f.element.querySelector<HTMLButtonElement>('.file-editor__error button')!.click()
    await vi.waitFor(() => expect(f.element.querySelector('.file-editor__error')).toBeNull())
    expect(f.copies.get(f.controller.layout.views[f.id]!.resource)).toMatchObject({ text: 'restored document', error: null })
  })

  it('keeps the editor and its input through cursor persistence and layout state snapshots', async () => {
    const f = await mount()
    await vi.waitFor(() => expect(f.editors).toHaveLength(1))
    const editor = f.editors[0]!
    editor.node.value = 'ongoing input'
    editor.move(5)
    await vi.waitFor(() => expect(f.controller.layout.views[f.id]!.state.editor).toEqual({ column: 5 }))
    f.controller.updateView(f.id, { title: 'renamed.md', state: { ...f.controller.layout.views[f.id]!.state, wrap: true } })
    await nextTick()
    expect(f.element.querySelector('textarea')).toBe(editor.node)
    expect(editor.node.value).toBe('ongoing input')
  })

  it('does not write an old editor state into a rebound resource or freeze Monaco input', async () => {
    const f = await mount()
    await vi.waitFor(() => expect(f.editors).toHaveLength(1))
    const old = f.editors[0]!
    old.move(55)
    f.controller.updateView(f.id, { resource: resource('second.md', 2), state: { mode: 'edit', editor: { column: 7 } } })
    await vi.waitFor(() => expect(f.element.querySelector('textarea')?.value).toBe('second.md'))
    const current = f.editors[0]!
    expect(current).toBe(old)
    expect(current.column).toBe(7)
    expect(old.disposed).toBe(0)
    expect(f.leases[0]!.releases).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(f.controller.layout.views[f.id]!.state.editor).toEqual({ column: 7 })
    expect(current.node.isConnected).toBe(true)
    expect(current.disposed).toBe(0)
  })

  it('detaches hidden editors and restores independent view state on reuse', async () => {
    const f = await mount()
    await vi.waitFor(() => expect(f.editors).toHaveLength(1))
    const editor = f.editors[0]!
    editor.move(19)
    f.visible.value = false
    await nextTick()
    expect(f.element.querySelector('textarea')).toBeNull()
    expect(f.leases[0]!.releases).toBe(1)
    expect(f.controller.layout.views[f.id]!.state.editor).toEqual({ column: 19 })
    f.visible.value = true
    await vi.waitFor(() => expect(f.element.querySelector('textarea')).toBe(editor.node))
    expect(editor.column).toBe(19)
    expect(f.editors).toHaveLength(1)
    expect(f.leases.at(-1)!.releases).toBe(0)
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
    const current = f.controller.layout.views[f.id]!
    f.controller.updateView(f.id, { resource: { ...current.resource, data: { ...current.resource.data, revision: 2 } } })
    second.resolve(preview('current authorized content'))
    await vi.waitFor(() => expect(f.element.textContent).toContain('current authorized content'))
    first.reject(new Error('LEXORA_LOCAL_CHAT_ERROR:FILE_NOT_FOUND:0'))
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
    expect(f.element.textContent).toContain('current authorized content')
    expect(f.element.querySelector('[role="alert"]')).toBeNull()
  })
})

it('keeps quick file reads quiet and shows local feedback only while a slower read is pending', async () => {
  vi.useFakeTimers()
  const loading = shallowRef(true)
  const element = document.createElement('div')
  const app = createApp({ render: () => h(DesktopFileLoading, { loading: loading.value, label: 'Loading file' }) })
  app.mount(element)
  try {
    expect(element.querySelector('[aria-busy="true"]')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(100)
    expect(element.querySelector('[role="status"]')).toBeNull()
    loading.value = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)
    expect(element.querySelector('[role="status"]')).toBeNull()
    loading.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(200)
    expect(element.querySelector('[role="status"]')?.textContent).toContain('Loading file')
    loading.value = false
    await nextTick()
    expect(element.querySelector('[role="status"]')).toBeNull()
  }
  finally {
    app.unmount()
    vi.useRealTimers()
  }
})
