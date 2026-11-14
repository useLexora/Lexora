import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createServer as createProvider } from 'node:http'
import { createServer } from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'
import { prepareMobileDesktopProfile } from '../fixtures/mobile-desktop.mjs'

const execute = promisify(execFile)
const serial = process.env.LEXORA_TEST_ANDROID_SERIAL
const serviceMode = process.env.LEXORA_TEST_MOBILE_SERVICE_MODE ?? 'utility'
const bindAddress = process.env.LEXORA_TEST_MOBILE_BIND_ADDRESS ?? '127.0.0.1'
const useAdbReverse = bindAddress === '127.0.0.1'
const networkRecovery = process.env.LEXORA_TEST_MOBILE_NETWORK_RECOVERY === '1'

test('real Desktop and Android keep independent local input and submit one immutable input with attachments', async ({ buddy }) => {
  test.skip(!serial, 'Requires an isolated Android device with the debug and instrumentation APKs installed')
  test.setTimeout(180000)
  expect(!networkRecovery || !useAdbReverse, 'Wi-Fi recovery requires a real private-network address').toBe(true)
  const adb = (...args) => execute(process.env.ADB ?? 'adb', ['-s', serial, ...args], { timeout: 90000, maxBuffer: 8 * 1024 * 1024 })
  const token = randomUUID()
  const appPackage = 'app.uselexora.mobile.dev'
  const remoteConfig = `/data/local/tmp/lexora-desktop-${token}.json`
  const ready = `files/desktop-${token}-ready.json`
  const resume = `files/desktop-${token}-resume.json`
  const instance = await buddy.createInstance('mobile-desktop')
  await prepareMobileDesktopProfile(instance.home, test.info().outputPath('profile-preparation'))
  const desktop = await instance.launch({ storageAuthority: 'sqlite', serviceMode })
  await useSyntheticCredentialStorage(desktop)
  const { page } = desktop
  const avatar = await page.evaluate(async () => {
    const buddies = window.lexoraDesktop.localChat.buddies
    const buddy = await buddies.get('default')
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    const context = canvas.getContext('2d')
    context.fillStyle = '#1d9076'
    context.fillRect(0, 0, 64, 64)
    context.fillStyle = '#f2d97d'
    context.fillRect(16, 16, 32, 32)
    const avatar = canvas.toDataURL('image/png')
    await buddies.update({ buddyId: buddy.id, expectedRevision: buddy.revision, avatar })
    return avatar
  })
  const avatarHash = createHash('sha256').update(Buffer.from(avatar.split(',')[1], 'base64')).digest('hex')
  const requests = []
  const provider = createProvider((request, response) => {
    void (async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const common = { id: 'local-input', model: 'fixture-model', object: 'chat.completion.chunk', created: 1 }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: '输入和附件已收到' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })().catch(() => response.destroy())
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  await page.evaluate(async (baseUrl) => {
    await window.lexoraDesktop.settings.update({ runtime: { codemode: 'off', modelRetryLimit: 0 } })
    const providers = window.lexoraDesktop.localChat.providers
    await providers.upsertCustom({ id: 'input-fixture', displayName: 'Input fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'fixture-model', name: 'Input model', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
    const stop = providers.onAuthChallenge((challenge) => {
      if (challenge.providerId === 'input-fixture' && challenge.type === 'secret')
        void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
    })
    try {
      await providers.login('input-fixture', 'api_key')
    }
    finally {
      stop()
    }
    await providers.setDefaultModel({ providerId: 'input-fixture', modelId: 'fixture-model', reasoning: null })
  }, `http://127.0.0.1:${provider.address().port}/v1`)
  await page.reload()
  const read = (query) => {
    const database = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'), { readOnly: true })
    try {
      return query(database)
    }
    finally {
      database.close()
    }
  }
  const editor = page.locator('.desktop-workbench-area__tasks .tiptap:visible').first()
  await expect(editor).toBeVisible()
  const originalText = 'Desktop 原始输入 😀'
  await editor.fill(originalText)
  const getDraft = () => page.evaluate(async text => (await window.lexoraDesktop.localChat.composerDrafts.list()).find(draft => JSON.stringify(draft.content).includes(text)), originalText)
  await expect.poll(getDraft).toBeTruthy()
  const draft = await getDraft()
  const listener = createServer()
  await new Promise(resolve => listener.listen(0, bindAddress, resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  const configuration = test.info().outputPath('pairing.json')
  let instrument
  try {
    await page.evaluate(({ bindAddress, port }) => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: true, bindAddress, port }), { bindAddress, port })
    const pairing = await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.issuePairing({}))
    await fs.writeFile(configuration, JSON.stringify({ pairing, networkRecovery, avatarHash, draftId: draft.draftId, originalText }), { mode: 0o600 })
    if (useAdbReverse)
      await adb('reverse', `tcp:${port}`, `tcp:${port}`)
    await adb('push', configuration, remoteConfig)
    await fs.rm(configuration)
    instrument = adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.uselexora.mobile.DesktopWorkflowInstrumentedTest', '-e', 'desktopWorkflowToken', token, `${appPackage}.test/androidx.test.runner.AndroidJUnitRunner`)
      .then(result => ({ result }), error => ({ error }))
    let checkpoint
    await expect.poll(async () => {
      try {
        checkpoint = JSON.parse((await adb('shell', 'run-as', appPackage, 'cat', ready)).stdout)
        return checkpoint.attachmentCount
      }
      catch { return null }
    }, { timeout: 45000 }).toBe(1)
    await expect(editor).toContainText(originalText)
    const updatedText = 'Desktop 并发编辑保留 😀'
    await editor.fill(updatedText)
    await expect.poll(() => page.evaluate(async id => JSON.stringify((await window.lexoraDesktop.localChat.composerDrafts.get(id)).content), draft.draftId)).toContain(updatedText)
    expect(read(db => db.prepare('SELECT COUNT(*) AS count FROM composer_drafts WHERE owner_actor_id = ?').get(checkpoint.ownerDeviceId).count)).toBe(0)
    expect(read(db => db.prepare('SELECT COUNT(*) AS count FROM remote_uploads WHERE actor_id = ? AND input_id = ? AND state = \'ready\'').get(checkpoint.ownerDeviceId, checkpoint.inputId).count)).toBe(1)
    const database = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'))
    try {
      database.prepare('UPDATE remote_uploads SET state = \'expired\' WHERE actor_id = ? AND input_id = ? AND state = \'ready\'').run(checkpoint.ownerDeviceId, checkpoint.inputId)
    }
    finally {
      database.close()
    }
    const continuation = test.info().outputPath('resume.json')
    await fs.writeFile(continuation, JSON.stringify({ text: updatedText }))
    await adb('push', continuation, `/data/local/tmp/lexora-desktop-${token}-resume.json`)
    await adb('shell', 'run-as', appPackage, 'cp', `/data/local/tmp/lexora-desktop-${token}-resume.json`, resume)
    if (networkRecovery) {
      const waitMarker = stage => expect.poll(async () => {
        try {
          return (await adb('shell', 'run-as', appPackage, 'cat', `files/desktop-${token}-${stage}.json`)).stdout.trim() === 'ready'
        }
        catch { return false }
      }, { timeout: 45000 }).toBe(true)
      expect((await adb('shell', 'settings', 'get', 'global', 'wifi_on')).stdout.trim()).toBe('1')
      await waitMarker('network-ready')
      await adb('shell', 'svc', 'wifi', 'disable')
      try {
        await waitMarker('offline')
      }
      finally { await adb('shell', 'svc', 'wifi', 'enable') }
    }
    const outcome = await instrument
    await fs.writeFile(test.info().outputPath('android-instrumentation.txt'), outcome.result?.stdout ?? String(outcome.error))
    expect(outcome.error).toBeUndefined()
    expect(outcome.result.stdout).toMatch(/OK \(1 test\)/)
    expect(outcome.result.stdout).not.toMatch(/INSTRUMENTATION_STATUS_CODE: -[234]|FAILURES/)
    await expect(editor).toContainText(updatedText)
    expect(read(db => db.prepare('SELECT COUNT(*) AS count FROM composer_drafts WHERE owner_actor_id = ?').get(checkpoint.ownerDeviceId).count)).toBe(0)
    expect(read(db => db.prepare('SELECT COUNT(*) AS count FROM command_receipts WHERE actor_id = ? AND method = \'chat.submitInput\' AND decision = \'accepted\'').get(checkpoint.ownerDeviceId).count)).toBe(1)
    expect(JSON.stringify(requests)).toContain('Android 本地输入与附件')
    expect(JSON.stringify(requests)).toContain('附件内容完整保留')
    const screenshot = await execute(process.env.ADB ?? 'adb', ['-s', serial, 'exec-out', 'run-as', appPackage, 'cat', `files/desktop-${token}.png`], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })
    await fs.writeFile(test.info().outputPath('android-draft.png'), screenshot.stdout)
    await page.screenshot({ path: test.info().outputPath('desktop-draft.png') })
    const target = read(db => JSON.parse(db.prepare('SELECT target_json FROM command_receipts WHERE actor_id = ? AND method = \'chat.submitInput\' AND decision = \'accepted\'').get(checkpoint.ownerDeviceId).target_json))
    await page.locator(`[data-task-id="${target.conversationId}"]`).first().click()
    await page.getByRole('button', { name: '分屏打开', exact: true }).click()
    await expect(editor).toContainText(updatedText)
    await expect(page.locator('.desktop-workbench-area__tasks').getByText('输入和附件已收到', { exact: true })).toBeVisible()
    await expect(page.locator('.desktop-workbench-area__tasks img').filter({ visible: true }).and(page.locator(`img[src="${avatar}"]`)).first()).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('desktop-conversation.png') })

    await fs.writeFile(test.info().outputPath('workflow.json'), JSON.stringify({ ...checkpoint, localDrafts: true, immutableInput: true, nativeAndroidUi: true, electronUi: true, coreAdapter: serviceMode, wifiInterruptionRecovery: networkRecovery, customAvatar: true, avatarHash, offlineAvatar: networkRecovery, transport: useAdbReverse ? 'adb-reverse' : 'private-network', serverAddress: bindAddress }, null, 2))
  }
  finally {
    if (networkRecovery)
      await adb('shell', 'svc', 'wifi', 'enable')
    await adb('shell', 'am', 'force-stop', appPackage)
    const interrupted = await instrument
    if (interrupted)
      await fs.writeFile(test.info().outputPath('android-instrumentation.txt'), interrupted.result?.stdout ?? String(interrupted.error))
    await adb('shell', 'rm', '-f', remoteConfig, `/data/local/tmp/lexora-desktop-${token}-resume.json`)
    await adb('shell', 'run-as', appPackage, 'rm', '-f', ready, resume, `files/desktop-${token}.png`, `files/desktop-${token}-network-ready.json`, `files/desktop-${token}-offline.json`)
    if (useAdbReverse)
      await adb('reverse', '--remove', `tcp:${port}`)
    await fs.rm(configuration, { force: true })
    for (const device of await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.devices({}))) {
      if (device.state === 'active')
        await page.evaluate(deviceId => window.lexoraDesktop.localChat.privateNetwork.revoke({ deviceId }), device.deviceId)
    }
    await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: false }))
    provider.closeAllConnections()
    await new Promise(resolve => provider.close(resolve))
  }
})
