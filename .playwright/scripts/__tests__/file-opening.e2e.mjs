import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { withArtifactPreview } from '../fixtures/artifact-preview.mjs'
import { expect, test } from '../fixtures/electron.mjs'

const { strToU8, zipSync } = createRequire(new URL('../../../apps/buddy/package.json', import.meta.url))('fflate/node')
const id = 'tests.file-opening'
const providerId = `${id}.reader`
const launcherId = `${id}.launch`
const title = 'Fixture Markdown reader'
const pluginName = 'Reader Studio'
const packageName = 'file-opening.lexora-extension'
const diskText = '# Saved Markdown\n\nThis paragraph is on disk.\n'
const draftText = '# Unsaved Markdown\n\nThis paragraph exists only in the working copy.\n'

async function renderReader(pluginId, mode, context, container) {
  container.dataset.fileOpeningFixture = pluginId
  container.dataset.fileOpeningMode = mode
  container.dataset.visible = String(context.visible)
  container.dataset.resource = JSON.stringify(context.resource)
  context.onVisibilityChange(visible => container.dataset.visible = String(visible))
  container.innerHTML = '<p role="status">Loading</p><pre data-testid="resource-text"></pre><label>Reader note <input></label><output data-testid="reader-note"></output><button data-testid="reference-content">Reference content</button><button data-testid="reference-file">Reference file</button><output data-testid="reference-result"></output><output data-testid="reference-location"></output><select aria-label="Reveal behavior"><option value="locate">Locate</option><option value="missing">No handler</option><option value="not-found">Not found</option><option value="throw">Fail</option></select>'
  const reference = async (input) => {
    const result = container.querySelector('[data-testid=reference-result]')
    result.textContent = 'Pending'
    try {
      result.textContent = String(await context.references.add(input))
    }
    catch (error) {
      result.textContent = String(error)
    }
  }
  container.querySelector('[data-testid=reference-content]').onclick = () => reference({ kind: 'content', title: container.querySelector('input').value || 'Report excerpt', text: 'Frozen report excerpt', locator: { version: 1, data: { block: 'summary' } } })
  container.querySelector('[data-testid=reference-file]').onclick = () => context.resource && reference({ kind: 'resource', resource: context.resource })
  let revealRegistration
  const revealBehavior = container.querySelector('select')
  const registerReveal = () => {
    revealRegistration?.dispose()
    if (revealBehavior.value === 'missing')
      return
    revealRegistration = context.references.onReveal((input, signal) => {
      if (revealBehavior.value === 'throw')
        throw new Error('Unable to locate')
      if (signal.aborted || revealBehavior.value === 'not-found' || input.locator?.version !== 1 || input.locator.data.block !== 'summary')
        return false
      container.querySelector('[data-testid=reference-location]').textContent = JSON.stringify(input.locator)
      return true
    })
  }
  revealBehavior.onchange = registerReveal
  registerReveal()
  const input = container.querySelector('input')
  input.addEventListener('input', () => container.querySelector('output').textContent = input.value)
  try {
    container.querySelector('pre').textContent = context.resource ? await context.resources.readText(context.resource) : 'No file selected'
    container.querySelector('[role=status]').textContent = 'Ready'
  }
  catch (error) {
    container.querySelector('[role=status]').textContent = String(error)
  }
}

async function prepare(directory, extensions = ['.md'], requestDefault, shared = false) {
  const manifest = {
    schemaVersion: 1,
    id,
    name: pluginName,
    version: '1.0.0',
    apiVersion: 4,
    engines: { lexora: '*' },
    entry: 'host.js',
    permissions: { selectedResource: 'read', references: true },
    contributes: {
      views: [{ id: `${id}.view`, title, entry: 'view.js', resource: 'optional-file' }, { id: `${id}.preview`, title: 'File preview', entry: 'preview.js', resource: 'selected-file' }],
      fileHandlers: [{ id: providerId, title, extensions, preview: { view: shared ? `${id}.view` : `${id}.preview`, requestDefault }, open: { view: `${id}.view` } }],
      launchers: [{ id: launcherId, title: 'Open fixture reader', view: `${id}.view` }],
    },
  }
  await fs.writeFile(path.join(directory, 'report.md'), diskText)
  await fs.writeFile(path.join(directory, packageName), zipSync({
    'extension.json': strToU8(JSON.stringify(manifest)),
    'host.js': strToU8('export function activate() {}'),
    'view.js': strToU8(`export const render = (...args) => (${renderReader.toString()})(${JSON.stringify(id)}, 'open', ...args)`),
    'preview.js': strToU8(`export const render = (...args) => (${renderReader.toString()})(${JSON.stringify(id)}, 'preview', ...args)`),
  }))
  return ['report.md', packageName]
}

