import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer } from 'node:net'
import process from 'node:process'
import { promisify } from 'node:util'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'
import { prepareMobileDesktopProfile } from '../fixtures/mobile-desktop.mjs'

const execute = promisify(execFile)
const serial = process.env.LEXORA_TEST_ANDROID_SERIAL
const serviceMode = process.env.LEXORA_TEST_MOBILE_SERVICE_MODE ?? 'utility'

test('Legacy local Android content remains intact and read only while unsupported actions remain blocked', async ({ buddy }, testInfo) => {
  test.skip(!serial, 'Requires an isolated Android device with debug and instrumentation APKs')
  test.setTimeout(180000)
  const adb = (...args) => execute(process.env.ADB ?? 'adb', ['-s', serial, ...args], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  const token = randomUUID()
  const appPackage = 'app.uselexora.mobile.dev'
  const remoteConfig = `/data/local/tmp/lexora-content-${token}.json`
  const configuration = testInfo.outputPath('pairing.json')
  const instance = await buddy.createInstance('mobile-content')
  await prepareMobileDesktopProfile(instance.home, testInfo.outputPath('profile-preparation'))
  const desktop = await instance.launch({ storageAuthority: 'sqlite', serviceMode })
  const { page } = desktop
  const editor = page.locator('.desktop-workbench-area__tasks .tiptap:visible').first()
  await expect(editor).toBeVisible()
  await useSyntheticCredentialStorage(desktop)
  await expect(editor).toBeVisible()
  const original = '跨端中文😀e\u0301'
  await editor.fill(original)
  const getDraft = () => page.evaluate(async text => (await window.lexoraDesktop.localChat.composerDrafts.list()).find(draft => JSON.stringify(draft.content).includes(text)), original)
  await expect.poll(getDraft).toBeTruthy()
  const draft = await getDraft()
  const content = {
    version: 1,
    body: [{ type: 'paragraph', content: [
      { type: 'text', text: original },
      { type: 'hard_break' },
      { type: 'actor_ref', actorId: 'fixture-reader', name: '阅读者' },
      { type: 'quote_ref', quoteKind: 'message', quoteId: 'frozen-quote' },
      { type: 'session_ref', sessionId: 'historical-session' },
      { type: 'prompt_directive', directive: 'slash_command', commandMode: 'prompt', value: '/review' },
    ] }],
    panelResourceIds: [],
    quotes: [{ id: 'frozen-quote', text: '引用原文😀', textOffset: 2, source: { conversationId: 'archived-task', branchId: 'archived-branch', messageId: 'archived-reply', role: 'assistant', runId: null } }],
    sessionReferences: [{ id: 'historical-session', title: '原来的任务' }],
  }
  const saved = await page.evaluate(({ draft, content }) => window.lexoraDesktop.localChat.composerDrafts.save({ draftId: draft.draftId, expectedRevision: draft.revision, content, modelSelection: draft.modelSelection, executionConfig: draft.executionConfig, participants: draft.participants ?? null }), { draft, content })
  const large = await page.evaluate(async (executionConfig) => {
    const id = crypto.randomUUID()
    return window.lexoraDesktop.localChat.composerDrafts.open({ draftId: id, scope: { kind: 'task', draftId: id, spaceId: null }, initialContent: { version: 1, body: [{ type: 'paragraph', content: [{ type: 'text', text: '大段内容'.repeat(30000) }] }], panelResourceIds: [] }, initialModelSelection: null, initialExecutionConfig: executionConfig })
  }, draft.executionConfig)
  const listener = createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  let reversed = false
  let instrument
  try {
    await page.evaluate(port => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: true, bindAddress: '127.0.0.1', port }), port)
    const pairing = await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.issuePairing({}))
    await fs.writeFile(configuration, JSON.stringify({ pairing, draftId: draft.draftId, largeDraftId: large.draftId }), { mode: 0o600 })
    await adb('reverse', `tcp:${port}`, `tcp:${port}`)
    reversed = true
    await adb('push', configuration, remoteConfig)
    await fs.rm(configuration)
    instrument = adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.uselexora.mobile.ContentInstrumentedTest', '-e', 'contentWorkflowToken', token, `${appPackage}.test/androidx.test.runner.AndroidJUnitRunner`).then(result => ({ result }), error => ({ error }))
    const outcome = await instrument
    await fs.writeFile(testInfo.outputPath('android-instrumentation.txt'), outcome.result?.stdout ?? String(outcome.error))
    expect(outcome.error).toBeUndefined()
    expect(outcome.result.stdout).toMatch(/OK \(1 test\)/)
    expect(outcome.result.stdout).not.toMatch(/INSTRUMENTATION_STATUS_CODE: -[234]|FAILURES/)
    const result = JSON.parse((await adb('shell', 'run-as', appPackage, 'cat', `files/content-${token}-result.json`)).stdout)
    expect(result).toMatchObject({ richInputReadOnly: true, unsupportedInputPreserved: true, forbiddenActionRejected: true, noImplicitSend: true })
    expect(result.content).toEqual(saved.content)
    expect((await page.evaluate(id => window.lexoraDesktop.localChat.composerDrafts.get(id), draft.draftId)).content).toEqual(saved.content)
    const screenshot = await execute(process.env.ADB ?? 'adb', ['-s', serial, 'exec-out', 'run-as', appPackage, 'cat', `files/content-${token}.png`], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })
    await fs.writeFile(testInfo.outputPath('android-content.png'), screenshot.stdout)
    await fs.writeFile(testInfo.outputPath('roundtrip.json'), JSON.stringify({ ...result, originalDesktopPreserved: true, coreAdapter: serviceMode }, null, 2))
  }
  finally {
    await adb('shell', 'am', 'force-stop', appPackage)
    const outcome = await instrument
    if (outcome)
      await fs.writeFile(testInfo.outputPath('android-instrumentation.txt'), outcome.result?.stdout ?? String(outcome.error))
    await adb('shell', 'rm', '-f', remoteConfig)
    await adb('shell', 'run-as', appPackage, 'rm', '-f', `files/content-${token}-result.json`, `files/content-${token}.png`)
    if (reversed)
      await adb('reverse', '--remove', `tcp:${port}`)
    await fs.rm(configuration, { force: true })
    for (const device of await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.devices({}))) {
      if (device.state === 'active')
        await page.evaluate(deviceId => window.lexoraDesktop.localChat.privateNetwork.revoke({ deviceId }), device.deviceId)
    }
    await page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: false }))
  }
})
