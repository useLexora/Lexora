// @vitest-environment jsdom
import type { ExtensionApi } from '@buddy-shared/extensions/extensionApi'
import type { FileOpeningProvider, FileOpeningSnapshot } from '@buddy-shared/files/fileOpening'
import type { FileOpeningState } from '../fileOpeningContext'
import { builtinFileOpeningProviders } from '@buddy-shared/files/fileOpening'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { useProvideFileOpening } from '../fileOpeningContext'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
const plugin: FileOpeningProvider = {
  id: 'test.reader',
  title: 'Reader',
  extensions: ['.md'],
  locations: ['inline', 'standalone'],
  builtin: false,
  available: true,
  renderer: 'extension',
}
const initial: FileOpeningSnapshot = { providers: [...builtinFileOpeningProviders, plugin], defaults: { '.md': { inline: plugin.id } } }

function mount(overrides: Partial<Pick<ExtensionApi, 'fileOpeners' | 'setFileOpener'>> = {}) {
  const listeners = new Set<() => void>()
  const api: Pick<ExtensionApi, 'fileOpeners' | 'setFileOpener' | 'onChanged'> = {
    fileOpeners: async () => initial,
    setFileOpener: async () => initial,
    ...overrides,
    onChanged: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  let state!: FileOpeningState
  const root = document.createElement('div')
  const app = createApp({ setup() {
    state = useProvideFileOpening(api)
    return () => null
  } })
  app.mount(root)
  const dispose = () => app.unmount()
  cleanups.push(dispose)
  return { api, state, listeners, dispose }
}

it('rejects initial readiness and clears the visible error after an on-demand retry', async () => {
  const { api, state } = mount({ fileOpeners: async () => {
    throw new Error('READ_FAILED')
  } })
  await expect(state.ready).rejects.toThrow('READ_FAILED')
  expect(state.error.value).toBe('READ_FAILED')
  expect(state.loaded.value).toBe(false)
  api.fileOpeners = async () => initial
  await state.ensureReady()
  expect(state.loaded.value).toBe(true)
  expect(state.error.value).toBe('')
  expect(state.snapshot.value).toEqual(initial)
})

it('ignores older reads and refreshes when extensions change', async () => {
  const old = deferred<FileOpeningSnapshot>()
  const { api, state, listeners } = mount({ fileOpeners: () => old.promise })
  await Promise.resolve()
  api.fileOpeners = async () => initial
  await state.refresh()
  old.resolve({ providers: [], defaults: {} })
  await state.ready
  expect(state.snapshot.value).toEqual(initial)
  const disabled = { ...initial, providers: initial.providers.map(provider => provider.id === plugin.id ? { ...provider, available: false } : provider) }
  api.fileOpeners = async () => disabled
  listeners.forEach(listener => listener())
  await vi.waitFor(() => expect(state.resolve('notes.md', 'inline').unavailable).toBe(true))
})

it('does not optimistically persist choices or let reads started before a save overwrite it', async () => {
  const save = deferred<FileOpeningSnapshot>()
  const stale = deferred<FileOpeningSnapshot>()
  const { api, state } = mount({ setFileOpener: () => save.promise })
  await state.ready
  api.fileOpeners = () => stale.promise
  const reading = state.refresh()
  await Promise.resolve()
  const saving = state.setDefault({ extension: '.md', location: 'inline', providerId: null })
  await Promise.resolve()
  expect(state.snapshot.value).toEqual(initial)
  const next = { ...initial, defaults: {} }
  save.resolve(next)
  await saving
  stale.resolve(initial)
  await reading
  expect(state.snapshot.value).toEqual(next)
})

it('retains the saved snapshot on failed writes and serializes concurrent row changes', async () => {
  const first = deferred<FileOpeningSnapshot>()
  const { api, state } = mount({ setFileOpener: () => first.promise })
  await state.ready
  const failed = state.setDefault({ extension: '.md', location: 'inline', providerId: null })
  first.reject(new Error('SAVE_FAILED'))
  await expect(failed).rejects.toThrow('SAVE_FAILED')
  expect(state.snapshot.value).toEqual(initial)
  const started = deferred<void>()
  const update = deferred<void>()
  let saved = initial
  api.setFileOpener = async (choice) => {
    const row = { ...saved.defaults[choice.extension], [choice.location]: choice.providerId ?? undefined }
    if (choice.location === 'inline') {
      started.resolve()
      await update.promise
    }
    saved = { ...saved, defaults: { ...saved.defaults, [choice.extension]: row } }
    return saved
  }
  const changes = Promise.all([
    state.setDefault({ extension: '.md', location: 'inline', providerId: 'lexora.text' }),
    state.setDefault({ extension: '.md', location: 'standalone', providerId: plugin.id }),
  ])
  await started.promise
  update.resolve()
  await changes
  expect(state.snapshot.value.defaults['.md']).toEqual({ inline: 'lexora.text', standalone: plugin.id })
})

it('uses registered owners and recovers automatically when an available opener registers after its API snapshot', async () => {
  const registry = new ContributionRegistry()
  registry.register('builtin', scope => builtinFileOpeningProviders.forEach(provider => scope.fileOpener(provider)))
  const { state, api } = mount()
  state.bindRegistry(registry)
  await state.ready
  expect(state.resolve('notes.md', 'inline')).toMatchObject({ unavailable: true, preferredId: plugin.id, provider: { id: 'lexora.markdown' } })
  const unregister = registry.register('plugin', (scope) => {
    scope.fileOpener({ ...plugin, title: 'Stale title', extensions: ['.old'] })
    scope.fileOpener({ ...plugin, id: 'test.pending', extensions: ['.pending'] })
  })
  expect(state.resolve('notes.md', 'inline')).toMatchObject({ unavailable: false, provider: { id: plugin.id } })
  expect(state.snapshot.value.providers.find(provider => provider.id === plugin.id)).toEqual(plugin)
  expect(state.snapshot.value.providers.some(provider => provider.id === 'test.pending')).toBe(false)
  api.fileOpeners = async () => ({ ...initial, providers: initial.providers.map(provider => provider.id === plugin.id ? { ...provider, available: false } : provider) })
  await state.refresh()
  expect(state.resolve('notes.md', 'inline').unavailable).toBe(true)
  api.fileOpeners = async () => initial
  await state.refresh()
  expect(state.resolve('notes.md', 'inline').provider?.id).toBe(plugin.id)
  unregister()
  expect(state.resolve('notes.md', 'inline')).toMatchObject({ unavailable: true, preferredId: plugin.id, provider: { id: 'lexora.markdown' } })
  expect(state.snapshot.value.defaults).toEqual(initial.defaults)
  registry.dispose()
})

it('prevents an in-flight read from publishing after disposal', async () => {
  const pending = deferred<FileOpeningSnapshot>()
  const { state, dispose } = mount({ fileOpeners: () => pending.promise })
  await Promise.resolve()
  dispose()
  cleanups.pop()
  pending.resolve(initial)
  await state.ready
  expect(state.snapshot.value.defaults).toEqual({})
  expect(state.loaded.value).toBe(false)
})
