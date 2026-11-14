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
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'
import { prepareMobileDesktopProfile } from '../fixtures/mobile-desktop.mjs'

const execute = promisify(execFile)
const serial = process.env.LEXORA_TEST_ANDROID_SERIAL
const serviceMode = process.env.LEXORA_TEST_MOBILE_SERVICE_MODE ?? 'utility'
const bindAddress = process.env.LEXORA_TEST_MOBILE_BIND_ADDRESS ?? '127.0.0.1'
const useAdbReverse = bindAddress === '127.0.0.1'
const prompts = [
  [{ id: 'coverage', question: '这次要验证哪些能力？', kind: 'multiple', options: [{ id: 'connection', label: '连接恢复', recommended: true }, { id: 'files', label: '文件操作' }, { id: 'source', label: '仅审查源码' }] }],
  [{ id: 'winner', question: '本次以哪一端的实际回答为准？', kind: 'single', options: [{ id: 'desktop', label: '由电脑提交回答' }, { id: 'mobile', label: '手机先填但不提交' }] }],
]

test('real Agent questions accept native Android choices, retain unfinished answers and close a stale dialog after Desktop answers', async ({ buddy }, testInfo) => {
  test.skip(!serial, 'Requires an Android device with the debug and instrumentation APKs installed')
  test.setTimeout(360000)
  const adb = (...args) => execute(process.env.ADB ?? 'adb', ['-s', serial, ...args], { timeout: 300000, maxBuffer: 8 * 1024 * 1024 })
  const bytes = async (...args) => (await execute(process.env.ADB ?? 'adb', ['-s', serial, ...args], { timeout: 15000, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })).stdout
  const token = randomUUID()
  const appPackage = 'app.uselexora.mobile.dev'
  const remoteConfig = `/data/local/tmp/lexora-questions-${token}.json`
  const resultFile = `files/questions-${token}.json`
  const configuration = testInfo.outputPath('pairing.json')
  const identityBackup = `no_backup/question-answer-${token}-identity`
  const captures = ['filled', 'restored-answer', 'delivered', 'awaiting-desktop', 'desktop-winner']
  const requests = []
  const cleanupFailures = []
  let instrumentStarted = false
  let instrument
  let instrumentProcess
  let instrumentOutcome
  let desktop
  let port
  let reversed = false
  const provider = createProvider((request, response) => {
    void (async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push(body)
      const serialized = JSON.stringify(body.messages)
      const phase = Number(serialized.match(/Question mobile phase ([01])/)?.[1] ?? '0')
      const calls = body.messages.flatMap(message => message.tool_calls ?? [])
      const agentRequest = body.tools?.some(tool => tool.function?.name === 'lexora_ask_user') === true
      const ask = calls.find(call => call.function?.name === 'lexora_ask_user')
      const waited = calls.some(call => call.function?.name === 'lexora_wait_user')
      let tool
      if (agentRequest && !ask) {
        tool = { name: 'lexora_ask_user', arguments: JSON.stringify({ questions: prompts[phase] }) }
      }
      else if (agentRequest && !waited) {
        const result = body.messages.find(message => message.role === 'tool' && message.tool_call_id === ask.id)
        const text = typeof result?.content === 'string' ? result.content : result?.content?.map(item => item.text ?? '').join('') ?? ''
        const requestId = text.match(/"requestId"\s*:\s*"([^"]+)"/)?.[1]
        if (!requestId)
          throw new Error('The actual ask_user tool did not return a request receipt')
        tool = { name: 'lexora_wait_user', arguments: JSON.stringify({ requestId }) }
      }
      const reply = phase === 0 ? `手机选择与补充😀 ${token}` : `桌面抢先回答 ${token}`
      const delta = tool
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `question-${phase}-${tool.name}`, type: 'function', function: tool }] }
        : { role: 'assistant', content: `问题验收完成 ${phase}：${serialized.includes(reply) ? reply : '未收到实际答案'}` }
      const common = { id: `question-${requests.length}`, model: 'fixture-model', object: 'chat.completion.chunk', created: 1 }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })().catch(error => response.destroy(error))
  })
  const restorePhone = async () => {
    if (!instrumentStarted)
      return
    await adb('shell', 'am', 'force-stop', appPackage)
    let manifest
    for (const suffix of ['.json', '.json.bak']) {
      manifest = await adb('shell', 'run-as', appPackage, 'cat', `${identityBackup}${suffix}`).then(result => JSON.parse(result.stdout), () => null)
      if (manifest)
        break
    }
    if (!manifest)
      return
    let cleanupError
    try {
      const cleanup = await adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.uselexora.mobile.QuestionAnswerInstrumentedTest', '-e', 'questionAnswerToken', token, '-e', 'questionAnswerRestoreOnly', 'true', `${appPackage}.test/androidx.test.runner.AndroidJUnitRunner`)
      await fs.writeFile(testInfo.outputPath('android-restoration.txt'), cleanup.stdout + cleanup.stderr)
      expect(cleanup.stdout).toMatch(/OK \(1 test\)/)
      expect(cleanup.stdout).not.toMatch(/INSTRUMENTATION_STATUS_CODE: -[234]|FAILURES/)
    }
    catch (error) { cleanupError = error }
    finally {
      await adb('shell', 'am', 'force-stop', appPackage)
      const original = await bytes('exec-out', 'run-as', appPackage, 'cat', `${identityBackup}.bin`)
      expect(createHash('sha256').update(original).digest('hex')).toBe(manifest.sha256)
      if (manifest.present) {
        await adb('shell', 'run-as', appPackage, 'cp', `${identityBackup}.bin`, `${identityBackup}.restore`)
        await adb('shell', 'run-as', appPackage, 'mv', `${identityBackup}.restore`, 'no_backup/device-identity.bin')
        await adb('shell', 'run-as', appPackage, 'rm', '-f', 'no_backup/device-identity.bin.bak', 'no_backup/device-identity.bin.new')
        const restored = await bytes('exec-out', 'run-as', appPackage, 'cat', 'no_backup/device-identity.bin')
        expect(createHash('sha256').update(restored).digest('hex')).toBe(manifest.sha256)
      }
      else {
        await adb('shell', 'run-as', appPackage, 'rm', '-f', 'no_backup/device-identity.bin', 'no_backup/device-identity.bin.bak', 'no_backup/device-identity.bin.new')
      }
    }
    if (cleanupError)
      throw cleanupError
    await adb('shell', 'run-as', appPackage, 'rm', '-f', `${identityBackup}.json`, `${identityBackup}.json.bak`, `${identityBackup}.json.new`, `${identityBackup}.bin`)
    await fs.writeFile(testInfo.outputPath('phone-restoration.json'), JSON.stringify({ originalIdentityRestored: true, testPartitionsRemoved: manifest.partitions.length, originalKeystorePreserved: true }))
  }
  const checkpoints = []
  const instrumentationText = outcome => [outcome?.result?.stdout ?? outcome?.error?.stdout, outcome?.result?.stderr ?? outcome?.error?.stderr, outcome?.error?.stack].filter(Boolean).join('\n')
  const assertInstrumentation = (outcome) => {
    const output = instrumentationText(outcome)
    if (outcome.error || !/OK \(1 test\)/.test(output) || /INSTRUMENTATION_STATUS_CODE: -[234]|FAILURES/.test(output))
      throw new Error(`Android question instrumentation failed:\n${output}`, { cause: outcome.error })
  }
  const checkpoint = async (phase, stage) => {
    const file = `files/questions-${token}-${phase}-${stage}.json`
    checkpoints.push(file)
    const deadline = performance.now() + 75000
    while (performance.now() < deadline) {
      let value
      try {
        value = JSON.parse((await adb('shell', 'run-as', appPackage, 'cat', file)).stdout)
      }
      catch {}
      if (instrumentOutcome) {
        assertInstrumentation(instrumentOutcome)
        if (value === undefined)
          throw new Error(`Android instrumentation completed before question checkpoint ${phase}/${stage}:\n${instrumentationText(instrumentOutcome)}`)
      }
      if (value !== undefined)
        return value
      await Promise.race([delay(250), instrument])
    }
    throw new Error(`Android question checkpoint ${phase}/${stage} was not reached within 75000 ms`)
  }
  const resume = async (phase) => {
    const file = `files/questions-${token}-${phase}-resume.json`
    checkpoints.push(file)
    await adb('shell', 'run-as', appPackage, 'touch', file)
  }
  try {
    provider.listen(0, '127.0.0.1')
    await once(provider, 'listening')
    const instance = await buddy.createInstance('mobile-questions')
    await prepareMobileDesktopProfile(instance.home, testInfo.outputPath('profile-preparation'))
    desktop = await instance.launch({ storageAuthority: 'sqlite', serviceMode })
    await useSyntheticCredentialStorage(desktop)
    const page = desktop.page
    const read = (query) => {
      const database = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'), { readOnly: true })
      try {
        return query(database)
      }
      finally { database.close() }
    }
    await page.evaluate(async (baseUrl) => {
      await window.lexoraDesktop.settings.update({ runtime: { codemode: 'off', modelRetryLimit: 0 } })
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'questions-fixture', displayName: 'Question verification', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'fixture-model', name: 'Question verification', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'questions-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('questions-fixture', 'api_key')
      }
      finally { stop() }
      await providers.setDefaultModel({ providerId: 'questions-fixture', modelId: 'fixture-model', reasoning: null })
    }, `http://127.0.0.1:${provider.address().port}/v1`)
    const cases = []
    for (let phase = 0; phase < 2; phase++) {
      const title = phase === 0 ? '手机问答与恢复验收' : '桌面抢先回答验收'
      const turn = await page.evaluate(async (phase) => {
        const api = window.lexoraDesktop.localChat
        const draftId = crypto.randomUUID()
        const draft = await api.composerDrafts.open({ draftId, scope: { kind: 'task', draftId, spaceId: null }, initialContent: { version: 1, body: [{ type: 'paragraph', content: [{ type: 'text', text: `Question mobile phase ${phase}` }] }], panelResourceIds: [] }, initialModelSelection: null, initialExecutionConfig: { executionProfile: 'read_only', approvalPolicy: 'policy' } })
        const turn = await api.chat.startTurn({ draftId, expectedRevision: draft.revision, requestId: crypto.randomUUID() })
        return { conversationId: turn.conversationId, branchId: turn.branchId, runId: turn.runId }
      }, phase)
      const scope = { conversationId: turn.conversationId, branchId: turn.branchId }
      await expect.poll(() => page.evaluate(scope => window.lexoraDesktop.localChat.questions.list(scope), scope), { timeout: 45000 }).toMatchObject([{ status: 'pending', questions: prompts[phase] }])
      const request = (await page.evaluate(scope => window.lexoraDesktop.localChat.questions.list(scope), scope))[0]
      await page.evaluate(async ({ id, title }) => {
        const api = window.lexoraDesktop.localChat.conversations
        const current = await api.get(id)
        await api.rename(id, title, current.titleRevision)
      }, { id: turn.conversationId, title })
      cases.push({ ...turn, requestId: request.id, title })
    }
    const listener = createServer()
    await new Promise(resolve => listener.listen(0, bindAddress, resolve))
    port = listener.address().port
    await new Promise(resolve => listener.close(resolve))
    await page.evaluate(({ bindAddress, port }) => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: true, bindAddress, port }), { bindAddress, port })
    if (useAdbReverse) {
      await adb('reverse', `tcp:${port}`, `tcp:${port}`)
      reversed = true
    }
    const pairing = await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.issuePairing({}))
    await fs.writeFile(configuration, JSON.stringify({ pairing, cases }), { mode: 0o600 })
    await adb('push', configuration, remoteConfig)
    await fs.rm(configuration)
    instrumentStarted = true
    instrumentProcess = adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.uselexora.mobile.QuestionAnswerInstrumentedTest', '-e', 'questionAnswerToken', token, `${appPackage}.test/androidx.test.runner.AndroidJUnitRunner`)
    instrument = instrumentProcess.then(result => ({ result }), error => ({ error })).then((outcome) => {
      instrumentOutcome = outcome
      return outcome
    })
    const phone = await checkpoint(0, 'done')
    expect(phone).toMatchObject({ requestId: cases[0].requestId, activityRecreated: true, selectedOptionIds: ['connection', 'files'], text: `手机选择与补充😀 ${token}` })
    const scopeOf = item => ({ conversationId: item.conversationId, branchId: item.branchId })
    const currentQuestion = item => page.evaluate(scope => window.lexoraDesktop.localChat.questions.list(scope), scopeOf(item))
    await expect.poll(() => currentQuestion(cases[0])).toMatchObject([{ status: 'answered', response: { answers: [{ questionId: 'coverage', selectedOptionIds: ['connection', 'files'], text: phone.text }] }, delivery: { state: 'delivered' } }])
    await expect.poll(() => page.evaluate(id => window.lexoraDesktop.localChat.runs.get(id), cases[0].runId)).toMatchObject({ status: 'completed' })
    await resume(0)
    const ready = await checkpoint(1, 'ready')
    expect(ready).toMatchObject({ requestId: cases[1].requestId, dialogOpen: true })
    await page.evaluate(async ({ scope, requestId, text }) => {
      await window.lexoraDesktop.localChat.questions.answer({ ...scope, requestId, answers: [{ questionId: 'winner', selectedOptionIds: ['desktop'], text }] })
    }, { scope: scopeOf(cases[1]), requestId: cases[1].requestId, text: `桌面抢先回答 ${token}` })
    await expect.poll(() => currentQuestion(cases[1])).toMatchObject([{ status: 'answered', response: { answers: [{ selectedOptionIds: ['desktop'], text: `桌面抢先回答 ${token}` }] }, delivery: { state: 'delivered' } }])
    await expect.poll(() => page.evaluate(id => window.lexoraDesktop.localChat.runs.get(id), cases[1].runId)).toMatchObject({ status: 'completed' })
    await resume(1)
    expect(await checkpoint(1, 'done')).toMatchObject({ staleDialogClosed: true, noStaleCommand: true })
    const outcome = await instrument
    assertInstrumentation(outcome)
    const evidence = JSON.parse((await adb('shell', 'run-as', appPackage, 'cat', resultFile)).stdout)
    expect(evidence).toMatchObject({ activityRecreated: true, multipleChoicesAndText: true, staleDialogClosed: true, noStaleCommand: true, originalIdentityRestored: true })
    for (const [phase, item] of cases.entries()) {
      const events = read(db => db.prepare('SELECT event_type, payload_json FROM run_events WHERE run_id = ? ORDER BY sequence').all(item.runId))
      const toolNames = events.filter(event => event.event_type === 'tool.started').map(event => JSON.parse(event.payload_json).toolName)
      expect(toolNames.filter(name => name === 'lexora_ask_user')).toHaveLength(1)
      expect(toolNames.filter(name => name === 'lexora_wait_user')).toHaveLength(1)
      expect(read(db => db.prepare('SELECT COUNT(*) AS count FROM execution_mailbox_sources WHERE id = ?').get(`user-question:${item.requestId}`).count)).toBe(1)
      const reply = read(db => db.prepare('SELECT content_json FROM messages WHERE run_id = ? AND role = \'assistant\'').all(item.runId)).map(row => JSON.parse(row.content_json).text ?? '').join('\n')
      expect(reply).toContain(phase === 0 ? phone.text : `桌面抢先回答 ${token}`)
    }
    const receipts = read(db => db.prepare('SELECT decision, target_json FROM command_receipts WHERE method = \'questions.answer\'').all())
    expect(receipts).toHaveLength(2)
    expect(new Set(receipts.map(receipt => JSON.parse(receipt.target_json).questionId))).toEqual(new Set(cases.map(item => item.requestId)))
    expect(receipts.every(receipt => receipt.decision === 'accepted')).toBe(true)
    expect(JSON.stringify(requests)).not.toContain(`此手机旧回答不得投递 ${token}`)
    await fs.writeFile(testInfo.outputPath('questions.json'), JSON.stringify({ ...evidence, cases, syntheticProvider: true, toolExecutionFromCore: true, mailboxInputs: 2, productAnswerReceipts: 2, desktopWinnerUsesProductGateway: true }, null, 2))
    await page.screenshot({ path: testInfo.outputPath('desktop-questions.png') })
  }
  finally {
    if (instrument && !instrumentOutcome) {
      await adb('shell', 'am', 'force-stop', appPackage).catch(error => cleanupFailures.push(error))
      await Promise.race([instrument, delay(10000)])
      if (!instrumentOutcome) {
        instrumentProcess.child.kill('SIGTERM')
        await instrument
      }
    }
    const output = instrumentationText(instrumentOutcome)
    if (instrumentStarted)
      await fs.writeFile(testInfo.outputPath('android-instrumentation.txt'), output || 'Instrumentation did not return output').catch(error => cleanupFailures.push(error))
    const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    for (const capture of captures) {
      const image = await bytes('exec-out', 'run-as', appPackage, 'cat', `files/questions-${token}-${capture}.png`).catch(() => null)
      if (image?.subarray(0, 8).equals(pngHeader))
        await fs.writeFile(testInfo.outputPath(`android-${capture}.png`), image).catch(error => cleanupFailures.push(error))
    }
    for (const name of new Set(output.match(/mobile-ui-failure-\d+\.(?:json|png)/g) ?? [])) {
      const file = `files/${name}`
      checkpoints.push(file)
      const value = await bytes('exec-out', 'run-as', appPackage, 'cat', file).catch(() => null)
      if (!value)
        continue
      try {
        if (name.endsWith('.png') ? !value.subarray(0, 8).equals(pngHeader) : !Array.isArray(JSON.parse(value.toString('utf8'))))
          continue
      }
      catch { continue }
      await fs.writeFile(testInfo.outputPath(name), value).catch(error => cleanupFailures.push(error))
    }
    await restorePhone().catch(error => cleanupFailures.push(error))
    const cleanup = await Promise.allSettled([
      adb('shell', 'rm', '-f', remoteConfig),
      adb('shell', 'run-as', appPackage, 'rm', '-f', resultFile, ...checkpoints, ...captures.map(capture => `files/questions-${token}-${capture}.png`)),
      fs.rm(configuration, { force: true }),
      (async () => {
        provider.closeAllConnections()
        await new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve()))
      })(),
      (async () => {
        try {
          if (desktop) {
            for (const device of await desktop.page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.devices({}))) {
              if (device.state === 'active')
                await desktop.page.evaluate(deviceId => window.lexoraDesktop.localChat.privateNetwork.revoke({ deviceId }), device.deviceId)
            }
            await desktop.page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: false }))
          }
        }
        finally {
          if (reversed)
            await adb('reverse', '--remove', `tcp:${port}`)
        }
      })(),
    ])
    cleanupFailures.push(...cleanup.filter(result => result.status === 'rejected').map(result => result.reason))
  }
  if (cleanupFailures.length)
    throw new AggregateError(cleanupFailures, 'Could not clean up the isolated mobile questions test')
})
