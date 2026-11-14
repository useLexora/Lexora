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

test('Android and Desktop browse and run separate branches concurrently without mixing drafts, questions or queues', async ({ buddy }, testInfo) => {
  test.skip(!serial, 'Requires an Android device with current debug and instrumentation APKs')
  test.setTimeout(420000)
  const adb = (...args) => execute(process.env.ADB ?? 'adb', ['-s', serial, ...args], { timeout: 360000, maxBuffer: 8 * 1024 * 1024 })
  const bytes = async (...args) => (await execute(process.env.ADB ?? 'adb', ['-s', serial, ...args], { timeout: 15000, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })).stdout
  const token = randomUUID()
  const appPackage = 'app.uselexora.mobile.dev'
  const remoteConfig = `/data/local/tmp/lexora-branches-${token}.json`
  const configuration = testInfo.outputPath('pairing.json')
  const identityBackup = `no_backup/branch-parallel-${token}-identity`
  const files = new Set()
  const marker = stage => `files/branches-${token}-${stage}.json`
  const gates = Object.fromEntries(['A-initial', 'B-initial', 'A-result', 'B-result'].map(key => [key, Promise.withResolvers()]))
  const requests = []
  const cleanupFailures = []
  let desktop
  let port
  let reversed = false
  let started = false
  let instrument
  let outcome
  const provider = createProvider((request, response) => {
    void (async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const input = body.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n')
      const markers = [...input.matchAll(/Parallel (baseline [AB]|edited A|branch ([AB]) main)|Queue branch ([AB])/g)]
      const selected = markers.at(-1)
      const branch = selected?.[2]
      const queueBranch = selected?.[3]
      const agentRequest = body.tools?.some(tool => tool.function?.name === 'lexora_ask_user') === true
      const calls = body.messages.flatMap(message => message.tool_calls ?? [])
      const ask = calls.find(call => call.function?.name === 'lexora_ask_user')
      const waited = calls.some(call => call.function?.name === 'lexora_wait_user')
      const phase = branch && agentRequest ? !ask ? 'initial' : !waited ? 'wait' : 'result' : queueBranch ? 'queue' : 'baseline'
      const record = { branch: branch ?? queueBranch ?? null, phase, receivedAt: Date.now(), closedAt: null, body }
      requests.push(record)
      response.once('close', () => {
        record.closedAt = Date.now()
      })
      const common = { id: `branch-${requests.length}`, model: 'fixture-model', object: 'chat.completion.chunk', created: 1 }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = (delta, finish = null) => response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      const hold = async key => Promise.race([gates[key].promise.then(() => true), once(response, 'close').then(() => false)])
      let tool
      if (phase === 'initial') {
        emit({ role: 'assistant', content: `${branch} 并行输出开始 ${token}\n` })
        if (!await hold(`${branch}-initial`))
          return
        tool = { id: `branch-${branch}-ask`, name: 'lexora_ask_user', arguments: JSON.stringify({ questions: [{ id: `answer-${branch}`, question: `只回答分支 ${branch} 的问题`, kind: 'text', options: [] }] }) }
      }
      else if (phase === 'wait') {
        const result = body.messages.find(message => message.role === 'tool' && message.tool_call_id === ask.id)
        const content = typeof result?.content === 'string' ? result.content : result?.content?.map(item => item.text ?? '').join('') ?? ''
        const requestId = content.match(/"requestId"\s*:\s*"([^"]+)"/)?.[1]
        if (!requestId)
          throw new Error('Actual ask_user receipt did not contain requestId')
        tool = { id: `branch-${branch}-wait`, name: 'lexora_wait_user', arguments: JSON.stringify({ requestId }) }
      }
      else if (phase === 'result') {
        if (!JSON.stringify(body.messages).includes(`分支 ${branch} 的回答 ${token}`))
          throw new Error('Answer was delivered to the wrong branch')
        emit({ role: 'assistant', content: `${branch} 已收到本分支回答 ${token}\n` })
        if (!await hold(`${branch}-result`))
          return
        emit({ content: `${branch} 并行完成 ${token}` })
      }
      else {
        const text = queueBranch ? `${queueBranch} 队列独立完成 ${token}` : selected?.[1] === 'edited A' ? `编辑 A 的新分支结果 ${token}` : `历史 ${selected?.[1]?.endsWith('B') ? 'B' : 'A'} 原文 ${token}`
        emit({ role: 'assistant', content: text })
      }
      if (tool)
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }] })
      emit({}, tool ? 'tool_calls' : 'stop')
      response.end('data: [DONE]\n\n')
    })().catch(error => response.destroy(error))
  })
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
    }, { timeout: 90000 }).toBe(true)
    return value
  }
  const signal = async (stage) => {
    files.add(marker(stage))
    await adb('shell', 'run-as', appPackage, 'touch', marker(stage))
  }
  const restorePhone = async () => {
    if (!started)
      return
    await adb('shell', 'am', 'force-stop', appPackage)
    let manifest
    for (const suffix of ['.json', '.json.bak']) {
      manifest = await adb('shell', 'run-as', appPackage, 'cat', `${identityBackup}${suffix}`).then(value => JSON.parse(value.stdout), () => null)
      if (manifest)
        break
    }
    if (!manifest)
      return
    let failure
    try {
      const result = await adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.uselexora.mobile.BranchParallelInstrumentedTest', '-e', 'branchParallelToken', token, '-e', 'branchParallelRestoreOnly', 'true', `${appPackage}.test/androidx.test.runner.AndroidJUnitRunner`)
      await fs.writeFile(testInfo.outputPath('android-restoration.txt'), result.stdout + result.stderr)
      expect(result.stdout).toMatch(/OK \(1 test\)/)
      expect(result.stdout).not.toMatch(/INSTRUMENTATION_STATUS_CODE: -[234]|FAILURES/)
    }
    catch (error) { failure = error }
    finally {
      await adb('shell', 'am', 'force-stop', appPackage)
      const original = await bytes('exec-out', 'run-as', appPackage, 'cat', `${identityBackup}.bin`)
      expect(createHash('sha256').update(original).digest('hex')).toBe(manifest.sha256)
      if (manifest.present) {
        await adb('shell', 'run-as', appPackage, 'cp', `${identityBackup}.bin`, `${identityBackup}.restore`)
        await adb('shell', 'run-as', appPackage, 'mv', `${identityBackup}.restore`, 'no_backup/device-identity.bin')
        await adb('shell', 'run-as', appPackage, 'rm', '-f', 'no_backup/device-identity.bin.bak', 'no_backup/device-identity.bin.new')
        expect(createHash('sha256').update(await bytes('exec-out', 'run-as', appPackage, 'cat', 'no_backup/device-identity.bin')).digest('hex')).toBe(manifest.sha256)
      }
      else {
        await adb('shell', 'run-as', appPackage, 'rm', '-f', 'no_backup/device-identity.bin', 'no_backup/device-identity.bin.bak', 'no_backup/device-identity.bin.new')
      }
    }
    if (failure)
      throw failure
    await adb('shell', 'run-as', appPackage, 'rm', '-f', `${identityBackup}.bin`, `${identityBackup}.json`, `${identityBackup}.json.bak`)
  }
  try {
    provider.listen(0, '127.0.0.1')
    await once(provider, 'listening')
    const instance = await buddy.createInstance('mobile-branches')
    await prepareMobileDesktopProfile(instance.home, testInfo.outputPath('profile-preparation'))
    desktop = await instance.launch({ storageAuthority: 'sqlite', serviceMode })
    await useSyntheticCredentialStorage(desktop)
    const { page } = desktop
    const read = (query) => {
      const database = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'), { readOnly: true })
      try {
        return query(database)
      }
      finally { database.close() }
    }
    await page.evaluate(async (baseUrl) => {
      await window.lexoraDesktop.settings.update({ runtime: { codemode: 'off', modelRetryLimit: 0 }, desktop: { chat: { followUpBehavior: 'queue' } } })
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'branches-fixture', displayName: 'Branch verification', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'fixture-model', name: 'Branch verification', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'branches-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('branches-fixture', 'api_key')
      }
      finally { stop() }
      await providers.setDefaultModel({ providerId: 'branches-fixture', modelId: 'fixture-model', reasoning: null })
    }, `http://127.0.0.1:${provider.address().port}/v1`)
    await page.reload()
    const composer = page.locator('.desktop-chat-composer__prosemirror:visible')
    await composer.fill(`Parallel baseline A ${token}`)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = \'completed\'').get().count)).toBe(1)
    const first = read(db => db.prepare('SELECT id, conversation_id, branch_id, triggering_message_id FROM runs ORDER BY rowid LIMIT 1').get())
    const conversationId = first.conversation_id
    const branchA = first.branch_id
    const originalRecords = read(db => db.prepare('SELECT id, content_json FROM messages WHERE branch_id = ? ORDER BY rowid').all(branchA))
    const title = `分支并行验收 ${token.slice(0, 8)}`
    const fork = await page.evaluate(async ({ conversationId, branchId, userMessageId, token, title }) => {
      const api = window.lexoraDesktop.localChat
      const current = await api.conversations.get(conversationId)
      await api.conversations.rename(conversationId, title, current.titleRevision)
      const draft = await api.composerDrafts.open({ draftId: crypto.randomUUID(), scope: { kind: 'message_edit', conversationId, branchId, userMessageId }, initialContent: { version: 1, body: [{ type: 'paragraph', content: [{ type: 'text', text: `Parallel baseline B ${token}` }] }], panelResourceIds: [] }, initialModelSelection: null, initialExecutionConfig: { executionProfile: current.executionProfile, approvalPolicy: current.approvalPolicy } })
      return api.chat.editUserMessage({ conversationId, userMessageId, draftId: draft.draftId, expectedRevision: draft.revision, requestId: crypto.randomUUID() })
    }, { conversationId, branchId: branchA, userMessageId: first.triggering_message_id, token, title })
    const branchB = fork.branchId
    await expect.poll(() => read(db => db.prepare('SELECT status FROM runs WHERE id = ?').get(fork.runId).status)).toBe('completed')
    expect(branchB).not.toBe(branchA)
    await page.locator('[data-testid="conversation-branches"]:visible').click()
    await page.getByTestId(`conversation-branch-${branchB}`).click()
    const branchView = page.locator('[data-testid="conversation-branches"]:visible')
    await expect(branchView).toHaveAttribute('data-branch-id', branchB)
    const listener = createServer()
    await new Promise(resolve => listener.listen(0, bindAddress, resolve))
    port = listener.address().port
    await new Promise(resolve => listener.close(resolve))
    await page.evaluate(value => window.lexoraDesktop.localChat.privateNetwork.configure(value), { enabled: true, bindAddress, port })
    if (bindAddress === '127.0.0.1') {
      await adb('reverse', `tcp:${port}`, `tcp:${port}`)
      reversed = true
    }
    const pairing = await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.issuePairing({}))
    await fs.writeFile(configuration, JSON.stringify({ pairing, title, conversationId, branchA, branchB }), { mode: 0o600 })
    await adb('push', configuration, remoteConfig)
    await fs.rm(configuration)
    started = true
    instrument = adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.uselexora.mobile.BranchParallelInstrumentedTest', '-e', 'branchParallelToken', token, `${appPackage}.test/androidx.test.runner.AndroidJUnitRunner`).then(result => ({ result }), error => ({ error })).then((value) => {
      outcome = value
      return value
    })
    const phone = await checkpoint('phone-started')
    await expect(branchView).toHaveAttribute('data-branch-id', branchB)
    await composer.fill(`Parallel branch B main ${token}`)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => requests.filter(value => value.phase === 'initial').map(value => value.branch).sort(), { timeout: 45000 }).toEqual(['A', 'B'])
    const runB = read(db => db.prepare('SELECT id FROM runs WHERE branch_id = ? AND status = \'running\'').get(branchB)).id
    const concurrent = read(db => db.prepare('SELECT id, branch_id, buddy_id FROM runs WHERE id IN (?, ?) AND status = \'running\'').all(phone.runId, runB))
    expect(concurrent).toHaveLength(2)
    expect(new Set(concurrent.map(run => run.buddy_id)).size).toBe(1)
    expect(requests.filter(value => value.phase === 'initial').every(value => value.closedAt === null)).toBe(true)
    await expect(page.getByText(`B 并行输出开始 ${token}`, { exact: false })).toBeVisible()
    await expect(page.getByText(`A 并行输出开始 ${token}`, { exact: false })).toHaveCount(0)
    await signal('both-running')
    await expect(composer).toHaveText('')
    const queueText = `Queue branch B ${token}`
    await composer.fill(queueText)
    await page.locator('.desktop-chat-composer__actions:visible').getByRole('button', { name: '加入队列', exact: true }).click()
    await expect(composer).toHaveText('')
    const queuedRow = page.locator('.chat-message-queue__row:visible').filter({ hasText: queueText })
    await expect(queuedRow).toBeVisible()
    const queuedBranchB = await page.evaluate(value => window.lexoraDesktop.localChat.chat.listQueue(value), { conversationId, branchId: branchB })
    expect(queuedBranchB).toHaveLength(1)
    const queueB = queuedBranchB[0].id
    await expect(queuedRow).toHaveAttribute('data-queued-message', queueB)
    expect(queuedBranchB[0]).toMatchObject({ conversationId, branchId: branchB, state: 'waiting', delivery: { mode: 'next' }, content: { userContent: { body: [{ type: 'paragraph', content: [{ type: 'text', text: queueText }] }] } } })
    const queuedA = await checkpoint('queue-a')
    const desktopDraft = `电脑 B 独立草稿 ${token}`
    await composer.fill(desktopDraft)
    for (const branch of ['A', 'B']) gates[`${branch}-initial`].resolve()
    const questions = branchId => page.evaluate(value => window.lexoraDesktop.localChat.questions.list(value), { conversationId, branchId })
    await expect.poll(() => questions(branchA), { timeout: 45000 }).toMatchObject([{ status: 'pending', branchId: branchA }])
    await expect.poll(() => questions(branchB), { timeout: 45000 }).toMatchObject([{ status: 'pending', branchId: branchB }])
    await signal('questions-ready')
    expect(await checkpoint('views-isolated')).toMatchObject({ recreated: true })
    await expect(branchView).toHaveAttribute('data-branch-id', branchB)
    await expect(composer).toHaveText(desktopDraft)
    await page.reload()
    await expect(branchView).toHaveAttribute('data-branch-id', branchB)
    await expect(composer).toHaveText(desktopDraft)
    await signal('answer-a')
    await checkpoint('answered-a')
    await expect.poll(() => requests.some(value => value.phase === 'result' && value.branch === 'A'), { timeout: 45000 }).toBe(true)
    await signal('stop-a')
    await checkpoint('stopped-a')
    expect(read(db => db.prepare('SELECT status FROM runs WHERE id = ?').get(runB).status)).toBe('running')
    expect((await questions(branchB))[0].status).toBe('pending')
    expect(read(db => db.prepare('SELECT state FROM chat_queue WHERE id = ?').get(queuedA.queueId).state)).toBe('paused')
    const queuedB = await page.evaluate(value => window.lexoraDesktop.localChat.chat.listQueue(value), { conversationId, branchId: branchB })
    expect(queuedB).toHaveLength(1)
    expect(queuedB[0]).toMatchObject({ id: queueB, branchId: branchB, state: 'waiting' })
    const questionB = (await questions(branchB))[0]
    await page.evaluate(value => window.lexoraDesktop.localChat.questions.answer(value), { conversationId, branchId: branchB, requestId: questionB.id, answers: [{ questionId: 'answer-B', selectedOptionIds: [], text: `分支 B 的回答 ${token}` }] })
    await expect.poll(() => requests.some(value => value.phase === 'result' && value.branch === 'B'), { timeout: 45000 }).toBe(true)
    await signal('edit-a')
    const edited = await checkpoint('edited-a')
    expect(edited.branchId).not.toBe(branchA)
    expect(edited.branchId).not.toBe(branchB)
    expect(read(db => db.prepare('SELECT status FROM runs WHERE id = ?').get(runB).status)).toBe('running')
    expect(read(db => db.prepare(`SELECT id, content_json FROM messages WHERE id IN (${originalRecords.map(() => '?').join(',')}) ORDER BY rowid`).all(...originalRecords.map(value => value.id)))).toEqual(originalRecords)
    await expect(branchView).toHaveAttribute('data-branch-id', branchB)
    await expect(composer).toHaveText(desktopDraft)
    await signal('restore-a')
    expect(await checkpoint('reconnected-a')).toMatchObject({ draft: `手机 A 独立草稿😀 ${token}` })
    await page.reload()
    await expect(branchView).toHaveAttribute('data-branch-id', branchB)
    await expect(composer).toHaveText(desktopDraft)
    gates['B-result'].resolve()
    await expect.poll(() => read(db => db.prepare('SELECT status FROM runs WHERE id = ?').get(runB).status)).toBe('completed')
    await expect.poll(() => requests.some(value => value.phase === 'queue' && value.branch === 'B')).toBe(true)
    await expect.poll(() => read(db => db.prepare('SELECT COUNT(*) AS count FROM runs WHERE branch_id = ? AND status IN (\'running\',\'queued\')').get(branchB).count)).toBe(0)
    await signal('b-finished')
    const done = await checkpoint('done')
    const result = await instrument
    await fs.writeFile(testInfo.outputPath('android-instrumentation.txt'), result.result?.stdout ?? String(result.error))
    expect(result.error).toBeUndefined()
    expect(result.result.stdout).toMatch(/OK \(1 test\)/)
    expect(result.result.stdout).not.toMatch(/INSTRUMENTATION_STATUS_CODE: -[234]|FAILURES/)
    const evidence = JSON.parse((await adb('shell', 'run-as', appPackage, 'cat', marker('done'))).stdout)
    expect(evidence).toMatchObject({ ...done, originalIdentityRestored: true, independentDrafts: true, noGlobalActivation: true, landscapeImeVisible: true })
    const text = branch => read(db => db.prepare('SELECT content_json FROM messages WHERE branch_id = ? ORDER BY rowid').all(branch)).map(value => value.content_json).join('\n')
    expect(text(branchA)).not.toContain('B 并行')
    expect(text(branchB)).not.toContain('A 并行')
    expect(text(edited.branchId)).not.toContain('B 并行')
    expect(read(db => db.prepare('SELECT active_branch_id FROM conversations WHERE id = ?').get(conversationId).active_branch_id)).toBe(branchA)
    expect((await questions(branchA))[0]).toMatchObject({ status: 'answered', response: { answers: [{ text: `分支 A 的回答 ${token}` }] } })
    expect((await questions(branchB))[0]).toMatchObject({ status: 'answered', response: { answers: [{ text: `分支 B 的回答 ${token}` }] } })
    await fs.writeFile(testInfo.outputPath('branch-evidence.json'), JSON.stringify({ ...evidence, concurrent, queueA: queuedA.queueId, queueB, runB, edited, simultaneousProviderRequests: true, desktopBranchRestored: branchB, syntheticProvider: true, coreAdapter: serviceMode }, null, 2))
    await page.screenshot({ path: testInfo.outputPath('desktop-branch-b.png') })
  }
  finally {
    for (const stage of ['isolated', 'restored', 'landscape-ime']) {
      const file = `files/branches-${token}-${stage}.png`
      files.add(file)
      const image = await bytes('exec-out', 'run-as', appPackage, 'cat', file).catch(() => null)
      if (image?.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        await fs.writeFile(testInfo.outputPath(`android-${stage}.png`), image)
    }
    const touchFile = `files/branches-${token}-landscape-touch.json`
    files.add(touchFile)
    const touch = await adb('shell', 'run-as', appPackage, 'cat', touchFile).then(result => JSON.parse(result.stdout)).catch(() => null)
    if (touch)
      await fs.writeFile(testInfo.outputPath('android-landscape-touch.json'), JSON.stringify(touch, null, 2))
    await restorePhone().catch(error => cleanupFailures.push(error))
    const result = await instrument
    if (result)
      await fs.writeFile(testInfo.outputPath('android-instrumentation.txt'), result.result?.stdout ?? String(result.error))
    for (const gate of Object.values(gates)) gate.resolve()
    provider.closeAllConnections()
    const cleanup = await Promise.allSettled([
      adb('shell', 'rm', '-f', remoteConfig),
      adb('shell', 'run-as', appPackage, 'rm', '-f', ...files),
      fs.rm(configuration, { force: true }),
      new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve())),
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
    cleanupFailures.push(...cleanup.filter(value => value.status === 'rejected').map(value => value.reason))
  }
  if (cleanupFailures.length)
    throw new AggregateError(cleanupFailures, 'Could not restore the isolated mobile branches test')
})
