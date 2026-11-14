import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createListener } from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'
import { prepareMobileDesktopProfile } from '../fixtures/mobile-desktop.mjs'

const execute = promisify(execFile)
const serial = process.env.LEXORA_TEST_ANDROID_SERIAL
const serviceMode = process.env.LEXORA_TEST_MOBILE_SERVICE_MODE ?? 'utility'

test('Android recovers the original receipt after a Core runtime restart and explicitly starts a separate successor', async ({ buddy }, testInfo) => {
  test.skip(!serial, 'Requires an isolated Android device with debug and instrumentation APKs')
  test.setTimeout(180000)
  const adb = (...args) => execute(process.env.ADB ?? 'adb', ['-s', serial, ...args], { timeout: 150000, maxBuffer: 8 * 1024 * 1024 })
  const token = randomUUID()
  const appPackage = 'app.uselexora.mobile.dev'
  const remoteConfig = `/data/local/tmp/lexora-interruption-${token}.json`
  const configuration = testInfo.outputPath('pairing.json')
  const requests = []
  let pendingStream
  const provider = createServer((request, response) => {
    void (async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const number = requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const common = { id: `interruption-${number}`, model: 'fixture-model', object: 'chat.completion.chunk', created: 1 }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: number === 1 ? '中断前的部分回复' : '中断后新回复' }, finish_reason: null }] })}\n\n`)
      if (number === 1) {
        pendingStream = response
        return
      }
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })().catch(() => response.destroy())
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const instance = await buddy.createInstance('mobile-interruption')
  await prepareMobileDesktopProfile(instance.home, testInfo.outputPath('profile-preparation'))
  const desktop = await instance.launch({ storageAuthority: 'sqlite', serviceMode })
  await useSyntheticCredentialStorage(desktop)
  const { page } = desktop
  const read = (query) => {
    const db = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'), { readOnly: true })
    try {
      return query(db)
    }
    finally { db.close() }
  }
  const listener = createListener()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  let instrument
  let outcome
  let reversed = false
  const files = new Set(['live', 'completed'].map(stage => `files/interruption-${token}-${stage}.png`))
  const marker = stage => `files/interruption-${token}-${stage}.json`
  const signal = async (stage) => {
    files.add(marker(stage))
    await adb('shell', 'run-as', appPackage, 'touch', marker(stage))
  }
  const checkpoint = async (stage) => {
    files.add(marker(stage))
    let value
    await expect.poll(async () => {
      try {
        value = JSON.parse((await adb('shell', 'run-as', appPackage, 'cat', marker(stage))).stdout)
        return true
      }
      catch {
        if (outcome)
          throw new Error(outcome.result?.stdout ?? String(outcome.error))
        return false
      }
    }, { timeout: 60000 }).toBe(true)
    return value
  }
  try {
    await page.evaluate(async (baseUrl) => {
      await window.lexoraDesktop.settings.update({ runtime: { codemode: 'off', modelRetryLimit: 0 } })
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'interruption-fixture', displayName: 'Interruption fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'fixture-model', name: 'Interruption model', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'interruption-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('interruption-fixture', 'api_key')
      }
      finally { stop() }
      await providers.setDefaultModel({ providerId: 'interruption-fixture', modelId: 'fixture-model', reasoning: null })
    }, `http://127.0.0.1:${provider.address().port}/v1`)
    await page.evaluate(port => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: true, bindAddress: '127.0.0.1', port }), port)
    const pairing = await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.issuePairing({}))
    await fs.writeFile(configuration, JSON.stringify({ pairing }), { mode: 0o600 })
    await adb('reverse', `tcp:${port}`, `tcp:${port}`)
    reversed = true
    await adb('push', configuration, remoteConfig)
    await fs.rm(configuration)
    instrument = adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.uselexora.mobile.InterruptionInstrumentedTest', '-e', 'interruptionToken', token, `${appPackage}.test/androidx.test.runner.AndroidJUnitRunner`)
      .then(result => ({ result }), error => ({ error }))
      .then((result) => {
        outcome = result
        return result
      })
    await checkpoint('stream-visible')
    expect(pendingStream).toBeTruthy()
    pendingStream.write(`data: ${JSON.stringify({ id: 'interruption-1', model: 'fixture-model', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta: { content: '接着输出' }, finish_reason: null }] })}\n\n`)
    const original = await checkpoint('started')
    expect(requests).toHaveLength(1)
    expect(read(db => db.prepare('SELECT status FROM runs WHERE id = ?').get(original.runId).status)).toBe('running')
    await page.evaluate(() => window.lexoraDesktop.localChat.runtime.restart())
    await expect.poll(async () => (await page.evaluate(() => window.lexoraDesktop.localChat.runtime.getStatus())).status, { timeout: 45000 }).toBe('ready')
    await signal('restarted')
    const recovered = await checkpoint('reconciled')
    expect(recovered).toMatchObject({ oldTarget: original, originalReceiptRecovered: true })
    expect(['cancelled', 'failed']).toContain(recovered.oldStatus)
    expect(requests).toHaveLength(1)
    expect(read(db => db.prepare('SELECT COUNT(*) AS count FROM runs').get().count)).toBe(1)
    await signal('allow-new-intent')
    const evidence = await checkpoint('done')
    const result = await instrument
    expect(result.error).toBeUndefined()
    expect(result.result.stdout).toMatch(/OK \(1 test\)/)
    expect(result.result.stdout).not.toMatch(/INSTRUMENTATION_STATUS_CODE: -[234]|FAILURES/)
    expect(requests).toHaveLength(2)
    expect(read(db => db.prepare('SELECT COUNT(*) AS count FROM runs').get().count)).toBe(2)
    expect(read(db => db.prepare('SELECT status FROM runs WHERE id = ?').get(original.runId).status)).toBe(recovered.oldStatus)
    await expect.poll(() => read(db => db.prepare('SELECT status FROM runs WHERE id = ?').get(evidence.successor.runId).status)).toBe('completed')
    expect(JSON.stringify(requests[1].messages)).toContain('服务中断后等待我明确重新生成')
    for (const stage of ['live', 'completed']) {
      const capture = await execute(process.env.ADB ?? 'adb', ['-s', serial, 'exec-out', 'run-as', appPackage, 'cat', `files/interruption-${token}-${stage}.png`], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })
      await fs.writeFile(testInfo.outputPath(`android-${stage}.png`), capture.stdout)
    }
    await fs.writeFile(testInfo.outputPath('interruption-evidence.json'), JSON.stringify({ ...evidence, coreAdapter: serviceMode, controlledRuntimeRestart: true, liveAndRestoredPartialOutput: true, automaticSuccessors: 0, modelRequests: requests.length }, null, 2))
  }
  finally {
    await adb('shell', 'am', 'force-stop', appPackage)
    const result = await instrument
    if (result)
      await fs.writeFile(testInfo.outputPath('android-instrumentation.txt'), result.result?.stdout ?? String(result.error))
    await adb('shell', 'rm', '-f', remoteConfig)
    if (files.size)
      await adb('shell', 'run-as', appPackage, 'rm', '-f', ...files)
    if (reversed)
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
