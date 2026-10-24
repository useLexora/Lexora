import type { BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { app } from 'electron'
import { OPERATING_SYSTEM } from '../../../shared/platform/identifiers'
import { readDesktopDistribution } from '../updates/DesktopUpdatePolicy'

export async function checkDesktopSmokeBridge(window: BrowserWindow): Promise<void> {
  const expectedFormat = process.env.LEXORA_DESKTOP_SMOKE_EXPECTED_FORMAT
  if (expectedFormat) {
    if (!app.isPackaged)
      throw new Error('Desktop distribution smoke requires a packaged application')
    const metadata = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'))
    const distribution = readDesktopDistribution(metadata.desktopDistribution, process.platform, process.arch)
    if (!distribution || distribution.format !== expectedFormat
      || (process.platform === OPERATING_SYSTEM.Windows && distribution.signing !== 'none')) {
      throw new Error(`Desktop distribution smoke expected ${expectedFormat}: ${JSON.stringify(metadata.desktopDistribution)}`)
    }
  }
  const bridgeAvailable = await window.webContents.executeJavaScript(
    'typeof globalThis.lexoraDesktop === "object"',
    true,
  )
  if (bridgeAvailable !== true)
    throw new Error('Lexora Buddy Desktop Preload bridge is unavailable')
  const providers = await window.webContents.executeJavaScript(
    'globalThis.lexoraDesktop.localChat.providers.list()',
    true,
  )
  if (!Array.isArray(providers))
    throw new Error('Lexora Buddy Desktop Local Service provider registry is unavailable')
  const status = await window.webContents.executeJavaScript(
    'globalThis.lexoraDesktop.localChat.runtime.getStatus()',
    true,
  )
  if (!status || typeof status !== 'object' || status.status !== 'ready')
    throw new Error('Lexora Buddy Desktop Preload local chat IPC is unavailable')
}
