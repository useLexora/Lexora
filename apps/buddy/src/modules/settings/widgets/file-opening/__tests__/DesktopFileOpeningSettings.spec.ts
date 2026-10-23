// @vitest-environment jsdom
import type { ExtensionApi } from '@buddy-shared/extensions/extensionApi'
import type { FileOpeningChoice, FileOpeningSnapshot } from '@buddy-shared/files/fileOpening'
import type { FileOpeningState } from '@/modules/files'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { useProvideFileOpening } from '@/modules/files'
import DesktopFileOpeningSettings from '../DesktopFileOpeningSettings.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
const initial: FileOpeningSnapshot = {
  providers: [
    { id: 'lexora.markdown', title: 'Markdown 阅读器', titleEn: 'Markdown reader', extensions: ['.md'], locations: ['inline', 'standalone'], builtin: true, available: true, renderer: 'markdown', recommended: true },
    { id: 'test.reader', title: '插件阅读器', titleEn: 'Plugin reader', extensions: ['.md'], locations: ['inline'], builtin: false, available: true, renderer: 'extension', extensionId: 'test', extensionName: 'Reader Studio' },
    { id: 'test.disabled', title: 'Disabled reader', extensions: ['.md'], locations: ['inline'], builtin: false, available: false, renderer: 'extension' },
  ],
  defaults: { '.md': { inline: 'test.removed' }, '.unknown': { inline: 'test.removed' } },
}

async function mount(overrides: Partial<Pick<ExtensionApi, 'fileOpeners' | 'setFileOpener'>> = {}) {
  const scrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value() {} })
  const root = document.createElement('div')
  document.body.append(root)
  const api: Pick<ExtensionApi, 'fileOpeners' | 'setFileOpener' | 'onChanged'> = { fileOpeners: async () => initial, setFileOpener: async () => initial, onChanged: () => () => {}, ...overrides }
  let state!: FileOpeningState
  const app = createApp({ setup() {
    state = useProvideFileOpening(api)
    return () => h(DesktopFileOpeningSettings, { language: 'en-US' })
  } })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
    if (scrollTo)
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollTo)
    else
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
  })
  await state.ready.catch(() => {})
  await nextTick()
  return { root, state, api }
}

async function options(root: HTMLElement, location = 0) {
  const select = root.querySelectorAll<HTMLElement>('.n-select')[location]!
  select.querySelector<HTMLElement>('.n-base-selection')!.click()
  await nextTick()
  const entries = () => [...document.querySelectorAll<HTMLElement>('.n-base-select-option')].filter(option => !option.closest('[style*="display: none"]'))
  await vi.waitFor(() => expect(entries().length).toBeGreaterThan(0))
  return entries()
}

it('lists only registered suffixes with separate locations and preserves unavailable defaults', async () => {
  const { root, state } = await mount()
  expect([...root.querySelectorAll('tbody th')].map(element => element.textContent)).toEqual(['.md'])
  expect(root.querySelectorAll('.n-select')).toHaveLength(2)
  expect(root.textContent).toContain('File preview')
  expect(root.textContent).toContain('Open separately')
  expect(root.textContent).toContain('test.removed')
  expect(root.textContent).toContain('Temporarily using Markdown reader')
  const entries = await options(root)
  expect(entries.some(option => option.textContent?.includes('Plugin reader'))).toBe(true)
  expect(entries.some(option => option.textContent?.includes('Disabled reader'))).toBe(false)
  const unavailable = entries.find(option => option.textContent?.includes('test.removed'))!
  unavailable.click()
  await nextTick()
  expect(state.snapshot.value.defaults).toEqual(initial.defaults)
})

