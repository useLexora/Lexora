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

test('Android direct stop, queue, branch switching and read state preserve exact targets and local input', async ({ buddy }, testInfo) => {
  test.skip(!serial, 'Requires an isolated Android device with debug and instrumentation APKs')
  test.setTimeout(300000)
  const adb = (...args) => execute(process.env.ADB ?? 'adb', ['-s', serial, ...args], { timeout: 280000, maxBuffer: 8 * 1024 * 1024 })
  const token = randomUUID()
  const appPackage = 'app.uselexora.mobile.dev'
  const remoteConfig = `/data/local/tmp/lexora-controls-${token}.json`
  const configuration = testInfo.outputPath('pairing.json')
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers())
  const requests = []
  const provider = createServer((request, response) => {
    void (async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const index = requests.push(body) - 1
      if (gates[index] && !await Promise.race([gates[index].promise.then(() => true), once(response, 'close').then(() => false)]))
        return
      const common = { id: `controls-${index}`, model: 'fixture-model', object: 'chat.completion.chunk', created: 1 }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: index === 0 ? '首段输出结束' : index < 3 ? '恢复排队任务完成' : '历史分支验证回复' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })().catch(() => response.destroy())
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const instance = await buddy.createInstance('mobile-task-controls')
  await prepareMobileDesktopProfile(instance.home, testInfo.outputPath('profile-preparation'))
  const desktop = await instance.launch({ storageAuthority: 'sqlite', serviceMode })
  await useSyntheticCredentialStorage(desktop)
  const { page } = desktop
  const read = (query) => {
    const database = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'), { readOnly: true })
    try {
      return query(database)
    }
    finally { database.close() }
  }
  const listener = createListener()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  let reversed = false
  let started = false
  let failure
  let instrument
  let outcome
  const files = new Set(['stopped.png', 'final.png'].map(name => `files/controls-${token}-${name}`))
  const marker = stage => `files/controls-${token}-${stage}.json`
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
      await providers.upsertCustom({ id: 'controls-fixture', displayName: 'Controls fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'fixture-model', name: 'Controls model', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'controls-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('controls-fixture', 'api_key')
      }
      finally { stop() }
      await providers.setDefaultModel({ providerId: 'controls-fixture', modelId: 'fixture-model', reasoning: null })
    }, `http://127.0.0.1:${provider.address().port}/v1`)
    await page.reload()
    await page.locator('.desktop-chat-composer__prosemirror:visible').fill('Mobile controls baseline')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => requests.length).toBe(1)
    const first = read(db => db.prepare('SELECT id, conversation_id, branch_id FROM runs WHERE status = \'running\'').get())
    expect(first).toBeTruthy()
    await page.evaluate(() => {
      location.hash = '/settings/general'
    })
    await expect(page).toHaveURL(/#\/settings\/general/)
    await page.evaluate(port => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: true, bindAddress: '127.0.0.1', port }), port)
    const pairing = await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.issuePairing({}))
    await fs.writeFile(configuration, JSON.stringify({ pairing, conversationId: first.conversation_id }), { mode: 0o600 })
    await adb('reverse', `tcp:${port}`, `tcp:${port}`)
    reversed = true
    await adb('push', configuration, remoteConfig)
    await fs.rm(configuration)
    started = true
    instrument = adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.uselexora.mobile.TaskControlsInstrumentedTest', '-e', 'taskControlsToken', token, `${appPackage}.test/androidx.test.runner.AndroidJUnitRunner`)
      .then(result => ({ result }), error => ({ error }))
      .then((result) => {
        outcome = result
        return result
      })
    const stale = await checkpoint('stale-ready')
    expect(await page.evaluate(item => window.lexoraDesktop.localChat.chat.cancelQueued({ id: item.id, conversationId: item.conversationId, branchId: item.branchId, expectedRevision: Number(item.revision) }), stale)).toBe(true)
    await signal('stale-removed')
    expect((await checkpoint('steered')).runId).toBe(first.id)
    gates[0].resolve()
    await expect.poll(() => requests.length).toBe(2)
    expect(JSON.stringify(requests[1].messages)).toContain('手机补充当前执行')
    expect(read(db => db.prepare('SELECT COUNT(*) AS count FROM runs').get().count)).toBe(1)
    await signal('steer-delivered')
    const paused = await checkpoint('paused')
    expect(read(db => db.prepare('SELECT state FROM chat_queue WHERE id = ?').get(paused.queueId).state)).toBe('paused')
    expect(read(db => db.prepare('SELECT status FROM runs WHERE id = ?').get(first.id).status)).toBe('cancelled')
    expect(requests).toHaveLength(2)
    await signal('continue')
    await expect.poll(() => requests.length).toBe(3)
    await signal('next-running')
    const replay = await checkpoint('old-stop-replayed')
    expect(replay.nextRunId).not.toBe(first.id)
    expect(read(db => db.prepare('SELECT status FROM runs WHERE id = ?').get(replay.nextRunId).status)).toBe('running')
    gates[2].resolve()
    const phoneRead = await checkpoint('phone-read')
    expect(phoneRead.unread).toBe(false)
    const states = () => page.evaluate(id => window.lexoraDesktop.localChat.taskMarks.states([id]), first.conversation_id)
    await expect.poll(states).toMatchObject([{ unread: false, resultRunId: replay.nextRunId }])
    const setRead = read => page.evaluate(async ({ id, read }) => {
      const marks = window.lexoraDesktop.localChat.taskMarks
      const [state] = await marks.states([id])
      return marks.setRead({ conversationId: id, resultRunId: state.resultRunId, readRevision: state.readRevision, read })
    }, { id: first.conversation_id, read })
    expect(await setRead(false)).toMatchObject({ unread: true })
    await signal('desktop-unread')
    await checkpoint('background')
    expect(await setRead(true)).toMatchObject({ unread: false })
    await signal('desktop-read')
    await checkpoint('branches-ready')
    const fork = await page.evaluate(({ conversationId, sourceRunId, requestId }) => window.lexoraDesktop.localChat.chat.regenerateAssistant({ conversationId, sourceRunId, requestId }), { conversationId: first.conversation_id, sourceRunId: replay.nextRunId, requestId: randomUUID() })
    expect(fork.branchId).not.toBe(first.branch_id)
    await expect.poll(() => read(db => db.prepare('SELECT status FROM runs WHERE id = ?').get(fork.runId).status)).toBe('completed')
    await page.evaluate(async ({ conversationId, branchId }) => {
      const conversations = window.lexoraDesktop.localChat.conversations
      const current = await conversations.get(conversationId)
      await conversations.activateBranch({ conversationId, branchId, expectedRevision: current.metadataRevision })
    }, { conversationId: first.conversation_id, branchId: first.branch_id })
    await signal('branches-created')
    const evidence = await checkpoint('done')
    expect(evidence).toMatchObject({ directStopRetainedInput: true, branchDraftIsolation: true, forkBranchId: fork.branchId, originalBranchId: first.branch_id })
    expect(read(db => db.prepare('SELECT active_branch_id FROM conversations WHERE id = ?').get(first.conversation_id).active_branch_id)).toBe(first.branch_id)
    await expect(page).toHaveURL(/#\/settings\/general/)
    const result = await instrument
    await fs.writeFile(testInfo.outputPath('android-instrumentation.txt'), result.result?.stdout ?? String(result.error))
    expect(result.error).toBeUndefined()
    expect(result.result.stdout).toMatch(/OK \(1 test\)/)
    expect(result.result.stdout).not.toMatch(/INSTRUMENTATION_STATUS_CODE: -[234]|FAILURES/)
    expect(read(db => db.prepare('SELECT COUNT(*) AS count FROM runs').get().count)).toBe(3)
    expect(requests).toHaveLength(4)
    for (const stage of ['stopped', 'final']) {
      const capture = await execute(process.env.ADB ?? 'adb', ['-s', serial, 'exec-out', 'run-as', appPackage, 'cat', `files/controls-${token}-${stage}.png`], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })
      await fs.writeFile(testInfo.outputPath(`android-${stage}.png`), capture.stdout)
    }
    await fs.writeFile(testInfo.outputPath('task-control-evidence.json'), JSON.stringify({ ...evidence, coreAdapter: serviceMode, modelRequests: requests.length, syntheticProvider: true }, null, 2))
  }
  catch (error) { failure = error }
  finally {
    const cleanupErrors = []
    const cleanup = async (action) => {
      try {
        await action()
      }
      catch (error) { cleanupErrors.push(error) }
    }
    if (started)
      await cleanup(() => adb('shell', 'am', 'force-stop', appPackage))
    const result = await instrument
    if (result)
      await cleanup(() => fs.writeFile(testInfo.outputPath('android-instrumentation.txt'), result.result?.stdout ?? String(result.error)))
    await cleanup(() => adb('shell', 'rm', '-f', remoteConfig))
    if (started)
      await cleanup(() => adb('shell', 'run-as', appPackage, 'rm', '-f', ...files))
    if (reversed)
      await cleanup(() => adb('reverse', '--remove', `tcp:${port}`))
    await cleanup(() => fs.rm(configuration, { force: true }))
    await cleanup(async () => {
      for (const device of await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.devices({}))) {
        if (device.state === 'active')
          await page.evaluate(deviceId => window.lexoraDesktop.localChat.privateNetwork.revoke({ deviceId }), device.deviceId)
      }
      await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: false }))
    })
    for (const gate of gates) gate.resolve()
    provider.closeAllConnections()
    await cleanup(() => new Promise(resolve => provider.close(resolve)))
    if (cleanupErrors.length) {
      if (!failure)
        failure = new AggregateError(cleanupErrors, 'Mobile task control cleanup failed')
      else
        await cleanup(() => fs.writeFile(testInfo.outputPath('cleanup-errors.txt'), cleanupErrors.map(error => String(error)).join('\n')))
    }
  }
  if (failure)
    throw failure
})
