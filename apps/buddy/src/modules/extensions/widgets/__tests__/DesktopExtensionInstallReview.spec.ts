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

const capabilityReview: ExtensionReview = {
  ...review,
  fileAssociations: [],
  manifest: extensionManifestSchema.parse({
    ...review.manifest,
    id: 'tests.legal',
    apiVersion: 4,
    contributes: {
      skills: [{ id: 'tests.legal.statutes', path: 'skills/statutes/SKILL.md' }],
      mcpConnectors: [{ id: 'legal-search', name: 'Legal search', transport: 'streamable-http', url: 'https://legal.example.com/mcp', authentication: 'bearer' }],
      subagents: [
        { id: 'law-finder', name: 'Law finder', description: 'Finds statutes', instructions: 'Search statutes first.', tools: [{ source: 'mcp', connector: 'legal-search', name: 'statutes/search' }, { source: 'builtin', name: 'read' }], skills: ['tests.legal.statutes'], requiredSkills: ['tests.legal.statutes'], fileAccess: 'inherit' },
        { id: 'file-reader', name: 'File reader', instructions: 'Read files.', tools: [{ source: 'builtin', name: 'ls' }], fileAccess: 'read_only' },
      ],
    },
  }),
}

async function mount(value: ExtensionReview = review, language = 'en-US', busy = false) {
  const current = shallowRef(value)
  const root = document.createElement('div')
  document.body.append(root)
  const submissions: { applyUpdate: boolean, choices: FileOpeningChoice[] }[] = []
  const cancellations: boolean[] = []
  const app = createApp({ render: () => h(DesktopExtensionInstallReview, {
    review: current.value,
    language,
    busy,
    onCancel: () => cancellations.push(true),
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
  const dialog = document.querySelector<HTMLElement>('[data-testid="extension-install-review"]')!
  return { content, submissions, submit, dialog, current, cancellations }
}

it.each(['en-US', 'zh-CN'])('reviews each requested data source separately from message access in %s', async (language) => {
  const { current } = await mount({
    ...review,
    currentVersion: '0.9.0',
    addedPermissions: ['data:context.usage'],
    manifest: extensionManifestSchema.parse({ ...review.manifest, permissions: { data: ['task.metrics', 'context.usage'], network: ['https://metrics.example.com'] } }),
  }, language)
  const permissions = document.querySelector('[data-testid="extension-review-permissions"]')!
  const text = permissions.textContent ?? ''
  expect(text).toContain(language === 'en-US' ? 'Bound data sources' : '绑定范围的数据源')
  expect(text).toContain(language === 'en-US' ? 'Task metrics' : '任务统计')
  expect(text).toContain(language === 'en-US' ? 'Context usage' : '上下文用量')
  expect(text).toContain(language === 'en-US' ? 'No message text, logs or credentials' : '不读取正文、日志或凭据')
  expect(text).toContain(language === 'en-US' ? 'New' : '新增')
  expect(text).not.toContain(language === 'en-US' ? 'Read messages' : '读取消息')
  expect(document.querySelector('[data-testid="extension-content-sharing-warning"]')).not.toBeNull()
  current.value = { ...review, fileAssociations: [] }
  await nextTick()
  expect(document.querySelector('[data-testid="extension-review-permissions"]')).toBeNull()
})

it('allows closing a duplicate review while the plugin is busy without submitting another install', async () => {
  const { dialog, submissions, cancellations } = await mount(review, 'en-US', true)
  expect(dialog.querySelector<HTMLButtonElement>('[data-testid="extension-confirm-install"]')!.disabled).toBe(true)
  const cancel = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Cancel')!
  expect(cancel.disabled).toBe(false)
  cancel.click()
  expect(cancellations).toEqual([true])
  expect(submissions).toEqual([])
})

it('preselects requested associations and keeps existing defaults when replacements are cleared', async () => {
  const { content, submissions, submit } = await mount({
    ...review,
    manifest: extensionManifestSchema.parse({
      ...review.manifest,
      apiVersion: 4,
      contributes: { skills: [{ id: 'test.panel.review', path: 'skills/review/SKILL.md' }] },
    }),
  })
  expect(document.querySelector('[data-testid="extension-included-skills"] li')?.textContent?.trim()).toBe('review')
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

it('prioritizes NPCs and progressively discloses their capabilities', async () => {
  const { submit, submissions } = await mount(capabilityReview)
  const text = (selector: string) => document.querySelector(selector)?.textContent ?? ''
  expect(text('[data-testid="extension-included-mcp"]')).toContain('https://legal.example.com/mcp')
  expect(document.querySelector('[data-testid="extension-review-permissions"]')).toBeNull()
  const sections = [...document.querySelectorAll('section[data-testid]')].map(section => section.getAttribute('data-testid'))
  expect(sections.slice(0, 3)).toEqual(['extension-included-agents', 'extension-included-mcp', 'extension-included-skills'])
  expect(text('[data-testid="extension-included-mcp"]')).toContain('Token authentication')
  expect(text('[data-testid="extension-included-mcp"]')).toContain('Off by default')
  expect(text('[data-subagent-id="law-finder"]')).toContain('Tools 2 · Skills 1')
  expect(text('[data-subagent-id="law-finder"]')).toContain('File access follows the current task')
  expect(text('[data-subagent-id="file-reader"]')).toContain('Can read files but not change them')
  expect(document.querySelector('[data-testid="extension-agent-details"]')).toBeNull()
  const agent = document.querySelector('[data-subagent-id="law-finder"]')!
  const toggle = agent.querySelector<HTMLButtonElement>('[data-testid="extension-agent-details-toggle"]')!
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(agent.querySelector('.n-base-selection')).toBeNull()
  expect(agent.querySelector('img[data-testid="extension-subagent-avatar"]')?.getAttribute('src')).toContain('npc-slate')
  expect(text('[data-testid="extension-included-agents"] h3')).toContain('NPC')
  toggle.click()
  await nextTick()
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(document.getElementById(toggle.getAttribute('aria-controls')!)).not.toBeNull()
  expect(text('[data-subagent-id="law-finder"]')).toContain('statutes/search')
  expect(text('[data-subagent-id="law-finder"]')).toContain('Legal search')
  expect(text('[data-subagent-id="law-finder"]')).toContain('Built-in tool')
  expect(text('[data-subagent-id="law-finder"]')).toContain('Required')
  expect(text('[data-subagent-id="law-finder"]')).toContain('tests.legal.statutes')
  expect(document.querySelector('[data-subagent-id="file-reader"] [data-testid="extension-agent-details"]')).toBeNull()
  toggle.click()
  await nextTick()
  expect(document.querySelector('[data-testid="extension-agent-details"]')).toBeNull()
  submit()
  expect(submissions.at(-1)).toEqual({ applyUpdate: true, choices: [] })
})

it.each(['en-US', 'zh-CN'])('presents NPCs consistently in %s and submits registration without team configuration', async (language) => {
  const { submit, submissions } = await mount({ ...capabilityReview, currentVersion: '0.9.0' }, language)
  expect(document.querySelector('[data-testid="extension-included-agents"] h3')?.textContent).toContain('NPC')
  submit()
  expect(submissions.at(-1)).toEqual({ applyUpdate: true, choices: [] })
})

it('resets expanded capability details when reviewing a different package', async () => {
  const { current } = await mount(capabilityReview)
  document.querySelector<HTMLButtonElement>('[data-testid="extension-agent-details-toggle"]')!.click()
  await nextTick()
  expect(document.querySelector('[data-testid="extension-agent-details"]')).not.toBeNull()
  current.value = { ...capabilityReview, token: 'another-review' }
  await nextTick()
  expect(document.querySelector('[data-testid="extension-agent-details-toggle"]')?.getAttribute('aria-expanded')).toBe('false')
})

it('shows neither group for a package that contributes none', async () => {
  await mount({ ...review, fileAssociations: [] })
  expect(document.querySelector('[data-testid="extension-included-mcp"]')).toBeNull()
  expect(document.querySelector('[data-testid="extension-included-agents"]')).toBeNull()
})