it('waits for persistence, reports failure in the affected field, and saves the selected builtin provider on success', async () => {
  const saving = deferred<FileOpeningSnapshot>()
  const choices: FileOpeningChoice[] = []
  const { root, state, api } = await mount({ setFileOpener: (choice) => {
    choices.push(choice)
    return saving.promise
  } })
  let entries = await options(root)
  entries.find(option => option.textContent?.includes('Markdown reader'))!.click()
  await nextTick()
  expect(state.snapshot.value.defaults['.md']?.inline).toBe('test.removed')
  expect(root.querySelectorAll('.n-base-selection--disabled')).toHaveLength(1)
  saving.reject(new Error('SAVE_FAILED'))
  await vi.waitFor(() => expect(root.textContent).toContain('Could not save'))
  expect(state.snapshot.value.defaults).toEqual(initial.defaults)
  api.setFileOpener = async (choice) => {
    choices.push(choice)
    return { ...initial, defaults: { ...initial.defaults, '.md': { inline: choice.providerId! } } }
  }
  entries = await options(root)
  entries.find(option => option.textContent?.includes('Markdown reader'))!.click()
  await vi.waitFor(() => expect(state.snapshot.value.defaults['.md']?.inline).toBe('lexora.markdown'))
  expect(choices).toEqual([
    { extension: '.md', location: 'inline', providerId: 'lexora.markdown' },
    { extension: '.md', location: 'inline', providerId: 'lexora.markdown' },
  ])
  expect(root.textContent).not.toContain('Could not save')
  expect(state.snapshot.value.defaults['.unknown']).toEqual(initial.defaults['.unknown'])
})

it('shows the effective builtin as one real choice and disables positions with no available opener', async () => {
  const provider = initial.providers[0]!
  const { root, state } = await mount({ fileOpeners: async () => ({ providers: [{ ...provider, locations: ['inline'] }], defaults: {} }) })
  const controls = root.querySelectorAll('.n-select')
  expect(controls[0]?.textContent).toContain('Markdown reader')
  expect(controls[1]?.textContent).toContain('No available opener')
  expect(controls[1]?.querySelector('.n-base-selection--disabled')).not.toBeNull()
  const entries = await options(root)
  expect(entries).toHaveLength(1)
  expect(entries[0]?.textContent).toContain('Markdown reader')
  expect(entries[0]?.textContent).toContain('Built-in')
  expect(state.snapshot.value.defaults).toEqual({})
})

it('distinguishes identical opener and plugin names by origin while saving provider identity', async () => {
  const builtin = initial.providers[0]!
  const plugin = { ...initial.providers[1]!, title: builtin.title, titleEn: builtin.titleEn }
  const snapshot: FileOpeningSnapshot = {
    providers: [builtin, plugin, { ...plugin, id: 'other.reader', extensionId: 'other' }],
    defaults: {},
  }
  const { root, state } = await mount({
    fileOpeners: async () => snapshot,
    setFileOpener: async choice => ({ ...snapshot, defaults: { '.md': { inline: choice.providerId! } } }),
  })
  const entries = await options(root)
  expect(entries).toHaveLength(3)
  expect(entries[0]?.textContent).toContain('Built-in')
  expect(entries[1]?.textContent).toContain('Reader Studio (test)')
  expect(entries[2]?.textContent).toContain('Reader Studio (other)')
  entries[2]!.click()
  await vi.waitFor(() => expect(state.snapshot.value.defaults['.md']?.inline).toBe('other.reader'))
  expect(root.querySelector('.n-select')?.textContent).toContain('Reader Studio (other)')
})

it('shows failed initial loading and retries without pretending builtin defaults were fetched', async () => {
  const { root, api } = await mount({ fileOpeners: async () => {
    throw new Error('READ_FAILED')
  } })
  expect(root.textContent).toContain('Could not load file opening preferences')
  expect(root.querySelectorAll('.n-base-selection--disabled').length).toBeGreaterThan(0)
  api.fileOpeners = async () => initial
  root.querySelector<HTMLButtonElement>('button')!.click()
  await vi.waitFor(() => expect(root.textContent).not.toContain('Could not load file opening preferences'))
  expect(root.textContent).toContain('test.removed')
  expect(root.querySelectorAll('.n-select')).toHaveLength(2)
})