const snapshot = page => page.evaluate(() => window.lexoraDesktop.extensions.fileOpeners())
const defaults = async page => (await snapshot(page)).defaults
const settings = page => page.evaluate(() => window.location.hash = '/settings/file-opening')
const tasks = page => page.locator('.desktop-app-sidebar').getByRole('button', { name: '任务', exact: true }).click()
const locationLabel = location => `.md · ${location === 'inline' ? '文件内预览' : '独立打开'}`

async function selectDefault(page, extension, location, label) {
  const control = page.getByLabel(`${extension} · ${location === 'inline' ? '文件内预览' : '独立打开'}`, { exact: true })
  await control.click()
  await page.locator('.n-base-select-option:visible').getByText(label, { exact: true }).click()
  await expect(page.locator('.n-base-select-menu:visible')).toHaveCount(0)
  await expect(control).toContainText(label)
}

async function install({ app, page, directory }, locations, requestDefault = true) {
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, path.join(directory, packageName))
  await page.getByTestId('extension-install-options').click()
  await page.getByTestId('extension-install').click()
  const review = page.getByTestId('extension-install-review')
  await expect(review).toBeVisible()
  const associations = review.getByTestId('extension-file-associations')
  await expect(associations.getByRole('checkbox')).toHaveCount(2)
  for (const location of ['inline', 'standalone']) {
    const checkbox = associations.getByRole('checkbox', { name: `${locationLabel(location)} · ${title}`, exact: true })
    await expect(checkbox).toBeChecked({ checked: typeof requestDefault === 'boolean' ? requestDefault : requestDefault[location] })
    await checkbox.setChecked(locations.includes(location))
  }
  await review.getByTestId('extension-confirm-install').click()
  await expect(review).toBeHidden()
  await expect.poll(() => page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).find(item => item.manifest.id === id)?.manifest.apiVersion, id)).toBe(4)
  await tasks(page)
}

async function readerContents(app) {
  return app.evaluate(async ({ webContents }, id) => {
    const results = []
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed())
        continue
      for (const frame of contents.mainFrame.framesInSubtree) {
        if (!frame.url.startsWith('lexora-extension:') || !frame.url.includes('/__view.html'))
          continue
        const value = await frame.executeJavaScript(`(() => {
          const root = document.querySelector('[data-file-opening-fixture="${id}"]')
          if (!root || root.dataset.visible !== 'true') return null
          return {
            status: root.querySelector('[role=status]').textContent,
            text: root.querySelector('pre').textContent,
            note: root.querySelector('input').value,
            resource: JSON.parse(root.dataset.resource),
            node: typeof process,
            desktop: typeof window.lexoraDesktop
          }
        })()`)
        if (value)
          results.push({ ...value, url: frame.url, processId: frame.osProcessId, hostProcessId: contents.mainFrame.osProcessId })
      }
    }
    return results
  }, id)
}

async function expectReader(app, page, text, resourceName) {
  await expect.poll(async () => (await readerContents(app)).map(({ status, text, resource }) => ({ status, text, name: resource?.name ?? null }))).toEqual([{ status: 'Ready', text, name: resourceName }])
  const [reader] = await readerContents(app)
  expect(reader.node).toBe('undefined')
  expect(reader.desktop).toBe('undefined')
  expect(reader.processId).not.toBe(reader.hostProcessId)
  const frame = page.frames().find(frame => frame.url() === reader.url)
  expect(frame).toBeTruthy()
  await expect(frame.getByTestId('resource-text')).toHaveText(text)
  return frame
}

