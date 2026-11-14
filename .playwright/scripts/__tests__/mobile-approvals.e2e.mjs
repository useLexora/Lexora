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
import { selectComposerPermission } from '../fixtures/model-controls.mjs'

const execute = promisify(execFile)
const serial = process.env.LEXORA_TEST_ANDROID_SERIAL
const serviceMode = process.env.LEXORA_TEST_MOBILE_SERVICE_MODE ?? 'utility'

test('Desktop and Android converge on approval winners, original receipts and cancelled runs', async ({ buddy }) => {
  test.skip(!serial, 'Requires an isolated Android device with the debug and instrumentation APKs installed')
  test.setTimeout(240000)
  const adb = (...args) => execute(process.env.ADB ?? 'adb', ['-s', serial, ...args], { timeout: 210000, maxBuffer: 8 * 1024 * 1024 })
  const token = randomUUID()
  const appPackage = 'app.uselexora.mobile.dev'
  const remoteConfig = `/data/local/tmp/lexora-approval-${token}.json`
  const configuration = test.info().outputPath('pairing.json')
  const requests = []
  const provider = createServer((request, response) => {
    void (async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push(body)
      const user = body.messages.findLastIndex(message => message.role === 'user')
      const phase = JSON.stringify(body.messages[user]?.content).match(/Approval competition (\d)/)?.[1] ?? '0'
      const write = !body.messages.slice(user + 1).some(message => message.role === 'tool')
      const delta = write
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `approval-write-${phase}`, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: `approval-${phase}.txt`, content: `Approved exactly once ${phase} 😀` }) } }] }
        : { role: 'assistant', content: `双端审批完成 ${phase}` }
      const common = { id: `approval-${requests.length}`, model: 'fixture-model', object: 'chat.completion.chunk', created: 1 }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: write ? 'tool_calls' : 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })().catch(() => response.destroy())
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const instance = await buddy.createInstance('mobile-approvals')
  await prepareMobileDesktopProfile(instance.home, test.info().outputPath('profile-preparation'))
  const desktop = await instance.launch({ storageAuthority: 'sqlite', serviceMode })
  await useSyntheticCredentialStorage(desktop)
  let { page } = desktop
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
  const files = [0, 1, 2, 3].flatMap(phase => ['ready', 'done', 'resume'].map(stage => `files/approval-${token}-${phase}-${stage}.json`))
  files.push(...['0', '2', 'final'].map(phase => `files/approval-${token}-${phase}.png`))
  const checkpoint = async (phase, stage) => {
    const file = `files/approval-${token}-${phase}-${stage}.json`
    files.push(file)
    let value
    await expect.poll(async () => {
      try {
        value = JSON.parse((await adb('shell', 'run-as', appPackage, 'cat', file)).stdout)
        return true
      }
      catch { return false }
    }, { timeout: 60000 }).toBe(true)
    return value
  }
  try {
    await page.evaluate(async (baseUrl) => {
      await window.lexoraDesktop.settings.update({ runtime: { codemode: 'off', modelRetryLimit: 0 } })
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'approval-fixture', displayName: 'Approval fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'fixture-model', name: 'Approval model', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'approval-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('approval-fixture', 'api_key')
      }
      finally { stop() }
      await providers.setDefaultModel({ providerId: 'approval-fixture', modelId: 'fixture-model', reasoning: null })
    }, `http://127.0.0.1:${provider.address().port}/v1`)
    await page.reload()
    await selectComposerPermission(page, '人工审批')
    await page.evaluate(port => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: true, bindAddress: '127.0.0.1', port }), port)
    await adb('reverse', `tcp:${port}`, `tcp:${port}`)
    const evidence = []
    for (let phase = 0; phase < 5; phase++) {
      await page.locator('.desktop-chat-composer__prosemirror:visible').fill(`Approval competition ${phase}`)
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      const card = page.locator('.desktop-approval-card').filter({ has: page.getByRole('button', { name: '允许一次', exact: true }) })
      await expect(card).toBeVisible({ timeout: 45000 })
      const pending = read(db => db.prepare('SELECT a.id, a.run_id, r.conversation_id FROM approvals a JOIN runs r ON a.run_id = r.id WHERE a.status = ?').get('pending'))
      if (phase === 0) {
        const pairing = await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.issuePairing({}))
        await fs.writeFile(configuration, JSON.stringify({ pairing, conversationId: pending.conversation_id, desktopLifecycle: serviceMode === 'daemon' }), { mode: 0o600 })
        await adb('push', configuration, remoteConfig)
        await fs.rm(configuration)
        instrument = adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.uselexora.mobile.DesktopApprovalInstrumentedTest', '-e', 'desktopApprovalToken', token, `${appPackage}.test/androidx.test.runner.AndroidJUnitRunner`).then(result => ({ result }), error => ({ error }))
      }
      const ready = await checkpoint(phase, 'ready')
      expect(ready.approvalId).toBe(pending.id)
      await page.screenshot({ path: test.info().outputPath(`desktop-pending-${phase}.png`) })
      if (phase === 0) {
        await card.getByRole('button', { name: '拒绝', exact: true }).click()
      }
      else if (phase === 1) {
        if (serviceMode === 'daemon') {
          await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { exitBehavior: 'keep_service' } }))
          const closed = page.waitForEvent('close')
          await page.evaluate(() => window.lexoraDesktop.commands.execute('app.quit'))
          await closed
          expect(desktop.app.process().exitCode).toBeNull()
          expect(desktop.app.context().pages().filter(candidate => candidate.url().startsWith('lexora-app:'))).toHaveLength(0)
        }
        const reopened = serviceMode === 'daemon' ? desktop.app.context().waitForEvent('page', { timeout: 60000 }) : null
        const resume = `files/approval-${token}-${phase}-resume.json`
        files.push(resume)
        await adb('shell', 'run-as', appPackage, 'touch', resume)
        if (reopened) {
          page = await reopened
          await expect.poll(() => page.evaluate(() => window.lexoraDesktop.app.startup.getState())).toMatchObject({ status: 'ready' })
          await expect(page.locator('.buddy-chat-message').filter({ hasText: '双端审批完成 1' })).toBeVisible()
        }
      }
      else if (phase === 2) {
        await page.getByRole('button', { name: '停止运行', exact: true }).click()
      }
      else if (phase === 3) {
        await page.evaluate(() => window.lexoraDesktop.localChat.runtime.restart())
        await expect.poll(async () => (await page.evaluate(() => window.lexoraDesktop.localChat.runtime.getStatus())).status, { timeout: 45000 }).toBe('ready')
        await adb('shell', 'run-as', appPackage, 'touch', `files/approval-${token}-${phase}-resume.json`)
      }
      else {
        const resume = `files/approval-${token}-${phase}-resume.json`
        files.push(resume)
        await adb('shell', 'run-as', appPackage, 'touch', resume)
      }
      const expected = ['denied', 'approved', 'cancelled', 'cancelled', 'denied'][phase]
      await expect.poll(() => read(db => db.prepare('SELECT status FROM approvals WHERE id = ?').get(pending.id).status)).toBe(expected)
      await expect(page.locator('.desktop-approval-card').getByRole('button', { name: '允许一次', exact: true })).toHaveCount(0)
      await expect.poll(() => read(db => db.prepare('SELECT status FROM runs WHERE id = ?').get(pending.run_id).status)).not.toMatch(/^(queued|running)$/)
      if (phase < 2 || phase === 4)
        await expect(page.locator('.buddy-chat-message').filter({ hasText: `双端审批完成 ${phase}` })).toBeVisible()
      const receipts = await checkpoint(phase, 'done')
      const decision = read(db => db.prepare('SELECT * FROM approval_decisions WHERE approval_id = ?').get(pending.id))
      expect(decision.resolution).toBe(phase === 2 || phase === 3 ? 'cancelled' : phase === 1 ? 'approved' : 'denied')
      expect(read(db => db.prepare('SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND event_type = \'approval.resolved\'').get(pending.run_id).count)).toBe(1)
      const review = JSON.parse(read(db => db.prepare('SELECT review_json FROM approval_reviews WHERE approval_id = ?').get(pending.id).review_json))
      const output = path.resolve(review.body.cwd, review.body.arguments.path)
      expect(output.startsWith(`${instance.home}${path.sep}`)).toBe(true)
      if (phase === 1) {
        expect(await fs.readFile(output, 'utf8')).toBe('Approved exactly once 1 😀')
        const rejected = await page.evaluate(async ({ approvalId, runId, reviewVersion }) => {
          try {
            await window.lexoraDesktop.localChat.approvals.deny(approvalId, { runId, reviewVersion })
            return null
          }
          catch (error) { return String(error) }
        }, { approvalId: pending.id, runId: pending.run_id, reviewVersion: review.reviewVersion })
        expect(rejected).toContain('APPROVAL_ALREADY_RESOLVED')
        expect(read(db => db.prepare('SELECT * FROM approval_decisions WHERE approval_id = ?').get(pending.id))).toEqual(decision)
        expect(decision.actor_id).not.toBe(read(db => db.prepare('SELECT local_actor_id FROM storage_profile WHERE id = 1').get().local_actor_id))
      }
      else {
        await expect(fs.stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      if (phase === 4) {
        expect(receipts[phase].receipt.decision).toBe('accepted')
        expect(decision.actor_id).not.toBe(read(db => db.prepare('SELECT local_actor_id FROM storage_profile WHERE id = 1').get().local_actor_id))
      }
      evidence.push({ phase, approvalId: pending.id, runId: pending.run_id, decision, receipt: receipts[phase].receipt })
    }
    if (serviceMode === 'daemon') {
      await checkpoint('final', 'ready')
      await page.screenshot({ path: test.info().outputPath('desktop-final.png') })
      await desktop.app.detachMain()
      await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { exitBehavior: 'stop_service' } }))
      const closed = page.waitForEvent('close')
      await page.evaluate(() => {
        void window.lexoraDesktop.commands.execute('app.quit')
      })
      await closed
      expect(await checkpoint('final', 'done')).toEqual({ disconnected: true, outboxUnchanged: true })
      await expect.poll(() => desktop.app.process().exitCode).toBe(0)
    }
    const outcome = await instrument
    await fs.writeFile(test.info().outputPath('android-instrumentation.txt'), outcome.result?.stdout ?? String(outcome.error))
    expect(outcome.error).toBeUndefined()
    expect(outcome.result.stdout).toMatch(/OK \(1 test\)/)
    expect(outcome.result.stdout).not.toMatch(/INSTRUMENTATION_STATUS_CODE: -[234]|FAILURES/)
    for (const phase of ['0', '2', 'final']) {
      const file = `files/approval-${token}-${phase}.png`
      files.push(file)
      const capture = await execute(process.env.ADB ?? 'adb', ['-s', serial, 'exec-out', 'run-as', appPackage, 'cat', file], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })
      await fs.writeFile(test.info().outputPath(`android-${phase}.png`), capture.stdout)
    }
    await fs.writeFile(test.info().outputPath('approval-evidence.json'), JSON.stringify({ evidence, modelRequests: requests.length, coreAdapter: serviceMode, syntheticProvider: true }, null, 2))
    if (!page.isClosed())
      await page.screenshot({ path: test.info().outputPath('desktop-final.png') })
  }
  finally {
    await adb('shell', 'am', 'force-stop', appPackage)
    const interrupted = await instrument
    if (interrupted)
      await fs.writeFile(test.info().outputPath('android-instrumentation.txt'), interrupted.result?.stdout ?? String(interrupted.error))
    await adb('shell', 'rm', '-f', remoteConfig)
    if (files.length)
      await adb('shell', 'run-as', appPackage, 'rm', '-f', ...files)
    await adb('reverse', '--remove', `tcp:${port}`)
    await fs.rm(configuration, { force: true })
    for (const device of page.isClosed() ? [] : await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.devices({}))) {
      if (device.state === 'active')
        await page.evaluate(deviceId => window.lexoraDesktop.localChat.privateNetwork.revoke({ deviceId }), device.deviceId)
    }
    if (!page.isClosed())
      await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: false }))
    provider.closeAllConnections()
    await new Promise(resolve => provider.close(resolve))
  }
})
