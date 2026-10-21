// @vitest-environment jsdom
import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalSpaceFilePreview } from '@buddy-shared/spaces/spaceFileApi'
import type { TextModelPool } from '@/workbench/browser/TextModelPool'
import type { WorkbenchContext } from '@/workbench/browser/workbenchContext'
import type { ResourceRef } from '@/workbench/common/workbench'
import type { WorkingCopyProvider } from '@/workbench/services/WorkingCopyService'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, provide, shallowRef } from 'vue'
import { WorkingCopyAutoSave } from '@/app/workbench/WorkingCopyAutoSave'
import DesktopFileLoading from '@/shared/ui/loading/DesktopFileLoading.vue'
import { workbenchKey } from '@/workbench/browser/workbenchContext'
import { resourceKey } from '@/workbench/common/workbench'
import { workbenchLabels } from '@/workbench/common/workbenchLabels'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import DesktopFileEditor from '../DesktopFileEditor.vue'
import DesktopFilePreview from '../DesktopFilePreview.vue'

vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    useMessage: () => ({ success: vi.fn(), info: vi.fn(), warning: vi.fn() }),
    NButton: defineComponent({ props: ['disabled', 'loading'], setup: (props, { slots }) => () => h('button', { disabled: props.disabled || props.loading }, slots.default?.()) }),
    NSwitch: defineComponent({
      props: ['value', 'disabled', 'themeOverrides'],
      emits: ['update:value'],
      setup: (props, { emit }) => () => h('button', { 'role': 'switch', 'aria-checked': String(props.value), 'data-rail-width': props.themeOverrides?.railWidthSmall, 'data-rail-height': props.themeOverrides?.railHeightSmall, 'disabled': props.disabled, 'onClick': () => emit('update:value', !props.value) }),
    }),
  }
})
vi.mock('@/shared/ui/contributions/WorkbenchMenu.vue', () => ({ default: { render: () => null } }))
vi.mock('@/shared/ui/files/DesktopDocumentToolbar.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ setup: (_, { slots }) => () => h('header', slots.actions?.()) }) }
})
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
async function mount(options: { deferredFirst?: boolean, preview?: boolean, readFile?: LocalChatApi['spaces']['readFile'], autoSave?: boolean, visible?: boolean, recovered?: boolean, save?: WorkingCopyProvider['save'], duplicate?: boolean } = {}) {
  const registry = new ContributionRegistry()
  registry.register('files', (scope) => {
    scope.view({ id: 'files.editor', renderer: 'files.editor', label: 'File', locations: ['main'], multiple: true, supports: () => true })
    scope.configuration({ id: 'files.autoSave', defaultValue: 'afterDelay', validate: value => value === 'off' || value === 'afterDelay' })
  })
  const controller = new WorkbenchController(registry)
  const id = (await controller.open(resource('first.md'), 'first.md'))!
  controller.updateView(id, { state: { mode: options.preview ? 'preview' : 'edit' } })
  const view = shallowRef(controller.layout.views[id]!)
  const subscription = controller.onDidChangeLayout(() => view.value = controller.layout.views[id]!)
  const copies = new WorkingCopyService({ read: async value => ({ text: String(value.data.path), etag: 'version' }), save: options.save ?? (async (_, value) => ({ status: 'saved', document: value })) })
  const autoSave = options.autoSave ? new WorkingCopyAutoSave(copies, controller.configuration) : undefined
  if (options.recovered) {
    const target = resource('first.md')
    copies.restore([{ key: resourceKey(target), resource: JSON.parse(JSON.stringify(target)), text: 'recovered draft', baseText: 'first.md', etag: 'version', savedAt: '2026-10-21T00:00:00Z' }])
  }
  autoSave?.start()
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
    provide(workbenchKey, { controller, copies, autoSave, labels: shallowRef(workbenchLabels('en-US')) } as WorkbenchContext)
    return () => options.preview
      ? h(DesktopFilePreview, { view: view.value, files, language: 'en-US', writeClipboardText: async () => {}, visible: options.visible ?? false })
      : h('div', Array.from({ length: options.duplicate ? 2 : 1 }, (_, key) => h(DesktopFileEditor, { key, view: view.value, models, language: 'en-US', writeClipboardText: async () => {}, visible: options.visible ?? false })))
  } })
  app.config.errorHandler = error => errors.push(error)
  app.mount(element)
  cleanups.push(async () => {
    app.unmount()
    autoSave?.dispose()
    subscription.dispose()
    await controller.dispose()
    await copies.dispose()
    element.remove()
    expect(errors).toEqual([])
  })
  return { controller, copies, autoSave, editors, leases, resume, element, id }
}

