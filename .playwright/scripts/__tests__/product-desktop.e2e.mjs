import fs from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from '../fixtures/electron.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const requireBuddy = createRequire(path.join(root, 'apps/buddy/package.json'))

test('candidate Desktop persists inputs and recovers stale saves through the product protocol', async ({ buddy }) => {
  const instance = await buddy.createInstance('product-desktop')
  const output = test.info().outputPath('profile-preparation')
  const { build } = await import(pathToFileURL(requireBuddy.resolve('vite')).href)
  await build({ configFile: false, logLevel: 'error', build: {
    ssr: path.join(root, '.playwright/scripts/__tests__/prepareProductProfile.ts'),
    outDir: output,
    target: 'node26',
    rolldownOptions: { external: isBuiltin, output: { entryFileNames: 'prepare.mjs', format: 'es' } },
  } })
  const { prepareProductProfile } = await import(pathToFileURL(path.join(output, 'prepare.mjs')).href)
  prepareProductProfile(instance.home)
  let { page } = await instance.launch({ storageAuthority: 'sqlite' })
  const editor = page.locator('.desktop-workbench-area__tasks .tiptap:visible').first()
  await expect(editor).toBeVisible()
  await editor.fill('Persist the candidate input 中文 🚀')
  await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.localChat.composerDrafts.list()).map(draft => JSON.stringify(draft.content)).join('\n'))).toContain('Persist the candidate input')
  const proof = await page.evaluate(async () => {
    const api = window.lexoraDesktop.localChat
    const draft = (await api.composerDrafts.list()).find(draft => JSON.stringify(draft.content).includes('Persist the candidate input'))
    const content = { version: 1, body: [{ type: 'paragraph', content: [{ type: 'text', text: 'Recover unconfirmed desktop input' }] }], panelResourceIds: [] }
    let rejected = false
    try {
      await api.composerDrafts.save({ draftId: draft.draftId, expectedRevision: draft.revision + 9, content, modelSelection: draft.modelSelection, executionConfig: draft.executionConfig })
    }
    catch { rejected = true }
    return { rejected, originalDraftId: draft.draftId }
  })
  expect(proof.rejected).toBe(true)
  await expect.poll(() => page.evaluate(() => window.lexoraDesktop.localChat.runtime.listRecovery())).toMatchObject([expect.objectContaining({ state: 'rejected', canRestore: true })])
  await instance.stop()
  const reopened = await instance.launch({ storageAuthority: 'sqlite' })
  page = reopened.page
  await expect(page.locator('.desktop-workbench-area__tasks .tiptap:visible').first()).toContainText('Persist the candidate input')
  await page.getByRole('button', { name: '查看', exact: true }).click()
  await expect(page.getByText('Recover unconfirmed desktop input', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '保存为新草稿', exact: true }).click()
  await expect(page.locator('.tiptap:visible').filter({ hasText: 'Recover unconfirmed desktop input' })).toBeVisible()
  const result = await page.evaluate(async () => {
    const api = window.lexoraDesktop.localChat
    return { drafts: (await api.composerDrafts.list()).map(draft => ({ draftId: draft.draftId, content: draft.content })), recovery: await api.runtime.listRecovery() }
  })
  expect(result.recovery).toEqual([])
  expect(result.drafts.find(draft => draft.draftId === proof.originalDraftId)?.content.body[0].content[0].text).toContain('Persist the candidate input')
  await fs.writeFile(test.info().outputPath('product-desktop.json'), JSON.stringify({ ...proof, ...result }, null, 2))
  await page.screenshot({ path: test.info().outputPath('product-desktop.png') })
})
