import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createServer as createProvider } from 'node:http'
import { createServer } from 'node:net'
import process from 'node:process'
import { promisify } from 'node:util'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'
import { prepareMobileDesktopProfile } from '../fixtures/mobile-desktop.mjs'

const execute = promisify(execFile)
const serial = process.env.LEXORA_TEST_ANDROID_SERIAL
const serviceMode = process.env.LEXORA_TEST_MOBILE_SERVICE_MODE ?? 'utility'
const bindAddress = process.env.LEXORA_TEST_MOBILE_BIND_ADDRESS ?? '127.0.0.1'
const useAdbReverse = bindAddress === '127.0.0.1'

test('Android switches between two real computers without mixing credentials, scopes or local input', async ({ buddy }, testInfo) => {
  test.skip(!serial, 'Requires an Android device with the debug and instrumentation APKs installed')
  test.setTimeout(360000)
  const adb = (...args) => execute(process.env.ADB ?? 'adb', ['-s', serial, ...args], { timeout: 300000, maxBuffer: 8 * 1024 * 1024 })
  const bytes = async (...args) => (await execute(process.env.ADB ?? 'adb', ['-s', serial, ...args], { timeout: 15000, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })).stdout
  const token = randomUUID()
  const appPackage = 'app.uselexora.mobile.dev'
  const remoteConfig = `/data/local/tmp/lexora-devices-${token}.json`
  const resultFile = `files/devices-${token}.json`
  const configuration = testInfo.outputPath('pairing.json')
  const computers = []
  const captures = ['computer-switch', 'workbench', 'spaces', 'unassigned', 'space-tasks', 'new-space-task', 'conversation', 'restored-second-input']
  const identityBackup = `no_backup/device-switch-${token}-identity`
  const requests = []
  const provider = createProvider((request, response) => {
    void (async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const common = { id: `devices-${requests.length}`, model: 'fixture-model', object: 'chat.completion.chunk', created: 1 }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: '空间验收回复：已收到这台电脑的任务。' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })().catch(() => response.destroy())
  })
  const cleanupFailures = []
  let instrumentStarted = false
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
      const cleanup = await adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.uselexora.mobile.DeviceSwitchInstrumentedTest', '-e', 'deviceSwitchToken', token, '-e', 'deviceSwitchRestoreOnly', 'true', `${appPackage}.test/androidx.test.runner.AndroidJUnitRunner`)
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
  try {
    provider.listen(0, '127.0.0.1')
    await once(provider, 'listening')
    for (const label of ['first', 'second']) {
      const instance = await buddy.createInstance(`mobile-devices-${label}`)
      await prepareMobileDesktopProfile(instance.home, testInfo.outputPath(`profile-preparation-${label}`))
      const desktop = await instance.launch({ storageAuthority: 'sqlite', serviceMode })
      await useSyntheticCredentialStorage(desktop)
      const computer = { label, desktop, reversed: false }
      computers.push(computer)
      const display = label === 'first' ? 'A' : 'B'
      const spaceName = `验收空间 ${display}`
      const space = await desktop.page.evaluate(name => window.lexoraDesktop.localChat.spaces.create({ name, memoryScope: 'space_only', primaryDirectory: null }), spaceName)
      await desktop.page.evaluate(async (baseUrl) => {
        await window.lexoraDesktop.settings.update({ runtime: { codemode: 'off', modelRetryLimit: 0 } })
        const providers = window.lexoraDesktop.localChat.providers
        await providers.upsertCustom({ id: 'devices-fixture', displayName: 'Devices verification', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'fixture-model', name: 'Devices verification', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
        const stop = providers.onAuthChallenge((challenge) => {
          if (challenge.providerId === 'devices-fixture' && challenge.type === 'secret')
            void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
        })
        try {
          await providers.login('devices-fixture', 'api_key')
        }
        finally { stop() }
        await providers.setDefaultModel({ providerId: 'devices-fixture', modelId: 'fixture-model', reasoning: null })
      }, `http://127.0.0.1:${provider.address().port}/v1`)
      computer.tasks = []
      for (const assigned of [true, false]) {
        const title = `电脑 ${display} ${assigned ? '空间任务' : '未分配任务'}`
        const task = await desktop.page.evaluate(async ({ spaceId, title }) => {
          const api = window.lexoraDesktop.localChat
          const draftId = crypto.randomUUID()
          const draft = await api.composerDrafts.open({ draftId, scope: { kind: 'task', draftId, spaceId }, initialContent: { version: 1, body: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }], panelResourceIds: [] }, initialModelSelection: null, initialExecutionConfig: { executionProfile: 'read_only', approvalPolicy: 'policy' } })
          const turn = await api.chat.startTurn({ draftId, expectedRevision: draft.revision, requestId: crypto.randomUUID() })
          return { conversationId: turn.conversationId, branchId: turn.branchId, runId: turn.runId }
        }, { spaceId: assigned ? space.id : null, title })
        await expect.poll(() => desktop.page.evaluate(id => window.lexoraDesktop.localChat.runs.get(id), task.runId), { timeout: 30000 }).toMatchObject({ status: 'completed' })
        await desktop.page.evaluate(async ({ id, title }) => {
          const api = window.lexoraDesktop.localChat.conversations
          const current = await api.get(id)
          return api.rename(id, title, current.titleRevision)
        }, { id: task.conversationId, title })
        computer.tasks.push({ ...task, title, assigned })
      }
      const listener = createServer()
      await new Promise(resolve => listener.listen(0, bindAddress, resolve))
      computer.port = listener.address().port
      await new Promise(resolve => listener.close(resolve))
      await desktop.page.evaluate(({ bindAddress, port }) => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: true, bindAddress, port }), { bindAddress, port: computer.port })
      computer.spaceId = space.id
      computer.spaceName = spaceName
      if (useAdbReverse) {
        await adb('reverse', `tcp:${computer.port}`, `tcp:${computer.port}`)
        computer.reversed = true
      }
    }
    const config = {}
    for (const computer of computers) {
      const pairing = await computer.desktop.page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.issuePairing({}))
      config[computer.label] = { pairing, spaceId: computer.spaceId, spaceName: computer.spaceName, assignedTitle: computer.tasks.find(task => task.assigned).title, unassignedTitle: computer.tasks.find(task => !task.assigned).title }
    }
    expect(config.first.pairing.serviceId).not.toBe(config.second.pairing.serviceId)
    expect(config.first.pairing.profileId).not.toBe(config.second.pairing.profileId)
    await fs.writeFile(configuration, JSON.stringify(config), { mode: 0o600 })
    await adb('push', configuration, remoteConfig)
    await fs.rm(configuration)
    instrumentStarted = true
    const outcome = await adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.uselexora.mobile.DeviceSwitchInstrumentedTest', '-e', 'deviceSwitchToken', token, `${appPackage}.test/androidx.test.runner.AndroidJUnitRunner`)
    await fs.writeFile(testInfo.outputPath('android-instrumentation.txt'), outcome.stdout + outcome.stderr)
    expect(outcome.stdout).toMatch(/OK \(1 test\)/)
    expect(outcome.stdout).not.toMatch(/INSTRUMENTATION_STATUS_CODE: -[234]|FAILURES/)
    const checkpoint = JSON.parse((await adb('shell', 'run-as', appPackage, 'cat', resultFile)).stdout)
    expect(checkpoint).toMatchObject({ deviceCount: 2, separateScopes: true, localDraftIsolation: true, staleIdentityRejected: true, previousConnectionClosed: true, forgotSelectedWithoutFallback: true, remainingDeviceReconnects: true, originalIdentityRestored: true, ui: { topBarDeviceSwitch: true, spaceNavigation: true, allAndUnassignedFilters: true, newTaskInheritsSpace: true, localInputIsolation: true, inputSurvivesRecreation: true } })
    expect(new Set(checkpoint.partitions).size).toBe(2)
    expect(checkpoint.firstServiceId).toBe(config.first.pairing.serviceId)
    expect(checkpoint.secondServiceId).toBe(config.second.pairing.serviceId)
    expect(await computers[0].desktop.page.evaluate(id => window.lexoraDesktop.localChat.conversations.get(id), checkpoint.ui.createdConversationId)).toMatchObject({ spaceId: config.first.spaceId })
    expect(await computers[1].desktop.page.evaluate(() => window.lexoraDesktop.localChat.conversations.list())).toHaveLength(2)
    const userInputs = JSON.stringify(requests.flatMap(request => request.messages.filter(message => message.role === 'user')))
    expect(userInputs).toContain(`服务 A 空间草稿😀 ${token}`)
    expect(userInputs).not.toContain(`服务 B 空间草稿😀 ${token}`)
    for (const computer of computers) {
      const devices = await computer.desktop.page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.devices({}))
      expect(devices.filter(device => device.state === 'active').map(device => device.deviceId)).toEqual([checkpoint[`${computer.label}DeviceId`]])
      await computer.desktop.page.screenshot({ path: testInfo.outputPath(`desktop-${computer.label}.png`) })
    }
    await fs.writeFile(testInfo.outputPath('devices.json'), JSON.stringify({ ...checkpoint, coreAdapter: serviceMode, transport: useAdbReverse ? 'adb-reverse' : 'private-network', syntheticProvider: true, productDataFromCore: true }, null, 2))
  }
  finally {
    for (const capture of captures) {
      const image = await bytes('exec-out', 'run-as', appPackage, 'cat', `files/devices-${token}-${capture}.png`).catch(() => null)
      if (image)
        await fs.writeFile(testInfo.outputPath(`android-${capture}.png`), image)
    }
    await restorePhone().catch(error => cleanupFailures.push(error))
    const cleanup = await Promise.allSettled([
      adb('shell', 'rm', '-f', remoteConfig),
      adb('shell', 'run-as', appPackage, 'rm', '-f', resultFile, ...captures.map(capture => `files/devices-${token}-${capture}.png`)),
      fs.rm(configuration, { force: true }),
      (async () => {
        provider.closeAllConnections()
        await new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve()))
      })(),
      ...computers.map(async (computer) => {
        try {
          for (const device of await computer.desktop.page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.devices({}))) {
            if (device.state === 'active')
              await computer.desktop.page.evaluate(deviceId => window.lexoraDesktop.localChat.privateNetwork.revoke({ deviceId }), device.deviceId)
          }
          await computer.desktop.page.evaluate(() => window.lexoraDesktop.localChat.privateNetwork.configure({ enabled: false }))
        }
        finally {
          if (computer.reversed)
            await adb('reverse', '--remove', `tcp:${computer.port}`)
        }
      }),
    ])
    cleanupFailures.push(...cleanup.filter(result => result.status === 'rejected').map(result => result.reason))
  }
  if (cleanupFailures.length)
    throw new AggregateError(cleanupFailures, 'Could not clean up the isolated mobile device-switch test')
})
