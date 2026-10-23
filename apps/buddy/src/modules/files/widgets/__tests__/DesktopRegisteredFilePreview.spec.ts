// @vitest-environment jsdom
import type { FileOpeningProvider } from '@buddy-shared/files/fileOpening'
import type { SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { WorkbenchContext } from '@/workbench/browser/workbenchContext'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, provide, shallowRef } from 'vue'
import { workbenchKey } from '@/workbench/browser/workbenchContext'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import DesktopRegisteredFilePreview from '../DesktopRegisteredFilePreview.vue'

const preparedView = vi.hoisted(() => ({ type: 'tests.player.view' }))

vi.mock('@/platform/desktop/desktopApi', () => ({ requireDesktopApi: () => ({ extensions: {
  prepareFileOpening: async ({ source }: { source: { target: SpaceFileTarget } }) => ({ extensionId: 'tests.player', viewType: preparedView.type, resource: { id: crypto.randomUUID(), name: source.target.path } }),
} }) }))
vi.mock('@/workbench/browser/WorkbenchSurface.vue', () => ({ default: { props: ['viewId'], setup: (props: { viewId: string }) => () => h('div', { 'data-view': props.viewId }) } }))

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  preparedView.type = 'tests.player.view'
  vi.useRealTimers()
})

it('preserves equivalent previews and replaces the child when its registered view changes', async () => {
  vi.useFakeTimers()
  const registry = new ContributionRegistry()
  registry.register('files', (scope) => {
    scope.view({ id: 'files.preview', label: 'File', renderer: 'files', locations: ['context'], multiple: true, supports: resource => resource.scheme === 'file' })
    scope.view({ id: 'tests.player.view', label: 'Player', renderer: 'player', locations: ['context'], multiple: true, supports: resource => resource.scheme === 'extension' })
  })
  const controller = new WorkbenchController(registry)
  const ownerId = (await controller.open({ scheme: 'file', id: 'video', data: {} }, 'video.mp4', { location: 'context' }))!
  const revision = shallowRef(0)
  const stop = controller.subscribe(() => revision.value++)
  const provider: FileOpeningProvider = { id: 'tests.player.video', title: 'Player', renderer: 'extension', builtin: false, available: true, locations: ['inline'], extensions: ['.mp4'], extensionId: 'tests.player', viewTypes: { inline: 'tests.player.view' } }
  const target: SpaceFileTarget = { spaceId: 'space', directoryId: 'directory', revision: 1, path: 'video.mp4' }
  const props = shallowRef({ ownerId, provider, target, visible: true, language: 'en-US' as const })
  const element = document.createElement('div')
  const app = createApp({ setup() {
    provide(workbenchKey, { controller, revision } as WorkbenchContext)
    return () => h(DesktopRegisteredFilePreview, props.value)
  } })
  app.mount(element)
  cleanups.push(() => {
    app.unmount()
    stop()
    controller.dispose()
    element.remove()
  })
  await vi.runAllTimersAsync()
  const child = Object.values(controller.layout.views).find(view => view.state.inlineOwner === ownerId)!
  expect(child.resource.data.resource).toMatchObject({ name: 'video.mp4' })
  controller.updateView(child.id, { state: { ...child.state, version: 1, value: { position: 12 } } })
  props.value = { ...props.value, provider: { ...provider }, target: { ...target } }
  await nextTick()
  await vi.runAllTimersAsync()
  expect(controller.layout.views[child.id]?.resource).toEqual(child.resource)
  expect(controller.layout.views[child.id]?.state.value).toEqual({ position: 12 })
  expect(element.querySelector('[data-view]')?.getAttribute('data-view')).toBe(child.id)

  props.value = { ...props.value, target: { ...target, path: 'second.mp4' } }
  await nextTick()
  await vi.runAllTimersAsync()
  expect(controller.layout.views[child.id]?.resource.data.resource).toMatchObject({ name: 'second.mp4' })
  expect(controller.layout.views[child.id]?.resource).not.toEqual(child.resource)
  registry.register('new-preview', scope => scope.view({ id: 'tests.player.preview', label: 'Preview', renderer: 'player', locations: ['context'], multiple: true, supports: resource => resource.scheme === 'extension' }))
  preparedView.type = 'tests.player.preview'
  props.value = { ...props.value, provider: { ...provider, viewTypes: { inline: preparedView.type } } }
  await nextTick()
  await vi.runAllTimersAsync()
  const children = Object.values(controller.layout.views).filter(view => view.state.inlineOwner === ownerId)
  expect(children).toHaveLength(1)
  expect(children[0]).toMatchObject({ type: 'tests.player.preview', state: { version: 0, value: {} }, resource: { data: { resource: { name: 'second.mp4' } } } })
  expect(controller.layout.views[child.id]).toBeUndefined()
  expect(controller.layout.views[ownerId]).toBeDefined()
  expect(element.querySelector('[data-view]')?.getAttribute('data-view')).toBe(children[0]!.id)
})
