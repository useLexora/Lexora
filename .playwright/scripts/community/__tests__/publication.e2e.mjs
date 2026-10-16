import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { expect, test } from '@playwright/test'
import { hashToken } from '../../../../apps/api/src/auth/service.ts'
import { createDatabase } from '../../../../apps/api/src/database.ts'

const db = createDatabase(process.env.TEST_DATABASE_URL)
const userIds = []
const tokens = {}
const suffix = randomUUID().slice(0, 8)
const handle = `creator-${suffix}`
const pluginId = `${handle}.weather`
const manifest = { schemaVersion: 1, id: pluginId, name: 'Community test plugin', version: '1.0.0', description: 'A reproducible publication test', apiVersion: 3, engines: { lexora: '>=0.10.0' }, categories: ['tools'], tags: [], permissions: {}, contributes: {} }

test.beforeAll(async () => {
  for (const role of ['creator', 'admin']) {
    const subject = role === 'admin' ? 'community-e2e-admin' : `community-e2e-${suffix}`
    const user = await db.user.create({ data: { name: `Test ${role}`, accounts: { create: { provider: 'github', subject } } } })
    userIds.push(user.id)
    tokens[role] = randomUUID()
    await db.session.create({ data: { tokenHash: hashToken(tokens[role]), userId: user.id, expiresAt: new Date(Date.now() + 600000) } })
  }
})
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('page-state', { body: await page.locator('body').textContent() ?? '', contentType: 'text/plain' })
    await page.screenshot({ path: testInfo.outputPath('failure.png') })
  }
})
test.afterAll(async () => {
  await db.pluginRelease.deleteMany({ where: { pluginId } })
  await db.plugin.deleteMany({ where: { id: pluginId } })
  await db.publisher.deleteMany({ where: { userId: { in: userIds } } })
  await db.user.deleteMany({ where: { id: { in: userIds } } })
  await db.$disconnect()
})

test('publisher submission, review and anonymous discovery stay connected', async ({ page, context, browser }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await context.addCookies([{ name: 'lexora_session', value: tokens.creator, url: 'http://localhost:4175', httpOnly: true, sameSite: 'Lax' }])
  await page.goto('/account')
  await page.getByLabel('唯一用户名').fill(handle)
  await page.getByLabel('显示名称').fill('Test creator')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('已保存', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: '发布插件', exact: true }).click()
  await page.getByLabel('插件清单 JSON').fill(JSON.stringify(manifest))
  await page.getByLabel('GitHub 仓库').fill('https://github.com/example/community-test')
  await page.getByLabel('安装包 HTTPS 地址').fill('https://github.com/example/community-test/releases/download/v1/test.zip')
  await page.getByLabel('SHA-256 校验值').fill('b'.repeat(64))
  await page.getByRole('button', { name: '提交审核', exact: true }).click()
  await expect(page.getByText('已提交，等待审核', { exact: true })).toBeVisible()
  await page.goto('/account')
  await expect(page.getByText('待审核', { exact: true })).toBeVisible()

  const anonymous = await browser.newContext()
  const publicPage = await anonymous.newPage()
  const scripts = []
  publicPage.on('request', (request) => {
    if (request.resourceType() === 'script')
      scripts.push(request.url())
  })
  await publicPage.goto('/')
  await expect(publicPage.getByRole('heading', { name: '发现插件' })).toBeVisible()
  expect(scripts.some(url => /(?:manage|FormItem|login-panel)-/.test(url))).toBe(false)
  expect(await publicPage.locator('.n-config-provider').count()).toBe(0)
  expect((await anonymous.request.get(`/api/plugins/${pluginId}`)).status()).toBe(404)

  await context.addCookies([{ name: 'lexora_session', value: tokens.admin, url: 'http://localhost:4175', httpOnly: true, sameSite: 'Lax' }])
  await page.goto('/reviews')
  const review = page.locator('article').filter({ hasText: pluginId })
  await review.getByLabel('审核说明').fill('Verified test artifact and publisher')
  await review.getByRole('button', { name: '通过并发布', exact: true }).click()
  await expect(review).toHaveCount(0)
  await publicPage.getByRole('searchbox').fill(manifest.name)
  await publicPage.getByRole('search').getByRole('button').click()
  await publicPage.locator('.plugin-card').filter({ hasText: manifest.name }).click()
  await expect(publicPage.getByRole('heading', { name: manifest.name, exact: true })).toBeVisible()
  await expect(publicPage.getByRole('link', { name: /下载插件/ })).toHaveAttribute('href', 'https://github.com/example/community-test/releases/download/v1/test.zip')
  await expect(publicPage.getByRole('link', { name: /GitHub 仓库/ })).toHaveAttribute('href', 'https://github.com/example/community-test')
  await publicPage.getByRole('button', { name: '切换深浅主题' }).click()
  await expect(publicPage.locator('html')).toHaveClass('dark')
  await publicPage.setViewportSize({ width: 390, height: 844 })
  expect(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await publicPage.getByRole('button', { name: '切换语言' }).click()
  await expect(publicPage.getByRole('link', { name: /Download plugin/ })).toBeVisible()
  expect(errors).toEqual([])
  await anonymous.close()
})
