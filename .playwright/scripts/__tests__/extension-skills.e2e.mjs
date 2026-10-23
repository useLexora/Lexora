import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '../fixtures/electron.mjs'
import { skillInvocationName, skillPluginId, skillPluginName, userSkillContent, writeSkillPlugin } from '../fixtures/extension-skills.mjs'

async function catalog(page) {
  return page.evaluate(() => window.lexoraDesktop.localChat.skills.list(null))
}

async function openPicker(page) {
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '任务', exact: true }).click()
  const composer = page.locator('.desktop-chat-composer__prosemirror:visible')
  await composer.fill('$workbook')
  return page.locator('.chat-composer-source-picker:visible')
}

test('plugin skills remain inspectable and selectable through the plugin lifecycle without changing user skills', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('extension-skills')
  const fixture = await writeSkillPlugin(path.join(instance.home, 'fixtures'))
  const { app, page, diagnostics } = await instance.launch()
  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { featureAnnouncementsEnabled: false } }))
  await expect(page.getByTestId('feature-discovery-reminder')).toBeHidden()
  const userSkill = await page.evaluate(async (location) => {
    const api = window.lexoraDesktop.localChat.skills
    const preview = await api.preview({ spaceId: null, source: { kind: 'directory', location } })
    const installed = await api.install({ previewId: preview.id, candidateIds: preview.candidates.map(candidate => candidate.id) })
    return installed.skills.find(skill => skill.name === 'workbook' && skill.managedBy === 'user')
  }, fixture.userSource)

  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '插件', exact: true }).click()
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] })
  }, fixture.archive)
  await page.getByTestId('extension-install-options').click()
  await page.getByTestId('extension-install').click()
  const review = page.getByTestId('extension-install-review')
  await expect(review).toBeVisible()
  await review.getByTestId('extension-confirm-install').click()
  await expect(review).toBeHidden()
  await expect.poll(async () => (await catalog(page)).skills.find(skill => skill.plugin?.extensionId === skillPluginId)?.status).toBe('available')
  const pluginSkill = (await catalog(page)).skills.find(skill => skill.plugin?.extensionId === skillPluginId)

  await page.evaluate(() => window.location.hash = '/settings/skills')
  const pluginRow = page.locator(`[data-skill-id="${pluginSkill.id}"]`)
  await expect(pluginRow).toContainText(skillInvocationName)
  await expect(pluginRow).toContainText(skillPluginName)
  await expect(pluginRow.getByRole('switch')).toHaveCount(0)
  await expect(page.locator(`[data-skill-id="${userSkill.id}"]`).getByRole('switch')).toBeChecked()
  await pluginRow.getByRole('button', { name: new RegExp(skillInvocationName) }).click()
  const drawer = page.locator('.skill-detail-drawer')
  await expect(drawer.locator('.skill-detail__document')).toContainText('Packaged workbook guide')
  await expect(drawer.locator('.skill-information')).toContainText(skillPluginName)
  await expect(drawer.locator('.skill-information')).toContainText(`$${skillInvocationName}`)
  await expect(drawer.getByRole('button', { name: '更新', exact: true })).toHaveCount(0)
  await expect(drawer.getByRole('button', { name: '移除', exact: true })).toHaveCount(0)
  await drawer.locator('.skill-detail__tabs').getByText('文件', { exact: true }).click()
  await expect(drawer.locator('.skill-files')).toBeVisible()
  await drawer.locator('.skill-files [data-path="references"]').click()
  await drawer.locator('.skill-files [data-path="references/workbook.md"]').click()
  await expect(drawer.locator('.skill-files .view-lines')).toContainText('Preserve formulas when inspecting a workbook.')
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()

  let picker = await openPicker(page)
  await expect(picker.getByRole('option').filter({ hasText: skillInvocationName })).toBeVisible()
  await expect(picker.getByRole('option').filter({ hasText: 'Independent user workbook instructions.' })).toBeVisible()
  await picker.getByRole('option').filter({ hasText: skillInvocationName }).click()
  await expect(page.locator('.desktop-chat-composer__prosemirror:visible')).toContainText(skillInvocationName)

  await page.evaluate(id => window.lexoraDesktop.extensions.enable(id, false), skillPluginId)
  await expect.poll(async () => (await catalog(page)).skills.filter(skill => skill.plugin?.extensionId === skillPluginId && ['available', 'manual_only'].includes(skill.status))).toHaveLength(0)
  picker = await openPicker(page)
  await expect(picker.getByRole('option').filter({ hasText: skillInvocationName })).toHaveCount(0)
  await expect(picker.getByRole('option').filter({ hasText: 'Independent user workbook instructions.' })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.evaluate(id => window.lexoraDesktop.extensions.enable(id, true), skillPluginId)
  await expect.poll(async () => (await catalog(page)).skills.find(skill => skill.id === pluginSkill.id)?.status).toBe('available')
  picker = await openPicker(page)
  await expect(picker.getByRole('option').filter({ hasText: skillInvocationName })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.evaluate(id => window.lexoraDesktop.extensions.uninstall(id), skillPluginId)
  await expect.poll(async () => (await catalog(page)).skills.some(skill => skill.plugin?.extensionId === skillPluginId)).toBe(false)
  picker = await openPicker(page)
  await expect(picker.getByRole('option').filter({ hasText: skillInvocationName })).toHaveCount(0)
  await expect(picker.getByRole('option').filter({ hasText: 'Independent user workbook instructions.' })).toBeVisible()
  expect((await catalog(page)).skills.find(skill => skill.id === userSkill.id)).toMatchObject({ referenceRevision: userSkill.referenceRevision, filePath: userSkill.filePath, enabled: true, status: 'available', managedBy: 'user' })
  expect(await fs.readFile(userSkill.filePath, 'utf8')).toBe(userSkillContent)
  expect(await fs.readFile(path.join(fixture.userSource, 'SKILL.md'), 'utf8')).toBe(userSkillContent)
  await testInfo.attach('skill-catalog-after-uninstall', { body: JSON.stringify(await catalog(page), null, 2), contentType: 'application/json' })
  expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})
