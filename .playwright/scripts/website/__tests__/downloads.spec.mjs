import { expect, test } from '@playwright/test'

const linuxBrowser = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  platform: 'Linux x86_64',
  maxTouchPoints: 0,
  userAgentData: {
    brands: [
      { brand: 'Not:A-Brand', version: '8' },
      { brand: 'Chromium', version: '156' },
      { brand: 'Google Chrome', version: '156' },
    ],
    mobile: false,
    platform: 'Linux',
  },
}

const environments = [
  { name: 'Linux with Client Hints', browser: linuxBrowser, linux: true },
  { name: 'Linux without Client Hints', browser: { ...linuxBrowser, userAgentData: null }, linux: true },
  {
    name: 'Windows with Client Hints',
    browser: { userAgent: '', platform: '', userAgentData: { platform: 'Windows', mobile: false } },
    currentSystem: 'Windows',
  },
  {
    name: 'macOS without Client Hints',
    browser: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', platform: 'MacIntel' },
    currentSystem: 'macOS',
  },
  {
    name: 'Android reporting Linux',
    browser: { ...linuxBrowser, userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/156.0.0.0 Mobile Safari/537.36', userAgentData: { platform: 'Android', mobile: true } },
  },
  { name: 'unknown platform', browser: { userAgent: '', platform: '' } },
]

const locales = [
  { name: 'Chinese', path: '/', label: '下载 Lexora', currentOs: '当前系统', linuxHint: '检测到 Linux，请按发行版选择安装包。' },
  { name: 'English', path: '/en/', label: 'Download Lexora', currentOs: 'Current OS', linuxHint: 'Linux detected. Choose a package for your distribution.' },
]

for (const locale of locales) {
  test.describe(locale.name, () => {
    for (const environment of environments) {
      test(environment.name, async ({ page }, testInfo) => {
        await page.addInitScript((browser) => {
          const values = { userAgent: '', platform: '', maxTouchPoints: 0, userAgentData: undefined, ...browser }
          for (const [name, value] of Object.entries(values))
            Object.defineProperty(navigator, name, { configurable: true, value })
        }, environment.browser)
        await page.route('https://api.github.com/repos/useLexora/Lexora/releases/latest', route => route.fulfill({ status: 503, body: '' }))

        await page.goto(locale.path)
        const trigger = page.getByRole('button', { name: locale.label, exact: true })
        await trigger.click()
        const menu = page.getByRole('dialog', { name: locale.label, exact: true })
        await expect(menu).toBeVisible()
        await expect(menu.getByText(locale.linuxHint, { exact: true })).toHaveCount(environment.linux ? 1 : 0)
        await expect(menu.getByText(locale.currentOs, { exact: true })).toHaveCount(environment.currentSystem ? 1 : 0)
        await expect(menu.locator('.is-recommended')).toHaveCount(environment.currentSystem ? 1 : 0)

        if (environment.currentSystem)
          await expect(menu.getByRole('link', { name: new RegExp(`^${environment.currentSystem}`) }).getByText(locale.currentOs, { exact: true })).toBeVisible()

        await expect(menu.getByRole('link', { name: /^Ubuntu \/ Debian/ })).toHaveAttribute('href', /^https:\/\/github\.com\/useLexora\/Lexora\/releases\/download\/[^/]+\/Lexora-Buddy-[^/]+-linux-amd64\.deb$/)
        await expect(menu.getByRole('link', { name: /^Arch Linux/ })).toHaveAttribute('href', /^https:\/\/github\.com\/useLexora\/Lexora\/releases\/download\/[^/]+\/Lexora-Buddy-[^/]+-arch-x86_64\.pkg\.tar\.zst$/)

        if (environment.name === 'Linux with Client Hints') {
          const screenshot = testInfo.outputPath('download-menu.png')
          await menu.screenshot({ path: screenshot })
          await testInfo.attach('download-menu', { path: screenshot, contentType: 'image/png' })
        }

        await page.keyboard.press('Escape')
        await expect(menu).not.toBeVisible()
        await expect(trigger).toBeFocused()
      })
    }
  })
}
