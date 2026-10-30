// @vitest-environment jsdom
import type { ImageApi, ImageCatalog, ImagePolicy, ImagePreferences } from '@buddy-shared/images/imagePreferences'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { useImageSettings } from '../useImageSettings'

const cleanups: Array<() => void> = []
const native: ImagePolicy = { mode: 'native', target: null, fallbacks: [] }
const selected: ImagePolicy = { mode: 'selected', target: { kind: 'model', providerId: 'fixture', modelId: 'vision' }, fallbacks: [] }
const alternate: ImagePolicy = { mode: 'selected', target: { kind: 'model', providerId: 'fixture', modelId: 'other' }, fallbacks: [] }
const incomplete: ImagePolicy = { ...native, mode: 'selected' }

afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.unstubAllGlobals()
})

function catalog(preferences: ImagePreferences): ImageCatalog {
  return { preferences: structuredClone(preferences), candidates: [], readingCandidates: [] }
}

function fixture(initial: ImagePreferences = {}, firstRead?: Promise<ImageCatalog>) {
  let persisted = structuredClone(initial)
  const saveGates: Promise<void>[] = []
  const providers = new Set<() => void>()
  const extensions = new Set<() => void>()
  const images = {
    catalog: vi.fn<ImageApi['catalog']>().mockImplementation(async () => catalog(persisted)),
    save: vi.fn<ImageApi['save']>().mockImplementation(async (preferences) => {
      const input = structuredClone(preferences)
      await saveGates.shift()
      persisted = input
    }),
  }
  if (firstRead)
    images.catalog.mockReturnValueOnce(firstRead)
  const subscribe = (listeners: Set<() => void>) => (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  vi.stubGlobal('lexoraDesktop', {
    images,
    localChat: { providers: { onChanged: subscribe(providers) } },
    extensions: { onChanged: subscribe(extensions) },
  })
  let settings!: ReturnType<typeof useImageSettings>
  const root = document.createElement('div')
  const app = createApp({
    setup() {
      settings = useImageSettings()
      return () => h('output', JSON.stringify(settings.policy('understand')))
    },
  })
  app.mount(root)
  let mounted = true
  function unmount() {
    if (mounted)
      app.unmount()
    mounted = false
  }
  cleanups.push(unmount)
  return {
    settings,
    images,
    root,
    unmount,
    saved: () => persisted,
    pauseNextSave: (promise: Promise<void>) => { saveGates.push(promise) },
    changed: () => providers.forEach(listener => listener()),
    ready: () => vi.waitFor(() => expect(settings.loading.value).toBe(false)),
    idle: () => vi.waitFor(() => expect(settings.savingOperations.value.size).toBe(0)),
  }
}

describe('image settings automatic persistence', () => {
  it('waits for a known baseline after an initial catalog failure', async () => {
    const initial = { understand: selected, edit: selected }
    const read = deferred<ImageCatalog>()
    const f = fixture(initial, read.promise)
    read.reject(new Error('catalog unavailable'))
    await vi.waitFor(() => expect(f.settings.failed.value).toBe(true))
    f.settings.change('generate', native)
    await nextTick()
    expect(f.settings.loading.value).toBe(true)
    expect(f.saved()).toEqual(initial)
    expect(f.images.save).not.toHaveBeenCalled()
    await f.settings.refresh()
    await f.idle()
    expect(f.settings.loading.value).toBe(false)
    expect(f.saved()).toEqual({ ...initial, generate: native })
  })

  it('keeps an incomplete local selection without blocking a different valid field', async () => {
    const f = fixture()
    await f.ready()
    const read = deferred<ImageCatalog>()
    f.images.catalog.mockReturnValueOnce(read.promise)
    const refreshing = f.settings.refresh()
    f.settings.change('understand', incomplete)
    await nextTick()
    expect(JSON.parse(f.root.textContent!)).toEqual(incomplete)
    expect(f.saved()).toEqual({})
    expect(f.settings.failedOperations.value.size).toBe(0)
    read.resolve(catalog({ understand: native }))
    await refreshing
    expect(f.settings.policy('understand')).toEqual(incomplete)
    f.settings.change('generate', selected)
    await f.idle()
    expect(f.saved()).toEqual({ understand: native, generate: selected })
    expect(f.settings.policy('understand')).toEqual(incomplete)
    f.settings.change('understand', alternate)
    await f.idle()
    expect(f.saved()).toEqual({ understand: alternate, generate: selected })
  })

  it('serializes full-object writes and preserves newer drafts while a previous write completes', async () => {
    const f = fixture()
    await f.ready()
    const first = deferred<void>()
    const second = deferred<void>()
    f.pauseNextSave(first.promise)
    f.pauseNextSave(second.promise)
    f.settings.change('understand', selected)
    f.settings.change('understand', alternate)
    f.settings.change('generate', selected)
    expect(f.settings.savingOperations.value).toEqual(new Set(['understand', 'generate']))
    expect(f.images.save).toHaveBeenCalledTimes(1)
    expect(f.saved()).toEqual({})
    first.resolve()
    await vi.waitFor(() => expect(f.images.save).toHaveBeenCalledTimes(2))
    expect(f.saved()).toEqual({ understand: selected })
    expect(f.settings.policy('understand')).toEqual(alternate)
    expect(f.images.save.mock.calls[1]?.[0]).toEqual({ understand: alternate, generate: selected })
    second.resolve()
    await f.idle()
    expect(f.saved()).toEqual({ understand: alternate, generate: selected })
  })

  it('keeps a newer incomplete draft when an older valid write succeeds', async () => {
    const f = fixture()
    await f.ready()
    const write = deferred<void>()
    f.pauseNextSave(write.promise)
    f.settings.change('understand', selected)
    f.settings.change('understand', alternate)
    f.settings.change('understand', incomplete)
    f.settings.change('generate', native)
    write.resolve()
    await f.idle()
    expect(f.saved()).toEqual({ understand: selected, generate: native })
    expect(f.settings.policy('understand')).toEqual(incomplete)
    expect(f.settings.failedOperations.value.size).toBe(0)
  })

  it('retains a failed field for explicit retry while another field persists independently', async () => {
    const f = fixture()
    await f.ready()
    const write = deferred<void>()
    f.pauseNextSave(write.promise)
    f.settings.change('understand', selected)
    write.reject(new Error('write failed'))
    await f.idle()
    expect(f.settings.failedOperations.value).toEqual(new Set(['understand']))
    expect(f.settings.policy('understand')).toEqual(selected)
    f.settings.change('generate', alternate)
    await f.idle()
    expect(f.saved()).toEqual({ generate: alternate })
    expect(f.settings.failedOperations.value).toEqual(new Set(['understand']))
    expect(f.images.save).toHaveBeenCalledTimes(2)
    f.settings.retry('understand')
    await f.idle()
    expect(f.saved()).toEqual({ understand: selected, generate: alternate })
    expect(f.settings.failedOperations.value.size).toBe(0)
  })

  it('does not mark a newer edit failed when an older write rejects', async () => {
    const f = fixture()
    await f.ready()
    const write = deferred<void>()
    f.pauseNextSave(write.promise)
    f.settings.change('understand', selected)
    f.settings.change('understand', alternate)
    write.reject(new Error('old write failed'))
    await f.idle()
    expect(f.saved()).toEqual({ understand: alternate })
    expect(f.settings.policy('understand')).toEqual(alternate)
    expect(f.settings.failedOperations.value.size).toBe(0)
  })

  it.each(['auto', 'native'] as const)('preserves legacy %s OCR until cleared without changing vision or other image policies', async (mode) => {
    const extract: ImagePolicy = { ...selected, mode, fallbacks: [alternate.target!] }
    const retained = { understand: selected, document: alternate, generate: native, edit: alternate }
    const f = fixture({ ...retained, extract })
    await f.ready()
    expect(f.settings.legacy('extract')).toEqual(extract)
    expect(f.saved()).toEqual({ ...retained, extract })
    f.settings.inherit('extract')
    await f.idle()
    expect(f.settings.legacy('extract')).toBeUndefined()
    expect(f.settings.policy('understand')).toEqual(selected)
    expect(f.saved()).toEqual({ ...retained, ocrEnabled: true })
  })

  it('persists inheritance as property deletion and retries a failed deletion', async () => {
    const f = fixture({ understand: selected, edit: selected, document: alternate })
    await f.ready()
    const write = deferred<void>()
    f.pauseNextSave(write.promise)
    f.settings.inherit('edit')
    f.settings.inherit('document')
    write.reject(new Error('deletion failed'))
    await f.idle()
    expect(f.saved()).toEqual({ understand: selected, edit: selected })
    expect(f.settings.legacy('edit')).toBeUndefined()
    expect(f.settings.failedOperations.value).toEqual(new Set(['edit']))
    f.settings.retry('edit')
    await f.idle()
    expect(f.saved()).toEqual({ understand: selected })
    expect(f.settings.failedOperations.value.size).toBe(0)
  })

  it('refreshes provider changes after saving and ignores a catalog started before the write', async () => {
    const f = fixture()
    await f.ready()
    const earlier = deferred<ImageCatalog>()
    f.images.catalog.mockReturnValueOnce(earlier.promise)
    const refreshing = f.settings.refresh()
    const write = deferred<void>()
    f.pauseNextSave(write.promise)
    f.settings.change('understand', selected)
    f.changed()
    earlier.resolve(catalog({ understand: native }))
    await refreshing
    expect(f.settings.policy('understand')).toEqual(selected)
    const refreshed = catalog({ understand: selected })
    refreshed.readingCandidates.push({ target: selected.target!, title: 'Vision ready', owner: 'Fixture', managementPage: true, available: true, support: { operations: ['understand'] } })
    f.images.catalog.mockResolvedValueOnce(refreshed)
    write.resolve()
    await f.idle()
    await vi.waitFor(() => expect(f.settings.candidates.value[0]?.title).toBe('Vision ready'))
    expect(f.saved()).toEqual({ understand: selected })
    expect(f.settings.policy('understand')).toEqual(selected)
  })

  it('drains edits queued before unmount without applying late results to the disposed view', async () => {
    const f = fixture()
    await f.ready()
    const earlier = deferred<ImageCatalog>()
    f.images.catalog.mockReturnValueOnce(earlier.promise)
    const refreshing = f.settings.refresh()
    const write = deferred<void>()
    f.pauseNextSave(write.promise)
    f.settings.change('understand', selected)
    f.settings.change('generate', alternate)
    f.changed()
    f.unmount()
    const statusBeforeUnmount = f.settings.savingOperations.value
    earlier.reject(new Error('late catalog failure'))
    write.resolve()
    await refreshing
    await vi.waitFor(() => expect(f.saved()).toEqual({ understand: selected, generate: alternate }))
    expect(f.settings.savingOperations.value).toBe(statusBeforeUnmount)
    expect(f.settings.failed.value).toBe(false)
    expect(f.settings.failedOperations.value.size).toBe(0)
    expect(f.images.catalog).toHaveBeenCalledTimes(2)
    f.settings.change('generate', native)
    expect(f.settings.policy('generate')).toEqual(alternate)
  })

  it.each([{ initial: {}, enabled: false }, { initial: { extract: selected }, enabled: true }])('preserves the OCR switch while changing and clearing legacy policies', async ({ initial, enabled }) => {
    const f = fixture(initial)
    await f.ready()
    expect(f.settings.ocrEnabled.value).toBe(enabled)
    expect(f.saved()).toEqual(initial)
    f.settings.change('extract', alternate)
    await f.idle()
    expect(f.settings.ocrEnabled.value).toBe(enabled)
    expect(f.saved()).toEqual({ ocrEnabled: enabled, extract: alternate })
    f.settings.inherit('extract')
    await f.idle()
    expect(f.settings.ocrEnabled.value).toBe(enabled)
    expect(f.saved()).toEqual({ ocrEnabled: enabled })
  })

  it('retains the OCR service and its order when disabled and restored', async () => {
    const extract = { ...selected, fallbacks: [alternate.target!] }
    const f = fixture({ extract, understand: native })
    await f.ready()
    f.settings.changeOcrEnabled(false)
    await f.idle()
    expect(f.settings.ocrEnabled.value).toBe(false)
    expect(f.saved()).toEqual({ extract, understand: native, ocrEnabled: false })
    f.settings.changeOcrEnabled(true)
    await f.idle()
    expect(f.saved()).toEqual({ extract, understand: native, ocrEnabled: true })
  })

  it('serializes switch and policy edits without discarding an incomplete model draft', async () => {
    const f = fixture({ extract: selected })
    await f.ready()
    const write = deferred<void>()
    f.pauseNextSave(write.promise)
    f.settings.change('understand', incomplete)
    f.settings.changeOcrEnabled(false)
    f.settings.changeOcrEnabled(true)
    f.settings.change('extract', alternate)
    f.settings.change('generate', native)
    expect(f.images.save).toHaveBeenCalledTimes(1)
    expect(f.settings.ocrEnabled.value).toBe(true)
    write.resolve()
    await f.idle()
    expect(f.saved()).toEqual({ ocrEnabled: true, extract: alternate, generate: native })
    expect(f.settings.policy('understand')).toEqual(incomplete)
    await f.settings.refresh()
    expect(f.settings.policy('understand')).toEqual(incomplete)
    expect(f.settings.ocrEnabled.value).toBe(true)
  })

  it('keeps failed switch changes retryable after a legacy policy saves', async () => {
    const f = fixture({ extract: selected, ocrEnabled: true })
    await f.ready()
    const write = deferred<void>()
    f.pauseNextSave(write.promise)
    f.settings.changeOcrEnabled(false)
    write.reject(new Error('switch save failed'))
    await f.idle()
    expect(f.settings.failedOperations.value).toEqual(new Set(['extract']))
    f.settings.change('extract', alternate)
    await f.idle()
    expect(f.saved()).toEqual({ ocrEnabled: true, extract: alternate })
    expect(f.settings.ocrEnabled.value).toBe(false)
    expect(f.settings.failedOperations.value).toEqual(new Set(['extract']))
    f.settings.retry('extract')
    await f.idle()
    expect(f.saved()).toEqual({ ocrEnabled: false, extract: alternate })
    expect(f.settings.failedOperations.value.size).toBe(0)
  })
})
