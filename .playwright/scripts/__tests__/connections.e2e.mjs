import { Buffer } from 'node:buffer'
import { createHash, X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { request } from 'node:https'
import { createServer } from 'node:net'
import { connect } from 'node:tls'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'

test('mobile connections start without manual addressing and show centered empty or paired devices', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('connections-settings')
  const desktop = await instance.launch({ storageAuthority: 'sqlite' })
  await useSyntheticCredentialStorage(desktop)
  const { page } = desktop
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  await page.evaluate(port => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: false, port }), port)
  expect(await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.status({}))).toMatchObject({ enabled: false, bindAddress: null })
  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '连接', exact: true }).click()
  const settings = page.getByTestId('private-network-settings')
  const toggle = settings.getByRole('switch', { name: '允许移动设备连接' })
  await expect(toggle).toBeEnabled()
  await expect(settings.getByRole('textbox')).toHaveCount(0)
  await expect(settings.getByRole('spinbutton')).toHaveCount(0)
  const area = page.getByTestId('paired-devices-empty-area')
  const empty = page.getByTestId('paired-devices-empty')
  await expect(empty).toBeVisible()
  async function assertCentered() {
    const outer = await area.boundingBox()
    const inner = await empty.boundingBox()
    expect(Math.abs(outer.x + outer.width / 2 - inner.x - inner.width / 2)).toBeLessThanOrEqual(2)
    expect(Math.abs(outer.y + outer.height / 2 - inner.y - inner.height / 2)).toBeLessThanOrEqual(2)
  }
  await assertCentered()
  await page.screenshot({ path: testInfo.outputPath('connections-empty-light.png') })
  await page.evaluate(() => window.lexoraDesktop.themes.request({ action: 'preference', preference: { id: 'lexora.themes.classic-dark' } }))
  await assertCentered()
  await page.screenshot({ path: testInfo.outputPath('connections-empty-dark.png') })
  const browserWindow = await desktop.app.browserWindow(page)
  await browserWindow.evaluate(window => window.setSize(900, 650))
  await assertCentered()
  await page.screenshot({ path: testInfo.outputPath('connections-empty-narrow.png') })
  expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await browserWindow.evaluate(window => window.setSize(1440, 900))
  await page.evaluate(() => window.lexoraDesktop.themes.request({ action: 'preference', preference: { id: 'lexora.themes.classic-light' } }))
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect.poll(() => page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.status({}))).toMatchObject({ state: 'listening', port })
  await settings.getByRole('button', { name: '配对新设备', exact: true }).click()
  await expect(page.getByTestId('device-pairing-code').locator('canvas')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('connections-pairing.png') })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('device-pairing-code')).toBeHidden()
  const qr = await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.issuePairing({}))
  const { serviceId, profileId, issuerInstanceId, ticketId, ticketSecret } = qr
  const context = { serviceId, profileId, issuerInstanceId, ticketId, ticketSecret }
  const call = await pairedTransport(qr)
  const prepared = await call('/v1/pairing/prepare', { ...context, deviceName: '测试手机' })
  const credentials = await call('/v1/pairing/redeem', { ...context, attemptId: prepared.attemptId, recoverySecret: prepared.recoverySecret })
  await call('/v1/pairing/confirm', {}, `${credentials.credentialId}.${credentials.credentialSecret}`)
  const list = page.getByTestId('paired-devices-list')
  await expect(list.getByText('测试手机', { exact: true })).toBeVisible({ timeout: 15000 })
  await expect(list).toContainText('已授权')
  await expect(empty).toBeHidden()
  await page.screenshot({ path: testInfo.outputPath('connections-paired.png') })
  await list.getByRole('button', { name: '撤销访问' }).click()
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(list).toContainText('已撤销')
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect.poll(() => page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.status({}))).toMatchObject({ enabled: false, state: 'disabled', endpoint: null })
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

async function pairedTransport(qr) {
  const url = new URL(qr.endpoint)
  const socket = connect({ host: url.hostname, port: Number(url.port), rejectUnauthorized: false })
  await once(socket, 'secureConnect')
  const certificate = new X509Certificate(socket.getPeerCertificate().raw)
  socket.destroy()
  const pin = `sha256/${createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')}`
  expect(pin).toBe(qr.spkiPin)
  return (path, body, bearer) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = request(`${qr.endpoint}${path}`, { method: 'POST', ca: certificate.toString(), headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } }, (response) => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode !== 200)
          reject(new Error(`Pairing failed: ${response.statusCode}`))
        else resolve(JSON.parse(Buffer.concat(chunks).toString()))
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}
