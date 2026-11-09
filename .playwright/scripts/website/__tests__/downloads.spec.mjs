import { expect, test } from '@playwright/test'

const proxyHosts = ['ghfast.top', 'gh-proxy.com', 'gh.monlor.com']
const releaseUrl = 'https://github.com/useLexora/Lexora/releases/tag/v99.1.0'
const assetBase = 'https://github.com/useLexora/Lexora/releases/download/v99.1.0/'
const assetNames = ['Lexora-Buddy-99.1.0-windows-x64.exe', 'Lexora-Buddy-99.1.0-arch-x86_64.pkg.tar.zst']
const release = {
  draft: false,
  prerelease: false,
  tag_name: 'v99.1.0',
  html_url: releaseUrl,
  published_at: '2026-03-01T00:00:00Z',
  assets: assetNames.map(name => ({ name, state: 'uploaded', size: 1024, browser_download_url: `${assetBase}${name}` })),
}

test.beforeEach(async ({ context }) => {
  await context.route('https://github.com/useLexora/Lexora/releases/download/**', route => route.abort())
})

test('proxy download is opt-in and follows the selected package', async ({ page }) => {
  await page.route('https://api.github.com/repos/useLexora/Lexora/releases/latest', route => route.fulfill({ json: release }))
  await page.goto('/')
  const trigger = page.getByRole('button', { name: '下载 Lexora', exact: true })
  const help = page.getByRole('button', { name: '下载未开始？尝试代理下载', exact: true })
  const dialog = page.getByRole('dialog', { name: '选择下载代理', exact: true })
  await expect(help).toHaveCount(0)
  await trigger.click()
  const menu = page.getByRole('dialog', { name: '下载 Lexora', exact: true })
  const windows = menu.getByRole('link', { name: /^Windows/ })
  const originalUrl = `${assetBase}${assetNames[0]}`
  await expect(windows).toHaveAttribute('href', originalUrl)
  await windows.click()
  await expect(help).toBeVisible()
  await expect(dialog).not.toBeVisible()
  await help.click()
  await expect(dialog.getByText(assetNames[0], { exact: true })).toBeVisible()
  await expect(dialog.getByText('代理由第三方运营。', { exact: false })).toBeVisible()
  for (const host of proxyHosts)
    await expect(dialog.getByRole('link', { name: host, exact: true })).toHaveAttribute('href', `https://${host}/${originalUrl}`)
  await expect(dialog.getByRole('link', { name: '重试 GitHub 直连', exact: true })).toHaveAttribute('href', originalUrl)
  await expect(dialog.getByRole('link', { name: '查看此版本与校验文件', exact: true })).toHaveAttribute('href', releaseUrl)
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(help).toBeFocused()

  await trigger.click()
  await menu.getByRole('link', { name: /^Arch Linux/ }).click()
  await help.click()
  await expect(dialog.getByText(assetNames[1], { exact: true })).toBeVisible()
  await expect(dialog.getByRole('link', { name: proxyHosts[0], exact: true })).toHaveAttribute('href', `https://${proxyHosts[0]}/${assetBase}${assetNames[1]}`)
})

test('Linux users can choose a distribution package when release metadata is unavailable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.addInitScript(() => {
    const values = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64', userAgentData: { platform: 'Linux', mobile: false } }
    for (const [name, value] of Object.entries(values))
      Object.defineProperty(navigator, name, { configurable: true, value })
  })
  await page.route('https://api.github.com/repos/useLexora/Lexora/releases/latest', route => route.fulfill({ status: 503, body: '' }))
  await page.goto('/en/')
  await page.getByRole('button', { name: 'Download Lexora', exact: true }).click()
  const menu = page.getByRole('dialog', { name: 'Download Lexora', exact: true })
  await expect(menu.getByText('Linux detected. Choose a package for your distribution.', { exact: true })).toBeVisible()
  await expect(menu.getByText('Current OS', { exact: true })).toHaveCount(0)
  const deb = menu.getByRole('link', { name: /^Ubuntu \/ Debian/ })
  await expect(deb).toHaveAttribute('href', /^https:\/\/github\.com\/useLexora\/Lexora\/releases\/download\/[^/]+\/Lexora-Buddy-[^/]+-linux-amd64\.deb$/)
  await expect(menu.getByRole('link', { name: /^Arch Linux/ })).toHaveAttribute('href', /^https:\/\/github\.com\/useLexora\/Lexora\/releases\/download\/[^/]+\/Lexora-Buddy-[^/]+-arch-x86_64\.pkg\.tar\.zst$/)
  const originalUrl = await deb.getAttribute('href')
  await deb.click()
  await page.getByRole('button', { name: 'Download not starting? Try a proxy', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Choose a download proxy', exact: true })
  await expect(dialog.getByText('Ubuntu / Debian', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'Retry directly from GitHub', exact: true })).toHaveAttribute('href', originalUrl)
  await expect(dialog.getByRole('link', { name: proxyHosts[0], exact: true })).toHaveAttribute('href', `https://${proxyHosts[0]}/${originalUrl}`)
})

test('late release metadata does not change the package already selected for proxy download', async ({ page }) => {
  let resolveRelease
  const releaseRequested = new Promise((resolve) => {
    resolveRelease = resolve
  })
  await page.route('https://api.github.com/repos/useLexora/Lexora/releases/latest', route => resolveRelease(route))
  await page.goto('/')
  const releaseRoute = await releaseRequested
  const trigger = page.getByRole('button', { name: '下载 Lexora', exact: true })
  await trigger.click()
  const menu = page.getByRole('dialog', { name: '下载 Lexora', exact: true })
  const windows = menu.getByRole('link', { name: /^Windows/ })
  const originalUrl = await windows.getAttribute('href')
  const [, tag, name] = new URL(originalUrl).pathname.match(/\/releases\/download\/([^/]+)\/([^/]+)$/)
  await windows.click()
  await releaseRoute.fulfill({ json: release })
  await trigger.click()
  await expect(menu.getByRole('link', { name: /^Windows/ })).toHaveAttribute('href', `${assetBase}${assetNames[0]}`)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '下载未开始？尝试代理下载', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '选择下载代理', exact: true })
  await expect(dialog.getByText(name, { exact: true })).toBeVisible()
  await expect(dialog.getByRole('link', { name: proxyHosts[0], exact: true })).toHaveAttribute('href', `https://${proxyHosts[0]}/${originalUrl}`)
  await expect(dialog.getByRole('link', { name: '重试 GitHub 直连', exact: true })).toHaveAttribute('href', originalUrl)
  await expect(dialog.getByRole('link', { name: '查看此版本与校验文件', exact: true })).toHaveAttribute('href', `https://github.com/useLexora/Lexora/releases/tag/${tag}`)
})
