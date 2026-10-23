// @vitest-environment jsdom
import type { ExtensionReview } from '@buddy-shared/extensions/extensionApi'
import type { FileOpeningChoice } from '@buddy-shared/files/fileOpening'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { afterEach, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import DesktopExtensionInstallReview from '../DesktopExtensionInstallReview.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
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
  const root = document.createElement('div')
  document.body.append(root)
  const submissions: { applyUpdate: boolean, choices: FileOpeningChoice[] }[] = []
  const app = createApp({ render: () => h(DesktopExtensionInstallReview, {
    review: value,
    language: 'en-US',
    busy: false,
    onInstall: (applyUpdate: boolean, choices: FileOpeningChoice[]) => submissions.push({ applyUpdate, choices }),
  }) })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  await nextTick()
  const content = document.querySelector<HTMLElement>('[data-testid="extension-file-associations"]')!
  const submit = () => document.querySelector<HTMLButtonElement>('[data-testid="extension-confirm-install"]')!.click()
  return { content, submissions, submit }
}

it('preselects requested associations and keeps existing defaults when replacements are cleared', async () => {
  const { content, submissions, submit } = await mount()
  expect(content.textContent).toContain('.md')
  expect(content.textContent).toContain('File preview')
  expect(content.textContent).toContain('Open separately')
  expect(content.querySelector('tbody')?.textContent).toContain('Reader')
  const checkboxes = content.querySelectorAll<HTMLElement>('[role="checkbox"]')
  expect(checkboxes[0]?.getAttribute('aria-checked')).toBe('true')
  expect(checkboxes[1]?.getAttribute('aria-checked')).toBe('true')
  submit()
  expect(submissions).toEqual([{ applyUpdate: true, choices: [{ extension: '.md', location: 'inline', providerId: 'test.reader' }] }])
  checkboxes[0]!.click()
  await nextTick()
  submit()
  expect(submissions.at(-1)).toEqual({ applyUpdate: true, choices: [] })
  expect(checkboxes[1]?.getAttribute('aria-checked')).toBe('true')
})

it('lets users clear and reselect existing defaults individually or by column during an update', async () => {
  const existing = review.fileAssociations![1]!
  const { content, submissions, submit } = await mount({
    ...review,
    currentVersion: '0.9.0',
    fileAssociations: [existing, { ...existing, extension: '.txt' }],
  })
  const selectAll = content.querySelector<HTMLElement>('thead [role="checkbox"]')!
  const first = content.querySelector<HTMLElement>('tbody [role="checkbox"]')!
  expect(selectAll.getAttribute('aria-checked')).toBe('true')
  first.click()
  await nextTick()
  expect(first.getAttribute('aria-checked')).toBe('false')
  expect(selectAll.getAttribute('aria-checked')).toBe('mixed')
  selectAll.click()
  await nextTick()
  expect(content.querySelectorAll('tbody [aria-checked="true"]')).toHaveLength(2)
  selectAll.click()
  await nextTick()
  expect(content.querySelectorAll('tbody [aria-checked="true"]')).toHaveLength(0)
  submit()
  expect(submissions).toEqual([{ applyUpdate: true, choices: [] }])
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

it('preselects the first requested provider when several providers apply to the same location', async () => {
  const { content, submissions, submit } = await mount({
    ...review,
    fileAssociations: [
      { ...review.fileAssociations![0]!, requestDefault: false },
      { ...review.fileAssociations![0]!, providerId: 'test.alternate', title: 'Alternate' },
      { ...review.fileAssociations![0]!, providerId: 'test.third', title: 'Third' },
    ],
  })
  const checked = content.querySelectorAll('tbody [aria-checked="true"]')
  expect(checked).toHaveLength(1)
  expect(checked[0]?.textContent).toContain('Alternate')
  submit()
  expect(submissions.at(-1)?.choices).toEqual([{ extension: '.md', location: 'inline', providerId: 'test.alternate' }])
})
