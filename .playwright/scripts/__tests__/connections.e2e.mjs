import { Buffer } from 'node:buffer'
import { createHash, X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { request } from 'node:https'
import { createServer } from 'node:net'
import process from 'node:process'
import { connect } from 'node:tls'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'

test('mobile connections can pair and revoke devices without manual addressing', async ({ buddy }, testInfo) => {
  const instance = await buddy.createInstance('connections-settings')
  const desktop = await instance.launch({ storageAuthority: 'sqlite' })
  await useSyntheticCredentialStorage(desktop)
  const { page } = desktop
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  await page.evaluate(port => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: false, port }), port)
  const status = () => page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.status({}))

  await page.locator('.desktop-app-sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '连接', exact: true }).click()
  const settings = page.getByTestId('private-network-settings')
  const toggle = settings.getByRole('switch', { name: '允许移动设备连接' })
  const empty = settings.getByTestId('paired-devices-empty')
  await expect(toggle).not.toBeChecked()
  await expect(settings.getByRole('textbox').or(settings.getByRole('spinbutton'))).toHaveCount(0)
  await expect(empty).toBeVisible()

  const { version } = await page.evaluate(() => window.lexoraDesktop.app.getInfo())
  const releaseUrl = `https://github.com/useLexora/Lexora/releases/tag/v${version}`
  await desktop.app.evaluate(({ shell }) => {
    globalThis.mobileReleaseUrls = []
    shell.openExternal = async (url) => {
      globalThis.mobileReleaseUrls.push(url)
    }
  })
  const releaseUrls = () => desktop.app.evaluate(() => globalThis.mobileReleaseUrls)
  await settings.getByRole('button', { name: '前往下载移动端', exact: true }).click()
  await expect.poll(releaseUrls).toEqual([releaseUrl])

  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect.poll(status).toMatchObject({ state: 'listening', bindAddress: null, port })
  await settings.getByRole('button', { name: '配对新设备', exact: true }).click()
  const pairingCode = page.getByTestId('device-pairing-code')
  await expect(pairingCode.locator('canvas')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(pairingCode).toBeHidden()

  const qr = await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.issuePairing({}))
  const { serviceId, profileId, issuerInstanceId, ticketId, ticketSecret } = qr
  const context = { serviceId, profileId, issuerInstanceId, ticketId, ticketSecret }
  const call = await pairedTransport(qr)
  const prepared = await call('/v1/pairing/prepare', { ...context, deviceName: '测试手机' })
  const credentials = await call('/v1/pairing/redeem', { ...context, attemptId: prepared.attemptId, recoverySecret: prepared.recoverySecret })
  const bearer = `${credentials.credentialId}.${credentials.credentialSecret}`
  await call('/v1/pairing/confirm', {}, bearer)
  const tailscaleAddress = process.env.LEXORA_TEST_TAILSCALE_IPV4
  if (tailscaleAddress) {
    const endpoints = [qr.endpoint, qr.alternateEndpoint]
    expect(qr.version).toBe(2)
    expect(endpoints).toContain(`https://${tailscaleAddress}:${port}`)
    const alternateCall = await pairedTransport({ ...qr, endpoint: qr.alternateEndpoint })
    expect(await alternateCall('/v1/device/endpoints', undefined, bearer)).toEqual({ endpoints })
  }

  const list = settings.getByTestId('paired-devices-list')
  await expect(list.getByText('测试手机', { exact: true })).toBeVisible({ timeout: 15000 })
  await expect(list).toContainText('已授权')
  await expect(list).toContainText('平台未上报')
  await expect(empty).toBeHidden()
  await call('/v1/device/profile', { platform: 'android', manufacturer: 'Xiaomi', model: '23127PN0CC', osVersion: '15', appVersion: '0.1.0-beta.1' }, bearer)
  await expect(list).toContainText('Xiaomi 23127PN0CC', { timeout: 15000 })
  await expect(list).toContainText('Android 15')
  await expect(list).toContainText(credentials.deviceId.slice(-6))

  await list.getByRole('button', { name: '设备详情' }).click()
  const details = page.getByRole('dialog', { name: '设备详情' })
  await expect(details).toContainText('0.1.0-beta.1')
  await expect(details).toContainText(credentials.deviceId)
  await testInfo.attach('connections-device-details', {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
  await page.keyboard.press('Escape')
  await expect(details).toBeHidden()
  await list.getByRole('button', { name: '撤销访问' }).click()
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(list).toContainText('已撤销')
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect.poll(status).toMatchObject({ enabled: false, state: 'disabled', endpoint: null })

  await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { language: 'en-US' } }))
  await settings.getByRole('button', { name: 'Download mobile app', exact: true }).click()
  await expect.poll(releaseUrls).toEqual([releaseUrl, releaseUrl])
  expect(desktop.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
})

async function pairedTransport(qr) {
  const url = new URL(qr.endpoint)
  const socket = connect({ host: url.hostname, port: Number(url.port), rejectUnauthorized: false })
  await once(socket, 'secureConnect')
  const peer = socket.getPeerCertificate()
  socket.destroy()
  const certificate = new X509Certificate(peer.raw)
  const pin = `sha256/${createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')}`
  expect(pin).toBe(qr.spkiPin)

  return async (path, body, bearer) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {}
    if (payload !== undefined)
      Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
    const req = request(`${qr.endpoint}${path}`, { method: payload === undefined ? 'GET' : 'POST', ca: certificate.toString(), headers })
    const received = once(req, 'response')
    req.end(payload)
    const [response] = await received
    const chunks = []
    for await (const chunk of response)
      chunks.push(chunk)
    if (response.statusCode === 204)
      return
    if (response.statusCode !== 200)
      throw new Error(`${path}: HTTP ${response.statusCode}`)
    return JSON.parse(Buffer.concat(chunks).toString())
  }
}