async function togglePlugin(page, enabled) {
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
  const card = page.locator(`[data-extension-id="${id}"]`)
  await card.getByTestId(enabled ? 'extension-enable' : 'extension-disable').click()
  await expect(card.getByTestId(enabled ? 'extension-disable' : 'extension-enable')).toBeVisible()
  await expect.poll(() => page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).find(item => item.manifest.id === id)?.enabled, id)).toBe(enabled)
}

test('plugin references preserve content, transfer whole files and confirm opaque reveal requests', async ({ buddy }) => {
  await withArtifactPreview(buddy, { label: 'plugin-references', prepare }, async ({ app, page, output, directory, requests, instance }) => {
    await install({ app, page, directory }, ['standalone'])
    await output('report.md').getByRole('button', { name: 'report.md', exact: true }).click()
    let frame = await expectReader(app, page, diskText, 'report.md')
    const requestCount = requests.length
    const cards = page.locator('.desktop-chat-composer-wrap .chat-input-material-card')
    const quote = cards.filter({ hasText: 'Report excerpt' })
    await frame.getByTestId('reference-content').click()
    const dialog = page.getByRole('dialog').filter({ hasText: '引用到对话' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(frame.getByTestId('reference-result')).toHaveText('false')
    await expect(cards).toHaveCount(0)
    await frame.getByTestId('reference-content').click()
    await expect(dialog).toBeVisible()
    await app.evaluate(() => new Promise(resolve => setTimeout(resolve, 11000)))
    await expect(dialog).toBeVisible()
    await expect(frame.getByTestId('reference-result')).toHaveText('Pending')
    await dialog.getByRole('button', { name: /^分屏 1/ }).click()
    await expect(frame.getByTestId('reference-result')).toHaveText('true')
    await expect(cards).toHaveCount(1)
    await expect(quote).toContainText('Frozen report excerpt')
    await frame.getByLabel('Reader note').fill('Keep this temporary note')
    const previousUrl = frame.url()
    await quote.locator('.chat-reference-card__link').click()
    const previousResource = (await readerContents(app))[0].resource.id
    await page.getByRole('button', { name: '定位来源', exact: true }).click()
    await expect.poll(async () => (await readerContents(app)).some(reader => reader.resource?.id === previousResource && reader.status === 'Ready')).toBe(true)
    frame = await expectReader(app, page, diskText, 'report.md')
    await expect(frame.getByTestId('reference-location')).toHaveText(JSON.stringify({ version: 1, data: { block: 'summary' } }))
    expect(frame.url()).toBe(previousUrl)
    await expect(frame.getByLabel('Reader note')).toHaveValue('Keep this temporary note')
    await quote.locator('.chat-reference-card__link').click()
    await expect(page.locator('.resource-quote-preview:visible')).toHaveCount(0)
    for (const behavior of ['missing', 'not-found', 'throw']) {
      await frame.getByLabel('Reveal behavior').selectOption(behavior)
      await quote.locator('.chat-reference-card__link').click()
      await page.getByRole('button', { name: '定位来源', exact: true }).click()
      await expect(page.locator('.resource-quote-preview:visible')).toContainText('不可用')
      await quote.locator('.chat-reference-card__link').click()
      await expect(page.locator('.resource-quote-preview:visible')).toHaveCount(0)
    }
    await frame.getByLabel('Reveal behavior').selectOption('locate')
    await frame.getByTestId('reference-file').click()
    await dialog.getByRole('button', { name: /^分屏 1/ }).click()
    await expect(cards).toHaveCount(2)
    await expect(cards.filter({ hasText: 'report.md' })).toHaveCount(1)
    await expect(frame.getByTestId('reference-result')).toHaveText('true')
    await page.locator('.desktop-task-context-panel__tab.is-active .desktop-task-context-panel__tab-close').click()
    await expect.poll(async () => (await readerContents(app)).length).toBe(0)
    await quote.locator('.chat-reference-card__link').click()
    await page.getByRole('button', { name: '定位来源', exact: true }).click()
    frame = await expectReader(app, page, diskText, 'report.md')
    await expect(frame.getByTestId('reference-location')).toHaveText(JSON.stringify({ version: 1, data: { block: 'summary' } }))
    await quote.locator('.chat-reference-card__link').click()
    await expect(page.locator('.resource-quote-preview:visible')).toHaveCount(0)
    expect(requests).toHaveLength(requestCount)
    expect(await fs.readFile(path.join(directory, 'report.md'), 'utf8')).toBe(diskText)
    await togglePlugin(page, false)
    await tasks(page)
    await page.reload()
    await expect(cards).toHaveCount(2)
    await quote.locator('.chat-reference-card__link').click()
    await page.getByRole('button', { name: '定位来源', exact: true }).click()
    await expect(page.locator('.resource-quote-preview:visible')).toContainText('Frozen report excerpt')
    await expect(page.locator('.resource-quote-preview:visible')).toContainText('不可用')
    await page.screenshot({ path: path.join(instance.artifactDirectory, 'plugin-reference-materials.png'), animations: 'disabled' })
    await quote.locator('.chat-reference-card__link').click()
    await expect(page.locator('.resource-quote-preview:visible')).toHaveCount(0)
    await page.locator('.desktop-workbench-area__tasks .tiptap:visible').fill('Review these materials')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => requests.length).toBe(requestCount + 1)
    const input = JSON.stringify(requests.at(-1).messages.filter(message => message.role === 'user').at(-1))
    expect(input).toContain('Frozen report excerpt')
    expect(input).not.toContain('viewType')
    expect(input).not.toContain('summary')
  })
})

test('references from separate no-file plugin instances return to their own view', async ({ buddy }) => {
  await withArtifactPreview(buddy, { label: 'plugin-reference-instances', prepare: directory => prepare(directory, ['.md'], false, true) }, async ({ app, page, directory }) => {
    await install({ app, page, directory }, [], { inline: false, standalone: true })
    const panel = page.getByTestId('task-context-panel')
    if (!await panel.isVisible())
      await page.getByTestId('context-panel-toggle').click()
    const dialog = page.getByRole('dialog').filter({ hasText: '引用到对话' })
    let previousView
    for (const label of ['First instance', 'Second instance']) {
      if (previousView) {
        await page.getByTestId('context-add-tab').click()
        await page.getByRole('menuitem', { name: 'Open fixture reader', exact: true }).click()
      }
      else {
        await page.getByTestId(`task-context-open-${launcherId}`).click()
      }
      await expect.poll(async () => (await readerContents(app)).some(reader => reader.url !== previousView && reader.status === 'Ready')).toBe(true)
      previousView = (await readerContents(app))[0].url
      const frame = await expectReader(app, page, 'No file selected', null)
      await frame.getByLabel('Reader note', { exact: true }).fill(label)
      await frame.getByTestId('reference-content').click()
      await dialog.getByRole('button', { name: /^分屏 1/ }).click()
      await expect(frame.getByTestId('reference-result')).toHaveText('true')
    }
    const cards = page.locator('.desktop-chat-composer-wrap .chat-input-material-card')
    await expect(cards).toHaveCount(2)
    for (const label of ['First instance', 'Second instance']) {
      await cards.filter({ hasText: label }).locator('.chat-reference-card__link').click()
      await page.getByRole('button', { name: '定位来源', exact: true }).click()
      await expect.poll(async () => (await readerContents(app)).map(reader => reader.note)).toEqual([label])
      const frame = await expectReader(app, page, 'No file selected', null)
      await expect(frame.getByLabel('Reader note', { exact: true })).toHaveValue(label)
      await expect(frame.getByTestId('reference-location')).toHaveText(JSON.stringify({ version: 1, data: { block: 'summary' } }))
      await page.keyboard.press('Escape')
    }
  })
})

test('file-opening review keeps location defaults independent and shared views can launch without a file', async ({ buddy }) => {
  await withArtifactPreview(buddy, { label: 'file-opening-defaults', prepare: directory => prepare(directory, ['.md'], false, true) }, async ({ app, page, directory }) => {
    await page.evaluate(async () => {
      await window.lexoraDesktop.extensions.setFileOpener({ extension: '.md', location: 'inline', providerId: 'lexora.text' })
      await window.lexoraDesktop.extensions.setFileOpener({ extension: '.md', location: 'standalone', providerId: 'lexora.markdown' })
    })
    await install({ app, page, directory }, ['inline'], { inline: false, standalone: true })
    expect((await defaults(page))['.md']).toEqual({ inline: providerId, standalone: 'lexora.markdown' })
    await settings(page)
    await expect(page.getByLabel(locationLabel('inline'), { exact: true })).toContainText(pluginName)
    await expect(page.getByLabel(locationLabel('standalone'), { exact: true })).toContainText('Markdown 阅读器')
    await selectDefault(page, '.md', 'standalone', title)
    expect((await defaults(page))['.md']).toEqual({ inline: providerId, standalone: providerId })
    await selectDefault(page, '.md', 'inline', '文本查看器')
    expect((await defaults(page))['.md']).toEqual({ inline: 'lexora.text', standalone: providerId })

    await tasks(page)
    const panel = page.getByTestId('task-context-panel')
    if (!await panel.isVisible())
      await page.getByTestId('context-panel-toggle').click()
    await page.getByTestId(`task-context-open-${launcherId}`).click()
    const frame = await expectReader(app, page, 'No file selected', null)
    await frame.getByLabel('Reader note', { exact: true }).fill('Typed in the isolated reader')
    await expect(frame.getByTestId('reader-note')).toHaveText('Typed in the isolated reader')
  })
})

test('file-opening passes unsaved inline snapshots, reads artifacts from disk and restores retained plugin defaults', async ({ buddy }) => {
  await withArtifactPreview(buddy, { label: 'file-opening-resources', prepare }, async ({ app, page, output, directory }) => {
    await install({ app, page, directory }, ['inline', 'standalone'])
    const retained = { inline: providerId, standalone: providerId }
    expect((await defaults(page))['.md']).toEqual(retained)
    const card = output('report.md')
    await card.hover()
    await card.locator('.buddy-artifact-collection__more').click()
    await page.locator('.n-dropdown-menu:visible').getByText('在文件中定位', { exact: true }).click()
    await expect(page.getByTestId('context-file-tree').locator('[data-path="report.md"]')).toBeVisible()
    const preview = await expectReader(app, page, diskText, 'report.md')
    await expect(preview.locator('[data-file-opening-fixture]')).toHaveAttribute('data-file-opening-mode', 'preview')
    await page.getByTestId('document-mode-edit').click()
    const editor = page.getByTestId('workbench-text-editor')
    await expect(editor.locator('.view-lines')).toContainText('This paragraph is on disk.')
    await editor.locator('.view-lines').click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.insertText(draftText)
    await expect(page.locator('.file-editor:visible')).toHaveAttribute('data-dirty', 'true')
    await expect(editor.locator('.view-lines')).toContainText('This paragraph exists only in the working copy.')
    await page.getByTestId('document-mode-preview').click()
    const draft = await expectReader(app, page, draftText, 'report.md')
    const draftUrl = draft.url()
    await draft.getByLabel('Reader note').fill('Draft excerpt')
    await draft.getByTestId('reference-content').click()
    await page.getByRole('dialog').filter({ hasText: '引用到对话' }).getByRole('button', { name: /^分屏 1/ }).click()
    await expect(draft.getByTestId('reference-result')).toHaveText('true')
    expect(await fs.readFile(path.join(directory, 'report.md'), 'utf8')).toBe(diskText)

    await card.getByRole('button', { name: 'report.md', exact: true }).click()
    await expectReader(app, page, diskText, 'report.md')
    await page.locator('.desktop-chat-composer-wrap .chat-input-material-card').filter({ hasText: 'Draft excerpt' }).locator('.chat-reference-card__link').click()
    await page.getByRole('button', { name: '定位来源', exact: true }).click()
    const locatedDraft = await expectReader(app, page, draftText, 'report.md')
    expect(locatedDraft.url()).toBe(draftUrl)
    await expect(locatedDraft.getByLabel('Reader note')).toHaveValue('Draft excerpt')
    await expect(locatedDraft.getByTestId('reference-location')).toHaveText(JSON.stringify({ version: 1, data: { block: 'summary' } }))
    await page.keyboard.press('Escape')
    await togglePlugin(page, false)
    expect((await defaults(page))['.md']).toEqual(retained)
    expect((await snapshot(page)).providers.find(provider => provider.id === providerId)?.available).not.toBe(true)
    await settings(page)
    for (const location of ['inline', 'standalone'])
      await expect(page.getByLabel(locationLabel(location), { exact: true })).toContainText('不可用')
    await expect(page.locator('.desktop-file-opening-settings')).toContainText(`已保留原选择（${providerId}）`)

    await tasks(page)
    await page.getByTestId('task-context-panel').getByRole('tab', { name: '文件', exact: true }).click()
    await expect(page.locator('.file-editor:visible .desktop-document-content__markdown')).toContainText('This paragraph exists only in the working copy.')
    await card.getByRole('button', { name: 'report.md', exact: true }).click()
    await expect(page.locator('.desktop-artifact-context-surface:visible .desktop-document-content__markdown')).toContainText('This paragraph is on disk.')
    expect((await defaults(page))['.md']).toEqual(retained)

    await togglePlugin(page, true)
    await settings(page)
    for (const location of ['inline', 'standalone']) {
      const control = page.getByLabel(locationLabel(location), { exact: true })
      await expect(control).toContainText(title)
      await expect(control).toContainText(pluginName)
    }
    await tasks(page)
    await page.getByTestId('task-context-panel').getByRole('tab', { name: '文件', exact: true }).click()
    await expectReader(app, page, draftText, 'report.md')
    await card.getByRole('button', { name: 'report.md', exact: true }).click()
    await expectReader(app, page, diskText, 'report.md')
    expect((await defaults(page))['.md']).toEqual(retained)
    expect(await fs.readFile(path.join(directory, 'report.md'), 'utf8')).toBe(diskText)
  })
})

test('installation review keeps confirmation reachable while long associations scroll and cancellation installs nothing', async ({ buddy }) => {
  const extensions = Array.from({ length: 24 }, (_, index) => `.file${index}`)
  await withArtifactPreview(buddy, { label: 'install-review', prepare: directory => prepare(directory, extensions) }, async ({ app, page, directory }) => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isVisible()).setContentSize(900, 640))
    await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, path.join(directory, packageName))
    await page.getByTestId('extension-install-options').click()
    await page.getByTestId('extension-install').click()
    const review = page.getByTestId('extension-install-review')
    const install = review.getByTestId('extension-confirm-install')
    const associations = review.getByTestId('extension-file-associations')
    await expect(review).toBeVisible()
    await expect(install).toBeInViewport()
    await associations.getByRole('checkbox', { name: '全选： 文件内预览', exact: true }).uncheck()
    await expect(associations.locator('tbody').getByRole('checkbox', { checked: true })).toHaveCount(24)
    await expect(associations.locator('tbody').getByRole('checkbox', { checked: false })).toHaveCount(24)
    await review.locator('.n-card-content').evaluate(element => element.scrollTop = element.scrollHeight)
    await expect(associations.getByRole('checkbox', { name: `.file23 · 独立打开 · ${title}`, exact: true })).toBeInViewport()
    await expect(install).toBeInViewport()
    await expect(review.getByText('请确认你信任此插件的来源。', { exact: true })).toBeInViewport()
    await review.getByRole('button', { name: '取消', exact: true }).click()
    await expect(review).toBeHidden()
    await expect.poll(() => page.evaluate(async id => (await window.lexoraDesktop.extensions.list()).some(item => item.manifest.id === id), id)).toBe(false)
    expect(await defaults(page)).toEqual({})
  })
})
