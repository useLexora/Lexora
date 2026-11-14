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

test('Android historical followup, edit and regeneration preserve branches, restored input and exact source targets', async ({ buddy }, testInfo) => {
  test.skip(!serial, 'Requires an isolated Android device with debug and instrumentation APKs')
  test.setTimeout(240000)
  const adb = (...args) => execute(process.env.ADB ?? 'adb', ['-s', serial, ...args], { timeout: 210000, maxBuffer: 8 * 1024 * 1024 })
  const token = randomUUID()
  const appPackage = 'app.uselexora.mobile.dev'
  const remoteConfig = `/data/local/tmp/lexora-history-${token}.json`
  const configuration = testInfo.outputPath('pairing.json')
  const requests = []
  const provider = createServer((request, response) => {
    void (async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const number = requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const common = { id: `history-${number}`, model: 'fixture-model', object: 'chat.completion.chunk', created: 1 }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: `历史回复 ${number} 😀` }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })().catch(() => response.destroy())
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const instance = await buddy.createInstance('mobile-history')
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
  let instrument
  let outcome
  let reversed = false
  const marker = stage => `files/history-${token}-${stage}.json`
  const files = new Set([`files/history-${token}-branches.png`])
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
      await providers.upsertCustom({ id: 'history-fixture', displayName: 'History fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'fixture-model', name: 'History model', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'history-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('history-fixture', 'api_key')
      }
      finally { stop() }
      await providers.setDefaultModel({ providerId: 'history-fixture', modelId: 'fixture-model', reasoning: null })
    }, `http://127.0.0.1:${provider.address().port}/v1`)
    await page.reload()
    for (const [index, input] of ['历史基线输入', '后续输入不应进入历史续写'].entries()) {
      await page.locator('.desktop-chat-composer__prosemirror:visible').fill(input)
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = \'completed\'').get().count)).toBe(index + 1)
    }
    const original = read(db => db.prepare('SELECT id, conversation_id, branch_id FROM runs ORDER BY started_at LIMIT 1').get())
    await page.evaluate(() => {
      location.hash = '/settings/general'
    })
    await page.evaluate(port => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: true, bindAddress: '127.0.0.1', port }), port)
    const pairing = await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.issuePairing({}))
    await fs.writeFile(configuration, JSON.stringify({ pairing, conversationId: original.conversation_id, originalBranchId: original.branch_id }), { mode: 0o600 })
    await adb('reverse', `tcp:${port}`, `tcp:${port}`)
    reversed = true
    await adb('push', configuration, remoteConfig)
    await fs.rm(configuration)
    instrument = adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.uselexora.mobile.HistoryInstrumentedTest', '-e', 'historyToken', token, `${appPackage}.test/androidx.test.runner.AndroidJUnitRunner`)
      .then(result => ({ result }), error => ({ error }))
      .then((result) => {
        outcome = result
        return result
      })
    const regenerated = await checkpoint('regenerated')
    expect(requests).toHaveLength(5)
    for (const index of [2, 3, 4]) {
      const input = JSON.stringify(requests[index].messages)
      expect(input).toContain('历史回复 1')
      expect(input).not.toContain('后续输入不应进入历史续写')
      expect(input).not.toContain('历史回复 2')
    }
    expect(JSON.stringify(requests[2].messages)).toContain('从第一条回复继续')
    expect(JSON.stringify(requests[3].messages)).toContain('编辑后的接续输入')
    expect(JSON.stringify(requests[4].messages)).toContain('编辑后的接续输入')
    const activate = branchId => page.evaluate(async ({ conversationId, branchId }) => {
      const api = window.lexoraDesktop.localChat.conversations
      const current = await api.get(conversationId)
      await api.activateBranch({ conversationId, branchId, expectedRevision: current.metadataRevision })
    }, { conversationId: original.conversation_id, branchId })
    await activate(original.branch_id)
    await signal('original-active')
    await checkpoint('source-edit-ready')
    await activate(regenerated.branchId)
    await signal('branch-changed')
    const independentEdit = await checkpoint('delete-ready')
    expect(independentEdit.branchId).not.toBe(original.branch_id)
    expect(independentEdit.branchId).not.toBe(regenerated.branchId)
    expect(requests).toHaveLength(6)
    expect(JSON.stringify(requests[5].messages)).toContain('默认分支改变仍从原来源编辑')
    expect(JSON.stringify(requests[5].messages)).not.toContain('编辑后的接续输入')
    expect(read(db => db.prepare('SELECT COUNT(*) AS count FROM runs').get().count)).toBe(6)
    expect(read(db => db.prepare('SELECT COUNT(*) AS count FROM messages WHERE branch_id = ?').get(original.branch_id).count)).toBe(4)
    expect(read(db => db.prepare('SELECT active_branch_id FROM conversations WHERE id = ?').get(original.conversation_id).active_branch_id)).toBe(regenerated.branchId)
    await page.evaluate(async (id) => {
      const api = window.lexoraDesktop.localChat.conversations
      const current = await api.get(id)
      if (!await api.delete(id, current.metadataRevision))
        throw new Error('Fixture task was not deleted')
    }, original.conversation_id)
    await signal('task-deleted')
    const evidence = await checkpoint('done')
    expect(evidence).toMatchObject({ independentBranchEditAccepted: true, deletedSourceRejection: { decision: 'rejected', errorCode: 'SOURCE_CHANGED' } })
    const result = await instrument
    expect(result.error).toBeUndefined()
    expect(result.result.stdout).toMatch(/OK \(1 test\)/)
    expect(result.result.stdout).not.toMatch(/INSTRUMENTATION_STATUS_CODE: -[234]|FAILURES/)
    expect(requests).toHaveLength(6)
    expect(read(db => db.prepare('SELECT COUNT(*) AS count FROM runs').get().count)).toBe(0)
    expect(read(db => db.prepare('SELECT COUNT(*) AS count FROM messages').get().count)).toBe(0)
    expect(read(db => db.prepare('SELECT id FROM conversations WHERE id = ?').get(original.conversation_id))).toBeUndefined()
    const capture = await execute(process.env.ADB ?? 'adb', ['-s', serial, 'exec-out', 'run-as', appPackage, 'cat', `files/history-${token}-branches.png`], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })
    await fs.writeFile(testInfo.outputPath('android-history-branches.png'), capture.stdout)
    await fs.writeFile(testInfo.outputPath('history-evidence.json'), JSON.stringify({ ...evidence, coreAdapter: serviceMode, modelRequests: requests.length, syntheticProvider: true, originalBranchPreservedBeforeDeletion: true, deletedTaskPurged: true, laterContextExcluded: true }, null, 2))
  }
  finally {
    await adb('shell', 'am', 'force-stop', appPackage)
    const result = await instrument
    if (result)
      await fs.writeFile(testInfo.outputPath('android-instrumentation.txt'), result.result?.stdout ?? String(result.error))
    await adb('shell', 'rm', '-f', remoteConfig)
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
