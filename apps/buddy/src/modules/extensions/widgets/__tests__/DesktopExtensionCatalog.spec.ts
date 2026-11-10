// @vitest-environment jsdom
import type { ExtensionCatalogSnapshot } from '@buddy-shared/extensions/extensionCatalog'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef } from 'vue'
import { useExtensionCatalog } from '../../state/useExtensionCatalog'
import DesktopExtensionCatalog from '../DesktopExtensionCatalog.vue'

const context = vi.hoisted(() => ({ read: () => ({}) }))
vi.mock('../../extensionContext', () => ({ useExtensionContext: () => context.read() }))
const cleanup: Array<() => void> = []

function catalogHost() {
  return defineComponent({
    setup() {
      const { snapshot, loading, error, refresh } = useExtensionCatalog((context.read() as { state: { api: Parameters<typeof useExtensionCatalog>[0] } }).state.api)
      return () => h(DesktopExtensionCatalog, { snapshot: snapshot.value, loading: loading.value, error: error.value, onRefresh: () => void refresh(true) })
    },
  })
}
afterEach(() => {
  for (const action of cleanup.splice(0).reverse()) action()
})

it('shows only the loading spinner without an empty placeholder while loading the catalog', async () => {
  let resolveFirst!: (value: ExtensionCatalogSnapshot) => void
  let resolveSecond!: (value: ExtensionCatalogSnapshot) => void
  let resolveThird!: (value: ExtensionCatalogSnapshot) => void
  const catalog = vi.fn()
    .mockImplementationOnce(() => new Promise<ExtensionCatalogSnapshot>((resolve) => { resolveFirst = resolve }))
    .mockImplementationOnce(() => new Promise<ExtensionCatalogSnapshot>((resolve) => { resolveSecond = resolve }))
    .mockImplementationOnce(() => new Promise<ExtensionCatalogSnapshot>((resolve) => { resolveThird = resolve }))
  context.read = () => ({ state: { installed: shallowRef([]), unavailable: shallowRef([]), busyIds: new Set<string>(), api: { catalog } }, language: shallowRef('zh-CN') })
  const element = document.createElement('div')
  document.body.append(element)
  const app = createApp(catalogHost())
  cleanup.push(() => {
    app.unmount()
    element.remove()
  })
  app.mount(element)
  await nextTick()
  expect(element.querySelector('[data-testid="catalog-loading"]')).not.toBeNull()
  expect(element.querySelector('.n-spin-body')).not.toBeNull()
  expect(element.querySelector('.n-empty')).toBeNull()

  resolveFirst({ plugins: [], invalidEntries: 0, error: 'EXTENSION_CATALOG_UNAVAILABLE', stale: true, cachedAt: null })
  await vi.waitFor(() => expect(element.querySelector('.n-empty')).not.toBeNull())
  expect(element.querySelector('[data-testid="catalog-loading"]')).toBeNull()

  // Retrying from an empty snapshot replaces the empty placeholder with the spinner again.
  const refreshButton = () => Array.from(element.querySelectorAll('button')).find(button => button.textContent?.includes('刷新'))!
  refreshButton().click()
  await nextTick()
  expect(element.querySelector('[data-testid="catalog-loading"]')).not.toBeNull()
  expect(element.querySelector('.n-empty')).toBeNull()

  const loadedSnapshot: ExtensionCatalogSnapshot = {
    plugins: [{
      manifest: extensionManifestSchema.parse({ schemaVersion: 1, id: 'tests.loaded', name: 'Loaded Plugin', version: '1.0.0', apiVersion: 4, engines: { lexora: '>=0.9.0' }, permissions: {}, contributes: {} }),
      repository: 'https://github.com/useLexora/Lexora',
      artifact: { url: 'https://example.com/a.lexora-extension', sha256: 'a'.repeat(64), size: 100 },
      compatible: true,
      incompatibility: null,
    }],
    invalidEntries: 0,
    error: null,
    stale: false,
    cachedAt: null,
  }
  resolveSecond(loadedSnapshot)
  await vi.waitFor(() => expect(element.querySelector('[data-catalog-id="tests.loaded"]')).not.toBeNull())
  expect(element.querySelector('[data-testid="catalog-loading"]')).toBeNull()
  expect(element.querySelector('.n-empty')).toBeNull()

  // Refreshing a non-empty catalog keeps existing cards visible instead of reverting to the full-area spinner.
  refreshButton().click()
  await nextTick()
  expect(element.querySelector('[data-catalog-id="tests.loaded"]')).not.toBeNull()
  expect(element.querySelector('[data-testid="catalog-loading"]')).toBeNull()
  resolveThird(loadedSnapshot)
  await vi.waitFor(() => expect(refreshButton().classList.contains('n-button--loading')).toBe(false))
})
