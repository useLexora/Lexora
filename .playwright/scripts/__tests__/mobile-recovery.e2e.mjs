import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createServer } from 'node:net'
import process from 'node:process'
import { promisify } from 'node:util'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'
import { prepareMobileDesktopProfile } from '../fixtures/mobile-desktop.mjs'

const execute = promisify(execFile)
const serial = process.env.LEXORA_TEST_ANDROID_SERIAL
const serviceMode = process.env.LEXORA_TEST_MOBILE_SERVICE_MODE ?? 'utility'

test('Android process termination preserves drafts, original receipts and resumable attachment uploads with real Core', async ({ buddy }, testInfo) => {
  test.skip(!serial, 'Requires an isolated Android device with debug and instrumentation APKs')
  test.setTimeout(180000)
  const adb = (...args) => execute(process.env.ADB ?? 'adb', ['-s', serial, ...args], { timeout: 60000 })
  const instance = await buddy.createInstance('mobile-recovery')
  await prepareMobileDesktopProfile(instance.home, testInfo.outputPath('profile-preparation'))
  const desktop = await instance.launch({ storageAuthority: 'sqlite', serviceMode })
  await useSyntheticCredentialStorage(desktop)
  const { page } = desktop
  const listener = createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  const configuration = testInfo.outputPath('pairing.json')
  let reversed = false
  try {
    await page.evaluate(port => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: true, bindAddress: '127.0.0.1', port }), port)
    const pairing = await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.issuePairing({}))
    await fs.writeFile(configuration, JSON.stringify({ pairing }), { mode: 0o600 })
    await adb('reverse', `tcp:${port}`, `tcp:${port}`)
    reversed = true
    const result = await execute(process.execPath, ['.playwright/scripts/mobile/__tests__/process-recovery.e2e.mjs', '--serial', serial, '--adb', process.env.ADB ?? 'adb', '--pairing', configuration, '--output', testInfo.outputPath('recovery')], { timeout: 150000, maxBuffer: 8 * 1024 * 1024 })
    await fs.writeFile(testInfo.outputPath('runner.log'), result.stdout + result.stderr)
    const recovered = JSON.parse(await fs.readFile(testInfo.outputPath('recovery/result.json'), 'utf8'))
    expect(recovered).toMatchObject({ passed: true, nativeDraftRestored: true, currentInputPreserved: true, executionSettingsPreserved: true, duplicateAdoptionPrevented: true })
    await expect(page.locator('.desktop-workbench-area__tasks .tiptap:visible').first()).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('desktop-after-recovery.png') })
  }
  finally {
    await adb('shell', 'am', 'force-stop', 'app.uselexora.mobile.dev')
    if (reversed)
      await adb('reverse', '--remove', `tcp:${port}`)
    await fs.rm(configuration, { force: true })
    for (const device of await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.devices({}))) {
      if (device.state === 'active')
        await page.evaluate(deviceId => window.lexoraDesktop.localChat.privateNetwork.revoke({ deviceId }), device.deviceId)
    }
    await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: false }))
  }
})
