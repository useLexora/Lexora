// @vitest-environment jsdom
import type { ExtensionReview } from '@buddy-shared/extensions/extensionApi'
import type { FileOpeningChoice } from '@buddy-shared/files/fileOpening'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import DesktopExtensionInstallReview from '../DesktopExtensionInstallReview.vue'

vi.hoisted(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: new DOMRect(0, 0, 400, 272) } as ResizeObserverEntry], this as unknown as ResizeObserver)
    }

    unobserve() {}
    disconnect() {}
  })
})
const cleanups: (() => void)[] = []
beforeEach(() => {
  vi.stubGlobal('matchMedia', (media: string) => ({ matches: false, media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }))
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value() {} })
})
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  document.body.innerHTML = ''
})
const review: ExtensionReview = {
  token: 'review-token',
  manifest: extensionManifestSchema.parse({ schemaVersion: 1, id: 'test.panel', name: 'Reader', version: '1.0.0', apiVersion: 1, engines: { lexora: '*' }, contributes: {} }),
  sha256: 'hash',
  development: false,
  currentVersion: null,
  addedPermissions: [],
  fileAssociations: [
    { extension: '.md', location: 'inline', providerId: 'test.reader', title: 'Reader', currentProviderId: 'lexora.markdown', requestDefault: true },
    { extension: '.md', location: 'standalone', providerId: 'test.reader', title: 'Reader', currentProviderId: 'test.reader', requestDefault: true },
  ],
}

async function mount(value: ExtensionReview = review) {
  const current = shallowRef(value)
  const root = document.createElement('div')
  document.body.append(root)
  const submissions: { applyUpdate: boolean, choices: FileOpeningChoice[] }[] = []
  const acceptances: boolean[] = []
  const app = createApp({ render: () => h(DesktopExtensionInstallReview, {
    review: current.value,
    language: 'en-US',
    busy: false,
    onInstall: (applyUpdate: boolean, choices: FileOpeningChoice[], acceptUnverified: boolean) => {
      submissions.push({ applyUpdate, choices })
      acceptances.push(acceptUnverified)
    },
  }) })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  await nextTick()
  const content = document.querySelector<HTMLElement>('[data-testid="extension-file-associations"]')!
  const submit = () => document.querySelector<HTMLButtonElement>('[data-testid="extension-confirm-install"]')!.click()
  return { content, submissions, submit, current, acceptances }
}

it('requires a new risk acknowledgement for each unverified review while showing its actual permissions', async () => {
  const unverified: ExtensionReview = {
    ...review,
    manifest: extensionManifestSchema.parse({ ...review.manifest, permissions: { network: ['https://changed.example.com'] } }),
    source: { catalog: 'https://example.com/catalog', artifact: 'https://example.com/plugin.zip', sha256: 'b'.repeat(64), mismatch: { expectedSha256: 'a'.repeat(64), expectedSize: 10, actualSize: 11 } },
  }
  const { current, submit, submissions, acceptances } = await mount(unverified)
  const button = document.querySelector<HTMLButtonElement>('[data-testid="extension-confirm-install"]')!
  expect(document.querySelector('[data-testid="extension-verification-warning"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="extension-review-permissions"]')?.textContent).toContain('https://changed.example.com')
  expect(button.disabled).toBe(true)
  submit()
  expect(submissions).toEqual([])
  document.querySelector<HTMLElement>('[data-testid="extension-accept-unverified"]')!.click()
  await nextTick()
  expect(button.disabled).toBe(false)
  expect(button.textContent).toContain('Install anyway')
  submit()
  expect(acceptances).toEqual([true])
  current.value = { ...unverified, token: 'another-review' }
  await nextTick()
  expect(button.disabled).toBe(true)
  current.value = { ...review, token: 'verified-review' }
  await nextTick()
  expect(document.querySelector('[data-testid="extension-verification-warning"]')).toBeNull()
  expect(button.disabled).toBe(false)
  submit()
  expect(acceptances).toEqual([true, false])
})

it('leaves opt-out replacements unselected and supports individual and column selection independently', async () => {
  const { content, submissions, submit } = await mount({
    ...review,
    fileAssociations: [
      ...review.fileAssociations!.map(choice => ({ ...choice, requestDefault: false })),
      { ...review.fileAssociations![0]!, extension: '.txt', requestDefault: false },
      { ...review.fileAssociations![0]!, extension: '.txt', location: 'standalone', requestDefault: false },
    ],
  })
  const selectAll = content.querySelector<HTMLElement>('thead [role="checkbox"]')!
  const preview = content.querySelector<HTMLElement>('tbody [role="checkbox"]')!
  expect(preview.getAttribute('aria-checked')).toBe('false')
  expect(content.querySelectorAll('tbody [aria-checked="true"]')).toHaveLength(1)
  submit()
  expect(submissions.at(-1)?.choices).toEqual([])
  preview.click()
  await nextTick()
  expect(selectAll.getAttribute('aria-checked')).toBe('mixed')
  submit()
  expect(submissions.at(-1)?.choices).toEqual([{ extension: '.md', location: 'inline', providerId: 'test.reader' }])
  selectAll.click()
  await nextTick()
  expect(selectAll.getAttribute('aria-checked')).toBe('true')
  submit()
  expect(submissions.at(-1)?.choices).toEqual([
    { extension: '.md', location: 'inline', providerId: 'test.reader' },
    { extension: '.txt', location: 'inline', providerId: 'test.reader' },
  ])
  selectAll.click()
  await nextTick()
  submit()
  expect(submissions.at(-1)?.choices).toEqual([])
  expect(content.querySelectorAll('tbody [aria-checked="true"]')).toHaveLength(1)
})

it('can restore the current provider after selecting another provider for the same location', async () => {
  const { content, submissions, submit } = await mount({
    ...review,
    fileAssociations: [
      review.fileAssociations![1]!,
      { ...review.fileAssociations![1]!, providerId: 'test.alternate', title: 'Alternate' },
    ],
  })
  const [current, alternate] = content.querySelectorAll<HTMLElement>('tbody [role="checkbox"]')
  alternate!.click()
  await nextTick()
  expect(current!.getAttribute('aria-checked')).toBe('false')
  submit()
  expect(submissions.at(-1)?.choices).toEqual([{ extension: '.md', location: 'standalone', providerId: 'test.alternate' }])
  current!.click()
  await nextTick()
  expect(alternate!.getAttribute('aria-checked')).toBe('false')
  expect(current!.getAttribute('aria-checked')).toBe('true')
  submit()
  expect(submissions.at(-1)?.choices).toEqual([])
})