describe('file view semantic identity', () => {
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
    const current = f.controller.layout.views[f.id]!
    f.controller.updateView(f.id, { resource: { ...current.resource, data: { ...current.resource.data, revision: 2 } } })
    second.resolve(preview('current authorized content'))
    await vi.waitFor(() => expect(f.element.textContent).toContain('current authorized content'))
    first.reject(new Error('retired request failure'))
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
    expect(f.element.textContent).toContain('current authorized content')
    expect(f.element.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('file editor auto-save controls', () => {
  it('shows the compact control only in edit mode and preserves its shared setting across modes', async () => {
    const f = await mount({ autoSave: true, visible: true, duplicate: true })
    await vi.waitFor(() => expect(document.querySelectorAll('[role="switch"]')).toHaveLength(2))
    const switches = () => [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
    await vi.waitFor(() => expect(switches()[0]!.disabled).toBe(false))
    expect(switches().map(value => value.getAttribute('aria-checked'))).toEqual(['true', 'true'])
    const first = switches()[0]!
    expect(document.getElementById(first.getAttribute('aria-labelledby')!)?.textContent).toBe('Auto save')
    expect(first.previousElementSibling?.textContent).toBe('Auto save')
    expect(first.dataset.railWidth).toBe('26px')
    expect(first.dataset.railHeight).toBe('14px')
    expect(first.parentElement?.title).toContain('including other Spaces')
    first.click()
    await nextTick()
    expect(switches().map(value => value.getAttribute('aria-checked'))).toEqual(['false', 'false'])
    for (const mode of ['preview', 'source']) {
      f.controller.updateView(f.id, { state: { mode } })
      await nextTick()
      expect(switches()).toHaveLength(0)
      expect(f.element.querySelector('.file-editor__auto-save')).toBeNull()
    }
    f.controller.updateView(f.id, { state: { mode: 'edit' } })
    await nextTick()
    expect(switches()).toHaveLength(2)
    expect(switches().map(value => value.getAttribute('aria-checked'))).toEqual(['false', 'false'])
  })

  it('cancels pending auto save when switched off and enables manual save only for unsaved changes', async () => {
    const save = vi.fn<WorkingCopyProvider['save']>(async (_, value) => ({ status: 'saved', document: value }))
    const f = await mount({ autoSave: true, visible: true, save })
    await vi.waitFor(() => expect(f.editors).toHaveLength(1))
    const manualSave = () => [...f.element.querySelectorAll<HTMLButtonElement>('header button')].find(value => value.textContent === 'Save')!
    expect(manualSave().disabled).toBe(true)
    vi.useFakeTimers()
    try {
      f.copies.edit(resource('first.md'), 'manual after switching off')
      await nextTick()
      f.element.querySelector<HTMLButtonElement>('[role="switch"]')!.click()
      await nextTick()
      expect(f.autoSave!.enabled).toBe(false)
      expect(manualSave().disabled).toBe(false)
      await vi.advanceTimersByTimeAsync(1500)
      expect(save).not.toHaveBeenCalled()
      expect(f.copies.dirty(resource('first.md'))).toBe(true)
      manualSave().click()
      await vi.advanceTimersByTimeAsync(0)
      await nextTick()
      expect(save).toHaveBeenCalledTimes(1)
      expect(f.copies.dirty(resource('first.md'))).toBe(false)
      expect(manualSave().disabled).toBe(true)
      expect(f.autoSave!.enabled).toBe(false)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('shows recovery feedback and explicitly saves before resuming auto save', async () => {
    const save = vi.fn<WorkingCopyProvider['save']>(async (_, value) => ({ status: 'saved', document: value }))
    const f = await mount({ autoSave: true, visible: true, recovered: true, save })
    await vi.waitFor(() => expect(f.element.textContent).toContain('Unsaved changes recovered'))
    expect(save).not.toHaveBeenCalled()
    const resume = [...f.element.querySelectorAll('button')].find(value => value.textContent === 'Save and resume auto save')!
    resume.click()
    await vi.waitFor(() => expect(f.copies.dirty(resource('first.md'))).toBe(false))
    expect(save).toHaveBeenCalledTimes(1)
    expect(f.element.textContent).not.toContain('Unsaved changes recovered')
  })

  it('reports save errors as save errors with a working retry action, not a view loading failure', async () => {
    let fail = true
    const save = vi.fn<WorkingCopyProvider['save']>(async (_, value) => {
      if (fail)
        throw new Error('DISK_UNAVAILABLE')
      return { status: 'saved', document: value }
    })
    const f = await mount({ autoSave: true, visible: true, save })
    await vi.waitFor(() => expect(f.editors).toHaveLength(1))
    f.copies.edit(resource('first.md'), 'changed')
    await f.autoSave!.retry(resource('first.md'))
    await nextTick()
    expect(f.element.textContent).toContain('Auto save failed')
    expect(f.element.textContent).not.toContain('View failed to load')
    fail = false
    const retry = [...f.element.querySelectorAll('button')].find(value => value.textContent === 'Retry')!
    retry.click()
    await vi.waitFor(() => expect(f.copies.dirty(resource('first.md'))).toBe(false))
    expect(f.element.textContent).not.toContain('Auto save failed')
  })

  it('does not show an auto-save switch for a read-only preview', async () => {
    const f = await mount({ autoSave: true, preview: true, visible: true })
    await vi.waitFor(() => expect(f.element.textContent).toContain('first'))
    expect(document.querySelector('[role="switch"]')).toBeNull()
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
