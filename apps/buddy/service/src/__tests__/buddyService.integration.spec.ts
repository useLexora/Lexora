import type { LocalAutomation, LocalAutomationOccurrencePage } from '@buddy-shared/automation/automationApi'
import type { LocalAttachment } from '@buddy-shared/conversation/attachmentApi'
import type { LocalTurnStart } from '@buddy-shared/conversation/chatApi'
import type { LocalContextUsageSnapshot } from '@buddy-shared/conversation/contextApi'
import type { LocalNotificationList } from '@buddy-shared/notifications/notificationApi'
import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { AssistantMessage, Credential, Usage } from '@earendil-works/pi-ai'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DatabaseSync } from 'node:sqlite'
import type { LocalBuddy } from '../../../shared/buddies/buddyApi'
import type { BuddyComposerResource } from '../../../shared/conversation/composerResource'

import type { ApplicationDiagnostic } from '../../../shared/diagnostics/applicationDiagnostic'
import type { StartBuddyServiceOptions } from '../BuddyService'
import type { BuddyServiceRpcServer } from '../rpc/BuddyServiceRpcServer'
import { Buffer } from 'node:buffer'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { ProductDesktopGateway } from '../../../electron/main/productProtocol/ProductDesktopGateway'
import { DEFAULT_BUDDY_SETTINGS } from '../../../shared/buddies/buddySettings'

import { createBuddyUserContent } from '../../../shared/conversation/buddyUserContent'
import { Emitter } from '../../../shared/events/Emitter'
import { DEFAULT_NETWORK_PERMISSIONS } from '../../../shared/permissions/networkPermissions'
import { DEFAULT_RUNTIME_PREFERENCES } from '../../../shared/runtime/runtimePreferences'
import { inspectCommittedPiCompaction } from '../agent/sessions/recovery/inspectCommittedPiCompaction'
import { readCheckpoint } from '../agent/sessions/tree/BuddyTreeStore'
import { startBuddyService as startService } from '../BuddyService'
import { createRunEventLog } from '../events/createRunEventLog'
import { SqliteRunEventLog } from '../events/SqliteRunEventLog'
import { createRpcRuntimePlatform } from '../platform/createRpcRuntimePlatform'
import { createServiceConnection } from '../rpc/__tests__/serviceConnectionHarness'
import { RunLifecycleService } from '../runs/RunLifecycleService'
import { RunRecoveryService } from '../runs/RunRecoveryService'
import {
  prepareTestCommandRequest,
  prepareTestTurnRequest,
} from '../storage/__tests__/composerDraftTestFixture'
import { createExecutionStorageFixture, executionNow } from '../storage/__tests__/executionFixture'
import { createApprovalRepository } from '../storage/approvalRepository'
import { createArtifactRepository } from '../storage/artifactRepository'
import { createAttachmentRepository } from '../storage/attachmentRepository'
import { createComposerDraftRepository } from '../storage/composerDraftRepository'
import { createConversationDeletionRepository } from '../storage/conversationDeletionRepository'
import { createConversationRepository } from '../storage/conversationRepository'
import { openBuddyDatabase, openBuddyMigrationCandidate } from '../storage/database'
import { createExecutionRepository } from '../storage/executionRepository'
import { createRunRepository } from '../storage/runRepository'
import { createSpaceRepository } from '../storage/spaceRepository'
import { createUsageRepository } from '../storage/usageRepository'
import { UsageService } from '../usage/UsageService'

const databases: DatabaseSync[] = []
const directories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer))
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('buddy runtime cross-subsystem contract', () => {
  it('cancels current execution when its platform disappears and only admits new intent after recovery', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-platform-loss-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({ conversationsDirectory: join(buddyHome, 'conversations'), database })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let requests = 0
    const provider = await startLocalModelProvider(async () => {
      if (++requests === 1) {
        entered.resolve()
        await release.promise
      }
      return { text: 'Explicit new intent completed' }
    })
    const harness = createRuntimeRpcHarness({ 'offline-provider': { type: 'api_key', key: 'test-api-key' } })
    const service = await startBuddyService({ buddyHome, database, eventLog, rpc: harness.rpc, builtinSkillsDirectories: [] })
    try {
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      const first = await service.runtime.startTurn(await turnRequest(harness, { content: 'First execution', requestId: 'before-platform-loss' }))
      await entered.promise
      await service.suspendPlatform()
      expect((await waitForTerminalRun(harness, first.runId)).status).toBe('cancelled')
      const fresh = await turnRequest(harness, { conversationId: first.conversationId, branchId: first.branchId, content: 'Explicit new intent', requestId: 'after-platform-loss' })
      await expect(service.runtime.startTurn(fresh)).rejects.toMatchObject({ code: 'PLATFORM_HOST_UNAVAILABLE' })
      expect(requests).toBe(1)
      release.resolve()
      await service.resumePlatform()
      expect(requests).toBe(1)
      const second = await service.runtime.startTurn(fresh)
      expect((await waitForTerminalRun(harness, second.runId)).status).toBe('completed')
      expect(requests).toBe(2)
      expect((await eventLog.read(first.runId)).filter(event => event.type === 'run.completed')).toEqual([])
    }
    finally {
      release.resolve()
      await service.dispose()
      await eventLog.close()
    }
  }, 30000)

  it('runs a candidate Core command through one SQLite writer and replays its receipt after disconnect', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-candidate-core-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const database = openBuddyMigrationCandidate({ databasePath: join(buddyHome, 'buddy.sqlite3') })
    databases.push(database)
    database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
    const eventLog = new SqliteRunEventLog({ database })
    const harness = createRuntimeRpcHarness({ 'offline-provider': { type: 'api_key', key: 'test-api-key' } })
    const provider = await startLocalModelProvider(async () => ({ text: 'CANDIDATE_COMMAND_COMPLETED' }))
    const service = await startBuddyService({ serviceInstanceId: 'candidate-instance', productIdentity: { serviceId: 'candidate-service', profileId: 'candidate-profile' }, buddyHome, database, eventLog, rpc: harness.rpc, builtinSkillsDirectories: [] })
    const product = createServiceConnection()
    const disconnect = service.connectClient('product', product.server)
    const productFrames: Array<Record<string, any>> = []
    product.client.onNotification((method, params) => {
      if (method === 'product.frame')
        productFrames.push(JSON.parse((params as { frame: string }).frame))
    })
    const exchange = async (method: string, params: unknown) => {
      const id = String(productFrames.length + 1)
      await product.client.request('product.exchange', { frame: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
      const frame = productFrames.find(frame => frame.id === id)!
      if (frame.error)
        throw new Error(JSON.stringify(frame.error))
      return frame.result
    }
    try {
      await expect(product.client.request('runtime.stop', {})).rejects.toMatchObject({ code: -32601 })
      const initialized = await exchange('initialize', { protocol: { major: 1, minMinor: 0, maxMinor: 0 }, client: { kind: 'desktop', version: 'test' }, supportedContentKinds: ['buddy-user-content-v1'], supportedReviewKinds: [] })
      expect(initialized.profileId).toBe('candidate-profile')
      expect(initialized.capabilities).toContain('composerDrafts.open')
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      const initialSync = await exchange('sync.subscribe', { subscriptionId: 'task-index', topic: 'taskIndex' })
      expect(initialSync).toMatchObject({ mode: 'snapshot', items: [] })
      const projected = await harness.invoke('product.content.project', { content: createBuddyUserContent('Use the committed candidate command') }) as { content: unknown }
      await exchange('composerDrafts.open', {
        commandId: 'candidate-open',
        dataGeneration: service.commands!.identity.dataGeneration,
        expectedServiceInstanceId: 'candidate-instance',
        intent: { draftId: 'candidate-draft', scope: { kind: 'global' }, expectedSlotRevision: '0', initialContent: projected.content, initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, initialModelSelection: { modelId: 'offline-model', providerId: 'offline-provider', reasoning: null, serviceTier: null } },
      })
      const draft = createComposerDraftRepository(database).findById('candidate-draft')!
      expect(await exchange('composerDrafts.get', { draftId: draft.draftId })).toMatchObject({ draftId: draft.draftId, revision: '0', content: { kind: 'editable' } })
      for (const method of ['chat.startTurn', 'composerDrafts.save', 'approvals.approve', 'conversations.rename'])
        await expect(harness.invoke(method, {})).rejects.toMatchObject({ code: 'METHOD_NOT_AVAILABLE' })
      const commands = service.commands!
      expect(commands.identity.serviceInstanceId).toBe('candidate-instance')
      const input = { commandId: 'candidate-command', dataGeneration: commands.identity.dataGeneration, expectedServiceInstanceId: commands.identity.serviceInstanceId, intent: { draftId: draft.draftId, expectedRevision: draft.revision } }
      const accepted = await exchange('chat.startTurn', { ...input, intent: { ...input.intent, expectedRevision: String(input.intent.expectedRevision) } })
      expect(await exchange('commands.get', { commandId: input.commandId, dataGeneration: input.dataGeneration })).toEqual({ lookup: 'decided', receipt: accepted.receipt })
      const runId = String((accepted.receipt as unknown as { target: { runId: string } }).target.runId)
      const task = await exchange('conversations.get', { conversationId: accepted.receipt.target.conversationId })
      expect(typeof task.revision).toBe('string')
      expect(task).not.toHaveProperty('metadataRevision')
      expect(productFrames.some(frame => frame.method === 'sync.delta' && frame.params.changes[0]?.kind === 'upsert')).toBe(true)
      disconnect()
      product.close()
      expect(await waitForTerminalRun(harness, runId)).toMatchObject({ status: 'completed' })
      expect(await commands.input.execute('chat.startTurn', input)).toMatchObject({ created: false, receipt: { target: accepted.receipt.target } })
      const events = await eventLog.read(runId)
      expect(events[0]?.type).toBe('run.queued')
      expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1))
      expect(JSON.stringify(events)).toContain('CANDIDATE_COMMAND_COMPLETED')
      expect(provider.requests).toHaveLength(1)
      expect(database.prepare('SELECT count(*) AS count FROM command_receipts').get()).toEqual({ count: 2 })
    }
    finally {
      product.close()
      await service.dispose()
      await eventLog.close()
    }
  })

  it('accepts immutable local input on its explicit branch and preserves deletion rejections', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-submitted-input-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const database = openBuddyMigrationCandidate({ databasePath: join(buddyHome, 'buddy.sqlite3') })
    databases.push(database)
    database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
    const eventLog = new SqliteRunEventLog({ database })
    const harness = createRuntimeRpcHarness({ 'offline-provider': { type: 'api_key', key: 'test-api-key' } })
    const provider = await startLocalModelProvider(async () => ({ text: 'LOCAL_INPUT_COMPLETED' }))
    const service = await startBuddyService({ serviceInstanceId: 'input-instance', productIdentity: { serviceId: 'input-service', profileId: 'input-profile' }, buddyHome, database, eventLog, rpc: harness.rpc, builtinSkillsDirectories: [] })
    try {
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      const commands = service.commands!
      const snapshot = { inputId: 'local-input', scope: { kind: 'task', draftId: 'local-input', spaceId: null }, content: createBuddyUserContent('Local immutable input 😀'), executionConfig: { approvalPolicy: 'policy', executionProfile: 'read_only' }, modelSelection: { modelId: 'offline-model', providerId: 'offline-provider', reasoning: null, serviceTier: null }, participants: { leaderId: 'default', actorIds: ['default'] } }
      const input = { commandId: 'submit-local', dataGeneration: commands.identity.dataGeneration, expectedServiceInstanceId: commands.identity.serviceInstanceId, intent: { operation: 'start', input: snapshot } }
      const accepted = await commands.input.execute('chat.submitInput', input)
      expect(accepted.receipt.decision).toBe('accepted')
      const target = accepted.receipt.target as { runId: string, conversationId: string, branchId: string }
      expect(await waitForTerminalRun(harness, target.runId)).toMatchObject({ status: 'completed' })
      expect(database.prepare('SELECT count(*) AS count FROM composer_drafts').get()).toEqual({ count: 0 })
      expect(database.prepare('SELECT draft_id, draft_revision FROM turn_requests WHERE run_id = ?').get(target.runId)).toEqual({ draft_id: null, draft_revision: null })
      expect(provider.requests).toHaveLength(1)
      expect(JSON.stringify(provider.requests)).toContain('Local immutable input')
      expect(await commands.input.execute('chat.submitInput', { ...input, expectedServiceInstanceId: 'previous-instance' })).toEqual({ created: false, receipt: accepted.receipt })
      await expect(commands.input.execute('chat.submitInput', { ...input, intent: { ...input.intent, input: { ...snapshot, content: createBuddyUserContent('Changed intent') } } })).rejects.toMatchObject({ code: 'COMMAND_ID_REUSED' })
      const conversations = createConversationRepository(database)
      conversations.createBranch({ id: 'other-branch', conversationId: target.conversationId, parentBranchId: target.branchId, forkedFromMessageId: conversations.listBranchMessages(target.conversationId, target.branchId)[0]!.id, createdAt: new Date().toISOString(), activate: true })
      const continued = { ...input, commandId: 'continue-local', intent: { operation: 'start', input: { ...snapshot, inputId: 'continue-input', scope: { kind: 'conversation_branch', conversationId: target.conversationId, branchId: target.branchId } } } }
      const continuedResult = await commands.input.execute('chat.submitInput', continued)
      expect(continuedResult.receipt).toMatchObject({ decision: 'accepted', target: { conversationId: target.conversationId, branchId: target.branchId } })
      expect(await waitForTerminalRun(harness, String(continuedResult.receipt.target.runId))).toMatchObject({ status: 'completed', branchId: target.branchId })
      expect(conversations.findById(target.conversationId)?.activeBranchId).toBe('other-branch')
      expect(provider.requests).toHaveLength(2)
      conversations.markDeleted(target.conversationId, new Date().toISOString())
      const stale = { ...continued, commandId: 'deleted-local', intent: { ...continued.intent, input: { ...continued.intent.input, inputId: 'deleted-input' } } }
      const rejected = await commands.input.execute('chat.submitInput', stale)
      expect(rejected.receipt).toMatchObject({ decision: 'rejected', errorCode: 'SOURCE_CHANGED' })
      database.prepare('UPDATE conversations SET deleted_at = NULL WHERE id = ?').run(target.conversationId)
      expect(await commands.input.execute('chat.submitInput', stale)).toEqual({ created: false, receipt: rejected.receipt })
      expect(provider.requests).toHaveLength(2)
    }
    finally {
      await service.dispose()
      await eventLog.close()
    }
  })

  it('adapts Desktop drafts and task receipts through the product connection without repeating execution', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-desktop-product-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const database = openBuddyMigrationCandidate({ databasePath: join(buddyHome, 'buddy.sqlite3') })
    databases.push(database)
    database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
    const eventLog = new SqliteRunEventLog({ database })
    const harness = createRuntimeRpcHarness({ 'offline-provider': { type: 'api_key', key: 'test-api-key' } })
    const provider = await startLocalModelProvider(async () => ({ text: 'DESKTOP_PRODUCT_COMPLETED' }))
    const service = await startBuddyService({ serviceInstanceId: 'desktop-instance', productIdentity: { serviceId: 'desktop-service', profileId: 'desktop-profile' }, buddyHome, database, eventLog, rpc: harness.rpc, builtinSkillsDirectories: [] })
    const product = createServiceConnection()
    service.connectClient('product', product.server)
    const gateway = new ProductDesktopGateway({
      state: { status: 'ready' },
      onNotification: listener => product.client.onNotification((method, params) => listener({ method, params })),
      onStateChange: () => () => {},
      restart: async () => {},
      request: (method, params) => method === 'product.exchange' ? product.client.request(method, params) : harness.invoke(method, params),
    }, join(root, 'outbox'), 'test')
    try {
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      const opened = await gateway.request('composerDrafts.open', {
        draftId: 'desktop-draft',
        scope: { kind: 'global' },
        initialContent: createBuddyUserContent('Original input'),
        initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
        initialModelSelection: { modelId: 'offline-model', providerId: 'offline-provider', reasoning: null, serviceTier: null },
      }) as { draftId: string, revision: number }
      expect(opened).toMatchObject({ draftId: 'desktop-draft', revision: 0 })
      const draft = await gateway.request('composerDrafts.save', { draftId: opened.draftId, expectedRevision: 0, content: createBuddyUserContent('Desktop committed input'), modelSelection: { modelId: 'offline-model', providerId: 'offline-provider', reasoning: null, serviceTier: null }, executionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' } }) as { draftId: string, revision: number }
      expect(draft.revision).toBe(1)
      const input = { draftId: draft.draftId, expectedRevision: draft.revision, requestId: 'desktop-start' }
      const turn = await gateway.request('chat.startTurn', input) as LocalTurnStart
      expect(turn).toMatchObject({ runId: expect.any(String), draftReceipt: { sourceRevision: 1, committedRevision: 2 }, userMessage: { id: expect.any(String), role: 'user' } })
      expect(turn.userMessage?.id).toBe(turn.run.triggeringMessageId)
      expect(await waitForTerminalRun(harness, turn.runId)).toMatchObject({ status: 'completed' })
      expect(await gateway.request('chat.startTurn', input)).toMatchObject({ runId: turn.runId, userMessage: { id: turn.userMessage!.id } })
      expect(provider.requests).toHaveLength(1)
      const renamed = await gateway.request('conversations.rename', { conversationId: turn.conversationId, expectedTitleRevision: 0, title: 'Renamed via product' }) as { title: string }
      expect(renamed.title).toBe('Renamed via product')
      await expect(gateway.request('conversations.rename', { conversationId: turn.conversationId, expectedTitleRevision: 0, title: 'Stale title' })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
      const recovery = await gateway.recover()
      expect(recovery).toMatchObject([{ state: 'rejected', method: 'conversations.rename', canRestore: false }])
      await gateway.acknowledgeRecovery(recovery[0]!.id)
      expect(await gateway.recover()).toEqual([])
      await expect(gateway.request('composerDrafts.save', { draftId: draft.draftId, expectedRevision: 0, content: createBuddyUserContent('Recovered local input'), executionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, modelSelection: null })).rejects.toMatchObject({ code: 'DRAFT_CONFLICT' })
      const [recoverable] = await gateway.recover()
      expect(recoverable).toMatchObject({ state: 'rejected', canRestore: true })
      const restoredId = await gateway.restoreRecovery(recoverable!.id)
      expect(createComposerDraftRepository(database).findById(restoredId)?.content.body).toEqual(createBuddyUserContent('Recovered local input').body)
      expect(await gateway.recover()).toEqual([])
    }
    finally {
      gateway.dispose()
      product.close()
      await service.dispose()
      await eventLog.close()
    }
  })

  it('keeps an accepted run alive across product disconnection and exposes it to a new client', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-client-lifetime-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({ database, conversationsDirectory: join(buddyHome, 'conversations') })
    const harness = createRuntimeRpcHarness({ 'offline-provider': { type: 'api_key', key: 'test-api-key' } })
    const response = Promise.withResolvers<void>()
    const provider = await startLocalModelProvider(async () => {
      await response.promise
      return { text: 'ACCEPTED_RUN_SURVIVED_CLIENT_DISCONNECT' }
    })
    const service = await startBuddyService({ buddyHome, database, eventLog, rpc: harness.rpc, builtinSkillsDirectories: [] })
    const first = createServiceConnection()
    const reconnected = createServiceConnection()
    service.connectClient('product', first.server)
    try {
      await expect(first.client.request('providers.upsertCustom', {})).rejects.toMatchObject({ code: -32601 })
      await expect(first.client.request('runtime.shutdown', {})).rejects.toMatchObject({ code: -32601 })
      await expect(first.client.request('attachments.resolvePreview', {})).rejects.toMatchObject({ code: -32601 })
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      const input = await turnRequest(harness, { content: 'Keep the accepted task running', requestId: 'client-lifetime' })
      const turn = await first.client.request('chat.startTurn', input) as LocalTurnStart
      await expect.poll(() => provider.requests.length).toBe(1)
      first.close()
      expect(createRunRepository(database).findById(turn.runId)?.status).toBe('running')
      service.connectClient('product', reconnected.server)
      await expect(reconnected.client.request('runs.get', { runId: turn.runId })).resolves.toMatchObject({ status: 'running' })
      response.resolve()
      expect(await waitForTerminalRun(harness, turn.runId)).toMatchObject({ status: 'completed' })
      await expect(reconnected.client.request('runs.get', { runId: turn.runId })).resolves.toMatchObject({ status: 'completed' })
      expect(JSON.stringify(await eventLog.read(turn.runId))).toContain('ACCEPTED_RUN_SURVIVED_CLIENT_DISCONNECT')
      expect(provider.requests).toHaveLength(1)
    }
    finally {
      response.resolve()
      first.close()
      reconnected.close()
      await service.dispose()
      await eventLog.close()
    }
  })

  it('preserves task admission and running work until an idle backup can close admission', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-idle-backup-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({ database, conversationsDirectory: join(buddyHome, 'conversations') })
    const harness = createRuntimeRpcHarness({ 'offline-provider': { type: 'api_key', key: 'test-api-key' } })
    const response = Promise.withResolvers<void>()
    const provider = await startLocalModelProvider(async () => {
      await response.promise
      return { text: 'TASK_PRESERVED_DURING_BACKUP_CHECK' }
    })
    const service = await startBuddyService({ buddyHome, database, eventLog, rpc: harness.rpc, builtinSkillsDirectories: [] })
    try {
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      const input = await turnRequest(harness, { content: 'Complete this task before backing up', requestId: 'backup-race' })
      const starting = harness.invoke('chat.startTurn', input)
      expect(createRunRepository(database).listIncomplete()).toEqual([])
      expect(service.prepareIdleShutdown()).toBe(false)
      expect(await harness.invoke('runs.isBusy', {})).toBe(true)
      const turn = await starting as LocalTurnStart
      await expect.poll(() => provider.requests.length).toBe(1)
      expect(service.prepareIdleShutdown()).toBe(false)
      expect(await harness.invoke('runs.get', { runId: turn.runId })).toMatchObject({ status: 'running' })
      response.resolve()
      expect(await waitForTerminalRun(harness, turn.runId)).toMatchObject({ status: 'completed' })
      await expect.poll(() => harness.invoke('runs.isBusy', {})).toBe(false)
      expect(JSON.stringify(await eventLog.read(turn.runId))).toContain('TASK_PRESERVED_DURING_BACKUP_CHECK')
      const late = await turnRequest(harness, { content: 'After admission closed', requestId: 'after-backup' })
      expect(service.prepareIdleShutdown()).toBe(true)
      await expect(harness.invoke('chat.startTurn', late)).rejects.toThrow('Runtime handler is unavailable')
      expect(createRunRepository(database).listIncomplete()).toEqual([])
    }
    finally {
      response.resolve()
      await service.dispose()
      await eventLog.close()
    }
  })

  it.each(['root', 'child'] as const)('recovers a corrupt %s across database restarts and executes new turns in the same conversation', async (damagedId) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-run-recovery-')))
    directories.push(directory)
    const buddyHome = join(directory, 'buddy')
    const databasePath = join(buddyHome, 'buddy.sqlite3')
    const conversationsDirectory = join(buddyHome, 'conversations')
    const scope = { conversationId: 'conversation', branchId: 'branch' }
    const seed = createExecutionStorageFixture(databasePath)
    const seedLog = createRunEventLog({ database: seed.database, conversationsDirectory })
    seed.conversations.createMessage({ id: 'goal', ...scope, runId: null, role: 'user', content: { text: 'Old interrupted goal' }, createdAt: executionNow })
    seed.executions.admitChild(seed.child('child'))
    for (const runId of ['root', 'child']) {
      await seedLog.append({ runId, type: 'run.started', payload: {} })
      await seedLog.append({ runId, type: 'tool.started', payload: { toolCallId: `old-tool-${runId}`, toolName: 'read', args: { path: 'evidence.txt' } } })
    }
    await seedLog.append({ runId: damagedId, type: 'approval.requested', payload: {
      id: 'old-approval',
      runId: damagedId,
      toolCallId: 'old-read',
      kind: 'read',
      status: 'pending',
      summary: 'Old read',
      createdAt: executionNow,
      resolvedAt: null,
      payload: { card: 'paths', access: 'read', grant: null, toolName: 'read', targets: [{ path: '/fixture.txt', zone: 'workspace' }] },
    } })
    const originalProjection = seed.database.prepare('SELECT * FROM run_events WHERE run_id = ?').all(damagedId)
    await seedLog.close()
    seed.database.close()
    const damagedFile = join(conversationsDirectory, scope.conversationId, 'events', `${damagedId}.jsonl`)
    await appendFile(damagedFile, '{"torn":')
    const damagedBytes = await readFile(damagedFile)
    let response = Promise.withResolvers<void>()
    const provider = await startLocalModelProvider(async () => {
      const current = response
      await current.promise
      return { text: 'NEW_TURN_EXECUTED' }
    })
    let priorCompleted: string | undefined
    let newlyDamagedFile: string | undefined
    let newlyDamagedBytes: Buffer | undefined
    let queuedId: string | undefined
    for (let boot = 0; boot < 3; boot++) {
      const database = openBuddyDatabase({ databasePath })
      const eventLog = createRunEventLog({ database, conversationsDirectory })
      const harness = createRuntimeRpcHarness({ 'offline-provider': { type: 'api_key', key: 'test-api-key' } })
      let runtime: Awaited<ReturnType<typeof startBuddyService>> | undefined
      const beforeRequests = provider.requests.length
      try {
        expect(await eventLog.recoverAll()).toMatchObject({ failed: boot === 2 ? 2 : 1 })
        runtime = await startBuddyService({ buddyHome, database, eventLog, rpc: harness.rpc, builtinSkillsDirectories: [] })
        const runs = createRunRepository(database)
        const executions = createExecutionRepository(database)
        expect(runs.listIncomplete()).toEqual([])
        expect(runs.findById(damagedId)).toMatchObject({ status: 'failed', errorCode: 'EVENT_LOG_CORRUPTED', piSessionFile: null })
        expect(executions.find(damagedId)).toMatchObject({ phase: 'closed', cleanupState: 'degraded', cleanupErrorCode: 'EVENT_LOG_CORRUPTED' })
        expect(executions.find('root')).toMatchObject({ phase: 'closed', cleanupState: 'degraded' })
        expect(createApprovalRepository(database).findById('old-approval')?.status).toBe('cancelled')
        expect(database.prepare('SELECT * FROM run_events WHERE run_id = ?').all(damagedId)).toEqual(originalProjection)
        expect(await readFile(damagedFile)).toEqual(damagedBytes)
        expect(provider.requests).toHaveLength(beforeRequests)
        const healthyId = damagedId === 'root' ? 'child' : 'root'
        expect(await eventLog.read(healthyId)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'run.failed' })]))
        const timeline = await harness.invoke('conversations.listTimeline', { ...scope, limit: 100 }) as { runs: Array<{ id: string, errorCode: string | null }>, runEvents: Array<{ runId: string }> }
        expect(timeline.runEvents.some(event => event.runId === damagedId)).toBe(false)
        if (damagedId === 'root')
          expect(timeline.runs.find(run => run.id === 'root')?.errorCode).toBe('EVENT_LOG_CORRUPTED')
        expect(await harness.invoke('executions.list', scope)).toEqual(expect.arrayContaining([
          expect.objectContaining({ runId: damagedId, phase: 'closed', cleanup: 'degraded', errorCode: 'EVENT_LOG_CORRUPTED', toolCount: 1 }),
        ]))
        if (queuedId) {
          expect(await harness.invoke('chat.queue.list', scope)).toEqual([expect.objectContaining({ id: queuedId, state: 'paused' })])
          expect(await harness.invoke('chat.queue.cancel', { ...scope, id: queuedId })).toBe(true)
        }
        expect(await harness.invoke('runs.isBusy', {})).toBe(false)
        await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
        response = Promise.withResolvers<void>()
        const turn = await harness.invoke('chat.startTurn', await turnRequest(harness, { ...scope, content: `New explicit turn ${boot}`, requestId: `new-turn-${boot}` })) as LocalTurnStart
        await expect.poll(() => provider.requests.length).toBe(beforeRequests + 1)
        expect(await harness.invoke('runs.isBusy', {})).toBe(true)
        expect(runs.findById(turn.runId)?.status).toBe('running')
        if (boot === 1 && priorCompleted) {
          newlyDamagedFile = join(conversationsDirectory, scope.conversationId, 'events', `${priorCompleted}.jsonl`)
          await appendFile(newlyDamagedFile, '{broken}\n')
          newlyDamagedBytes = await readFile(newlyDamagedFile)
          await expect(eventLog.read(priorCompleted)).rejects.toMatchObject({ code: 'EVENT_LOG_CORRUPTED' })
          expect(runs.findById(turn.runId)?.status).toBe('running')
          expect(await harness.invoke('runs.isBusy', {})).toBe(true)
        }
        response.resolve()
        expect(await waitForTerminalRun(harness, turn.runId)).toMatchObject({ status: 'completed' })
        expect(JSON.stringify(await eventLog.read(turn.runId))).toContain('NEW_TURN_EXECUTED')
        priorCompleted = turn.runId
        if (boot === 1) {
          response = Promise.withResolvers<void>()
          const cancelled = await harness.invoke('chat.startTurn', await turnRequest(harness, { ...scope, content: 'Explicitly cancel this new turn', requestId: 'cancel-new-turn' })) as LocalTurnStart
          await expect.poll(() => provider.requests.length).toBe(beforeRequests + 2)
          const queued = await harness.invoke('chat.queue.enqueue', await turnRequest(harness, { ...scope, content: 'Do not replay this queued input', requestId: 'retained-queue' })) as { id: string }
          queuedId = queued.id
          expect(await harness.invoke('chat.cancel', { runId: cancelled.runId })).toMatchObject({ status: 'cancelled' })
          response.resolve()
          expect(await harness.invoke('chat.queue.list', scope)).toEqual([expect.objectContaining({ id: queuedId, state: 'paused' })])
        }
        await expect.poll(() => harness.invoke('runs.isBusy', {})).toBe(false)
        expect(await readFile(damagedFile)).toEqual(damagedBytes)
        if (newlyDamagedFile)
          expect(await readFile(newlyDamagedFile)).toEqual(newlyDamagedBytes)
      }
      finally {
        response.resolve()
        await runtime?.dispose()
        await eventLog.close()
        database.close()
      }
    }
    expect(provider.requests).toHaveLength(4)
  }, 30_000)

  it.each(['legacy outputs', 'pending deletion'] as const)('starts past a quarantined conversation with %s and continues healthy work', async (maintenance) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-startup-quarantine-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const conversationsDirectory = join(buddyHome, 'conversations')
    const seedLog = createRunEventLog({ conversationsDirectory, database })
    for (const id of ['damaged', 'healthy']) {
      prepareTestTurnRequest(database, {
        attachmentBindings: [],
        branchId: `branch-${id}`,
        conversationId: id,
        createdAt: '2026-10-12T00:00:00.000Z',
        approvalPolicy: 'policy',
        executionProfile: 'workspace_write',
        model: 'offline-model',
        spaceId: null,
        provider: 'offline-provider',
        requestFingerprint: `fingerprint-${id}`,
        requestId: `request-${id}`,
        runInput: { attachmentIds: [], contextItems: [], prompt: 'Interrupted maintenance fixture', reasoning: null, serviceTier: null },
        runId: `run-${id}`,
        title: null,
        userMessageContent: { text: 'Interrupted maintenance fixture' },
        userMessageId: `message-${id}`,
      })
      await seedLog.append({ runId: `run-${id}`, type: 'audit.before', payload: { preserved: true } })
      if (maintenance === 'pending deletion') {
        createConversationDeletionRepository(database).commit(id, '2026-10-12T00:00:01.000Z')
      }
      else {
        const artifactsDirectory = join(conversationsDirectory, id, 'artifacts')
        await mkdir(artifactsDirectory, { recursive: true })
        await writeFile(join(artifactsDirectory, 'output.txt'), `Preserved ${id} output`)
        await seedLog.append({
          runId: `run-${id}`,
          type: 'output.produced',
          payload: { artifactIds: [`artifact-${id}`], sourceToolCallId: `tool-${id}`, sourceToolName: 'lexora_artifact_present' },
        })
      }
    }
    await seedLog.close()
    const damagedFile = join(conversationsDirectory, 'damaged', 'events', 'run-damaged.jsonl')
    const damaged = `${await readFile(damagedFile, 'utf8')}{broken}\n`
    await writeFile(damagedFile, damaged)
    const projection = database.prepare('SELECT * FROM run_events WHERE run_id = ?').all('run-damaged')
    const eventLog = createRunEventLog({ conversationsDirectory, database })
    const harness = createRuntimeRpcHarness({ 'offline-provider': { type: 'api_key', key: 'test-api-key' } })
    const provider = await startLocalModelProvider(async () => ({ text: 'HEALTHY_AFTER_STARTUP' }))
    let runtime: Awaited<ReturnType<typeof startBuddyService>> | undefined
    try {
      expect(await eventLog.recoverAll()).toMatchObject({ failed: 1, failures: [{ conversationId: 'damaged', runId: 'run-damaged' }] })
      runtime = await startBuddyService({ buddyHome, database, eventLog, rpc: harness.rpc, builtinSkillsDirectories: [] })
      const runs = createRunRepository(database)
      expect(eventLog.state).toBe('open')
      expect(runs.findById('run-damaged')).toMatchObject({ status: 'failed', errorCode: 'EVENT_LOG_CORRUPTED' })
      expect(database.prepare('SELECT * FROM run_events WHERE run_id = ?').all('run-damaged')).toEqual(projection)
      if (maintenance === 'pending deletion') {
        expect(runs.findById('run-healthy')).toBeNull()
        expect(createConversationRepository(database).findById('healthy')).toBeNull()
        expect(createConversationRepository(database).isDeleted('damaged')).toBe(true)
        expect(createConversationDeletionRepository(database).pending()).toEqual([])
      }
      if (maintenance === 'legacy outputs') {
        expect(runs.findById('run-healthy')).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_RESTARTED' })
        const artifacts = createArtifactRepository(database)
        expect(artifacts.findById('artifact-damaged')).toBeNull()
        expect(artifacts.findById('artifact-healthy')).toMatchObject({ currentPath: join(conversationsDirectory, 'healthy', 'artifacts', 'output.txt') })
        expect(await readFile(join(conversationsDirectory, 'damaged', 'artifacts', 'output.txt'), 'utf8')).toBe('Preserved damaged output')
      }
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      const healthy = await harness.invoke('chat.startTurn', await turnRequest(harness, { content: 'Healthy work after startup', requestId: 'healthy-after-startup' })) as LocalTurnStart
      expect(await waitForTerminalRun(harness, healthy.runId)).toMatchObject({ status: 'completed' })
      expect(JSON.stringify(await eventLog.read(healthy.runId))).toContain('HEALTHY_AFTER_STARTUP')
      expect(provider.requests).toHaveLength(1)
    }
    finally {
      await runtime?.dispose()
      await eventLog.close()
    }
    expect(await readFile(damagedFile, 'utf8')).toBe(damaged)
  }, 20_000)

  it('stops a quarantined executor without rewriting its evidence or interrupting a healthy conversation', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-live-quarantine-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({ conversationsDirectory: join(buddyHome, 'conversations'), database })
    const harness = createRuntimeRpcHarness({ 'offline-provider': { type: 'api_key', key: 'test-api-key' } })
    const diagnostics: ApplicationDiagnostic[] = []
    const requested = { damaged: Promise.withResolvers<void>(), healthy: Promise.withResolvers<void>() }
    const responses = { damaged: Promise.withResolvers<void>(), healthy: Promise.withResolvers<void>() }
    const provider = await startLocalModelProvider(async (payload) => {
      if (JSON.stringify(payload.messages).includes('AFTER_LIVE_QUARANTINE'))
        return { text: 'NEW_AFTER_LIVE_QUARANTINE' }
      const key = JSON.stringify(payload.messages).includes('DAMAGED_TASK') ? 'damaged' : 'healthy'
      requested[key].resolve()
      await responses[key].promise
      return { text: key === 'damaged' ? 'MUST_NOT_COMMIT' : 'HEALTHY_RESULT' }
    })
    const runtime = await startBuddyService({ buddyHome, database, eventLog, rpc: harness.rpc, builtinSkillsDirectories: [], record: event => diagnostics.push(event) })
    try {
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      const damaged = await harness.invoke('chat.startTurn', await turnRequest(harness, { content: 'DAMAGED_TASK', requestId: 'damaged-task' })) as LocalTurnStart
      await requested.damaged.promise
      const healthy = await harness.invoke('chat.startTurn', await turnRequest(harness, { content: 'HEALTHY_TASK', requestId: 'healthy-task' })) as LocalTurnStart
      await requested.healthy.promise
      const file = join(buddyHome, 'conversations', damaged.conversationId, 'events', `${damaged.runId}.jsonl`)
      const original = await readFile(file, 'utf8')
      const corrupted = `${original}{broken}\n`
      await writeFile(file, corrupted)
      await expect(eventLog.read(damaged.runId)).rejects.toMatchObject({ code: 'EVENT_LOG_CORRUPTED' })
      await expect.poll(() => diagnostics.some(event => event.event === 'execution.settled' && event.runId === damaged.runId)).toBe(true)
      expect(await readFile(file, 'utf8')).toBe(corrupted)
      const runs = createRunRepository(database)
      expect(runs.findById(healthy.runId)?.status).toBe('running')

      responses.damaged.resolve()
      responses.healthy.resolve()
      expect(await waitForTerminalRun(harness, healthy.runId)).toMatchObject({ status: 'completed' })
      expect(JSON.stringify(await eventLog.read(healthy.runId))).toContain('HEALTHY_RESULT')
      await expect.poll(() => runs.findById(damaged.runId)?.status).toBe('failed')
      const next = await harness.invoke('chat.startTurn', await turnRequest(harness, {
        conversationId: damaged.conversationId,
        branchId: damaged.branchId,
        content: 'AFTER_LIVE_QUARANTINE',
        requestId: 'after-live-quarantine',
      })) as LocalTurnStart
      const continued = await waitForTerminalRun(harness, next.runId)
      expect(continued, JSON.stringify(await eventLog.read(next.runId))).toMatchObject({ status: 'completed', errorCode: null })
      expect(JSON.stringify(await eventLog.read(next.runId))).toContain('NEW_AFTER_LIVE_QUARANTINE')
      expect(await readFile(file, 'utf8')).toBe(corrupted)
    }
    finally {
      responses.damaged.resolve()
      responses.healthy.resolve()
      await runtime.dispose()
      await eventLog.close()
    }
  }, 20_000)

  it('delegates through real Pi tools and child sessions with request-bound models, independent Web scope and durable result continuation', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-delegation-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const builtinSkillsDirectory = join(root, 'skills')
    let protectedFile = ''
    await mkdir(builtinSkillsDirectory)
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({ conversationsDirectory: join(buddyHome, 'conversations'), database })
    const harness = createRuntimeRpcHarness({ 'offline-provider': { type: 'api_key', key: 'test-api-key' } }, { 'https://npc.example.test/evidence': 'CONTROLLED_WEB_EVIDENCE' })
    const approvalOwners: string[] = []
    const approvalErrors: unknown[] = []
    const approvalSubscription = eventLog.onDidCommit((event) => {
      if (event.type !== 'approval.requested')
        return
      approvalOwners.push(event.runId)
      const payload = event.payload as { id: string, kind: string }
      void harness.invoke(payload.kind === 'network' ? 'approvals.approve' : 'approvals.deny', { approvalId: payload.id, ...(payload.kind === 'network' ? { scope: 'once' } : {}) }).catch(error => approvalErrors.push(error))
    })
    const firstRequest = Promise.withResolvers<void>()
    const releaseFirstRequest = Promise.withResolvers<void>()
    const childrenCanFinish = Promise.withResolvers<void>()
    const npcRequests = new Map<string, number>()
    let rootRequests = 0
    let npcId = ''
    const provider = await startLocalModelProvider(async (payload) => {
      const messages = JSON.stringify(payload.messages)
      if (messages.includes('ROOT_PRIVATE_INSTRUCTIONS')) {
        const segment = ++rootRequests
        if (segment === 1) {
          firstRequest.resolve()
          await releaseFirstRequest.promise
          return { toolCall: { id: 'delegate-m1', name: 'lexora_agents', arguments: { operation: 'delegate', targetId: npcId, text: 'NPC_TASK_M1' } } }
        }
        if (segment === 2)
          return { toolCall: { id: 'delegate-m2', name: 'lexora_agents', arguments: { operation: 'delegate', targetId: npcId, text: 'NPC_TASK_M2' } } }
        if (!messages.includes('NPC_RESULT_M1') || !messages.includes('NPC_RESULT_M2')) {
          childrenCanFinish.resolve()
          const delegated = (payload.messages as { role?: string, content?: string }[]).flatMap((message) => {
            if (message.role !== 'tool' || !message.content)
              return []
            const details = JSON.parse(message.content)
            return details.kind === 'npc_child' ? [details.runId as string] : []
          })
          return { toolCall: { id: `wait-${segment}`, name: 'lexora_agents', arguments: { operation: 'wait', runId: delegated[messages.includes('NPC_RESULT_M1') ? 1 : 0], timeoutMs: 10000 } } }
        }
        return { text: 'ROOT_FINAL_AFTER_BOTH_RESULTS' }
      }
      const task = messages.includes('NPC_TASK_M1') ? 'M1' : 'M2'
      const request = (npcRequests.get(task) ?? 0) + 1
      npcRequests.set(task, request)
      if (request === 1)
        return { toolCall: { id: 'fetch-evidence', name: 'lexora_web_fetch', arguments: { url: 'https://npc.example.test/evidence' } } }
      if (request === 2)
        return { toolCall: { id: 'attempt-write', name: 'write', arguments: { path: protectedFile, content: 'Forbidden overwrite' } } }
      await childrenCanFinish.promise
      return { text: `NPC_RESULT_${task}` }
    })
    const runtime = await startBuddyService({ buddyHome, builtinSkillsDirectories: [builtinSkillsDirectory], database, eventLog, rpc: harness.rpc })
    try {
      const config = offlineProviderConfig(provider.baseUrl)
      await harness.invoke('providers.upsertCustom', { ...config, models: [...config.models, { ...config.models[0], id: 'offline-next', name: 'Offline next model' }] })
      const npc = await harness.invoke('buddies.create', { kind: 'npc', name: 'Controlled researcher' }) as LocalBuddy
      npcId = npc.id
      await harness.invoke('buddies.update', { buddyId: npc.id, expectedRevision: npc.revision, settings: {
        ...DEFAULT_BUDDY_SETTINGS,
        instructions: 'NPC_PRIVATE_INSTRUCTIONS',
        skills: { mode: 'none' },
        tools: { mode: 'selected', ids: [JSON.stringify(['builtin', 'web', 'lexora_web_fetch']), JSON.stringify(['builtin', 'core', 'write']), JSON.stringify(['builtin', 'core', process.platform === 'win32' ? 'powershell' : 'bash'])] },
      } })
      const actor = await harness.invoke('buddies.get', { buddyId: 'default' }) as LocalBuddy
      await harness.invoke('buddies.update', { buddyId: actor.id, expectedRevision: actor.revision, settings: {
        ...DEFAULT_BUDDY_SETTINGS,
        instructions: 'ROOT_PRIVATE_INSTRUCTIONS',
        skills: { mode: 'none' },
        tools: { mode: 'none' },
        limits: { fileAccess: 'read_only' },
        npcIds: [npc.id],
      } })
      const turn = await harness.invoke('chat.startTurn', await turnRequest(harness, { content: 'ROOT_ONLY_TASK', requestId: 'controlled-delegation' })) as LocalTurnStart
      await firstRequest.promise
      protectedFile = join(buddyHome, 'conversations', turn.conversationId, 'workspace', 'protected.txt')
      await writeFile(protectedFile, 'Original contents')
      await harness.invoke('conversations.setModelSelection', { conversationId: turn.conversationId, targetRunId: turn.runId, actorId: 'default', modelSelection: { providerId: 'offline-provider', modelId: 'offline-next', reasoning: null, serviceTier: null } })
      releaseFirstRequest.resolve()
      const completed = await waitForTerminalRun(harness, turn.runId)
      expect(provider.errors).toEqual([])
      expect(approvalErrors).toEqual([])
      expect(completed).toMatchObject({ status: 'completed' })
      const runs = createRunRepository(database).listTree(turn.runId)
      const children = runs.filter(run => run.executionKind === 'npc_child')
      expect(children).toHaveLength(2)
      expect(approvalOwners.sort()).toEqual(children.map(run => run.id).sort())
      expect(children.map(run => run.actorSnapshot?.model.modelId).sort()).toEqual(['offline-model', 'offline-next'])
      expect(children.every(run => run.status === 'completed' && run.executionProfile === 'workspace_write')).toBe(true)
      expect(children.every(run => database.prepare('SELECT file_access_ceiling FROM execution_state WHERE run_id = ?').get(run.id)?.file_access_ceiling === 'read_only')).toBe(true)
      expect(new Set(runs.map(run => run.threadId)).size).toBe(3)
      expect(new Set(runs.map(run => run.piSessionFile)).size).toBe(3)
      const rootPayloads = provider.requests.filter(payload => JSON.stringify(payload.messages).includes('ROOT_PRIVATE_INSTRUCTIONS'))
      expect(rootPayloads.map(payload => payload.model)).toEqual(['offline-model', ...Array.from({ length: rootPayloads.length - 1 }).fill('offline-next')])
      for (const payload of rootPayloads) {
        expect(toolNames(payload)).toContain('lexora_agents')
        expect(toolNames(payload)).not.toContain('lexora_web_fetch')
        expect(JSON.stringify(payload.messages)).not.toContain('NPC_PRIVATE_INSTRUCTIONS')
      }
      for (const task of ['M1', 'M2']) {
        const payloads = provider.requests.filter(payload => !JSON.stringify(payload.messages).includes('ROOT_PRIVATE_INSTRUCTIONS') && JSON.stringify(payload.messages).includes(`NPC_TASK_${task}`))
        expect(payloads).toHaveLength(3)
        expect(payloads.every(payload => payload.model === (task === 'M1' ? 'offline-model' : 'offline-next'))).toBe(true)
        expect(toolNames(payloads[0]!)).toContain('lexora_web_fetch')
        expect(toolNames(payloads[0]!)).not.toContain('write')
        expect(toolNames(payloads[0]!)).toContain(process.platform === 'win32' ? 'powershell' : 'bash')
        expect(JSON.stringify(payloads[0]!.messages)).not.toContain('ROOT_ONLY_TASK')
        expect(JSON.stringify(payloads[1]!.messages)).toContain('CONTROLLED_WEB_EVIDENCE')
      }
      expect(await readFile(protectedFile, 'utf8')).toBe('Original contents')
      const rootRun = runs.find(run => run.id === turn.runId)!
      const journal = SessionManager.open(rootRun.piSessionFile!)
      const after = journal.getEntries().filter(entry => readCheckpoint(entry)?.runId === rootRun.id && readCheckpoint(entry)?.position === 'after')
      expect(after).toHaveLength(1)
      expect(JSON.stringify(journal.getBranch(after[0]!.id))).toContain('ROOT_FINAL_AFTER_BOTH_RESULTS')
      expect(rootPayloads.at(-1)!.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool', content: expect.stringContaining('NPC_RESULT_') })]))
      const rootEvents = await eventLog.read(turn.runId)
      expect(rootEvents.filter(event => event.type === 'execution.mailbox.accepted')).toHaveLength(2)
      expect(rootEvents.filter(event => event.type === 'execution.mailbox.consumed')).toHaveLength(2)
      expect(rootEvents.filter(event => event.type === 'run.completed')).toHaveLength(1)
      const usage = createUsageRepository(database)
      expect(usage.listForRun(turn.runId)).toHaveLength(rootPayloads.length)
      for (const child of children) {
        expect(usage.listForRun(child.id)).toHaveLength(3)
        expect((await eventLog.read(child.id)).filter(event => event.type === 'execution.mailbox.sent')).toHaveLength(1)
      }
      const history = createConversationRepository(database).listBranchMessages(turn.conversationId, turn.branchId)
      expect(history.filter(message => message.role === 'user')).toHaveLength(1)
      expect(JSON.stringify(history)).not.toContain('NPC_RESULT_')
    }
    finally {
      releaseFirstRequest.resolve()
      childrenCanFinish.resolve()
      approvalSubscription.dispose()
      await runtime.dispose()
      await eventLog.close()
    }
  }, 30_000)

  it('cancels a child after its first input reaches a real Provider without leaving an active session or cancelling its parent', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-cancel-child-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const builtinSkillsDirectory = join(root, 'skills')
    await mkdir(builtinSkillsDirectory)
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({ conversationsDirectory: join(buddyHome, 'conversations'), database })
    const harness = createRuntimeRpcHarness({ 'offline-provider': { type: 'api_key', key: 'test-api-key' } })
    const childRequest = Promise.withResolvers<void>()
    const releaseChildResponse = Promise.withResolvers<void>()
    let npcId = ''
    let rootRequests = 0
    let childRequests = 0
    const provider = await startLocalModelProvider(async (payload) => {
      if (JSON.stringify(payload.messages).includes('CANCEL_PARENT_INSTRUCTIONS')) {
        if (++rootRequests === 1)
          return { toolCall: { id: 'delegate-cancellable-child', name: 'lexora_agents', arguments: { operation: 'delegate', targetId: npcId, text: 'NPC_INITIAL_INPUT_ACCEPTED' } } }
        return { text: rootRequests === 2 ? 'Root is awaiting its child' : 'Root acknowledged the cancelled child' }
      }
      childRequests++
      childRequest.resolve()
      await releaseChildResponse.promise
      return { text: 'Late child response must not complete the cancelled run' }
    })
    const runtime = await startBuddyService({ buddyHome, builtinSkillsDirectories: [builtinSkillsDirectory], database, eventLog, rpc: harness.rpc })
    try {
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      const npc = await harness.invoke('buddies.create', { kind: 'npc', name: 'Cancellable child' }) as LocalBuddy
      npcId = npc.id
      await harness.invoke('buddies.update', { buddyId: npc.id, expectedRevision: npc.revision, settings: { ...DEFAULT_BUDDY_SETTINGS, instructions: 'CANCEL_CHILD_INSTRUCTIONS', tools: { mode: 'none' }, skills: { mode: 'none' } } })
      const actor = await harness.invoke('buddies.get', { buddyId: 'default' }) as LocalBuddy
      await harness.invoke('buddies.update', { buddyId: actor.id, expectedRevision: actor.revision, settings: { ...DEFAULT_BUDDY_SETTINGS, instructions: 'CANCEL_PARENT_INSTRUCTIONS', tools: { mode: 'none' }, skills: { mode: 'none' }, npcIds: [npc.id] } })
      const turn = await harness.invoke('chat.startTurn', await turnRequest(harness, { content: 'Delegate one task', requestId: 'controlled-child-cancellation' })) as LocalTurnStart
      await childRequest.promise
      const runs = createRunRepository(database)
      const child = runs.listTree(turn.runId).find(run => run.executionKind === 'npc_child')!
      expect(child.status).toBe('running')
      const acceptedJournal = SessionManager.open(child.piSessionFile!).getBranch()
      expect(JSON.stringify(acceptedJournal)).toContain('NPC_INITIAL_INPUT_ACCEPTED')
      expect(await harness.invoke('executions.cancel', { conversationId: turn.conversationId, branchId: turn.branchId, rootRunId: turn.runId, runId: child.id })).toEqual({ cancelled: true })
      expect(await waitForTerminalRun(harness, turn.runId)).toMatchObject({ status: 'completed' })
      expect(runs.findById(child.id)).toMatchObject({ status: 'cancelled' })
      expect(database.prepare('SELECT phase, cleanup_state FROM execution_state WHERE run_id = ?').get(child.id)).toMatchObject({ phase: 'closed', cleanup_state: 'clean' })
      expect(childRequests).toBe(1)
      const childEvents = await eventLog.read(child.id)
      expect(childEvents.filter(event => event.type === 'run.cancelled')).toHaveLength(1)
      expect(childEvents.some(event => event.type === 'run.completed')).toBe(false)
      expect((await eventLog.read(turn.runId)).filter(event => event.type === 'execution.mailbox.consumed')).toHaveLength(1)
      expect(provider.errors).toEqual([])
    }
    finally {
      releaseChildResponse.resolve()
      await runtime.dispose()
      await eventLog.close()
    }
  }, 30_000)

  it('cancels a working execution tree without replaying child requests or rewriting a completed sibling', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-cancel-tree-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const builtinSkillsDirectory = join(root, 'skills')
    await mkdir(builtinSkillsDirectory)
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({ conversationsDirectory: join(buddyHome, 'conversations'), database })
    const harness = createRuntimeRpcHarness({ 'offline-provider': { type: 'api_key', key: 'test-api-key' } })
    const runs = createRunRepository(database)
    const heldRequest = Promise.withResolvers<void>()
    const releaseResponse = Promise.withResolvers<void>()
    let rootRequests = 0
    let fastRequests = 0
    let heldRequests = 0
    let fastNpcId = ''
    let heldNpcId = ''
    const provider = await startLocalModelProvider(async (payload) => {
      const messages = JSON.stringify(payload.messages)
      if (messages.includes('CANCEL_TREE_ROOT_INSTRUCTIONS')) {
        rootRequests++
        if (rootRequests === 1)
          return { toolCall: { id: 'delegate-completed-sibling', name: 'lexora_agents', arguments: { operation: 'delegate', targetId: fastNpcId, text: 'FINISHED_CHILD_INPUT' } } }
        if (rootRequests === 2)
          return { toolCall: { id: 'delegate-working-child', name: 'lexora_agents', arguments: { operation: 'delegate', targetId: heldNpcId, text: 'WORKING_CHILD_INPUT' } } }
        const child = runs.listIncomplete().find(run => run.buddyId === heldNpcId)!
        return { toolCall: { id: `wait-working-${rootRequests}`, name: 'lexora_agents', arguments: { operation: 'wait', runId: child.id, timeoutMs: 10000 } } }
      }
      if (messages.includes('FINISHED_CHILD_INPUT')) {
        fastRequests++
        return { text: 'COMPLETED_CHILD_FACT' }
      }
      heldRequests++
      heldRequest.resolve()
      await releaseResponse.promise
      return { text: 'LATE_RESPONSE_MUST_NOT_REVIVE_TREE' }
    })
    const runtime = await startBuddyService({ buddyHome, builtinSkillsDirectories: [builtinSkillsDirectory], database, eventLog, rpc: harness.rpc })
    let disposed = false
    try {
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      for (const [name, instructions] of [['Finished child', 'CANCEL_TREE_FAST_INSTRUCTIONS'], ['Working child', 'CANCEL_TREE_HELD_INSTRUCTIONS']]) {
        const npc = await harness.invoke('buddies.create', { kind: 'npc', name }) as LocalBuddy
        await harness.invoke('buddies.update', { buddyId: npc.id, expectedRevision: npc.revision, settings: { ...DEFAULT_BUDDY_SETTINGS, instructions, tools: { mode: 'none' }, skills: { mode: 'none' } } })
        if (name === 'Finished child')
          fastNpcId = npc.id
        else
          heldNpcId = npc.id
      }
      const actor = await harness.invoke('buddies.get', { buddyId: 'default' }) as LocalBuddy
      await harness.invoke('buddies.update', { buddyId: actor.id, expectedRevision: actor.revision, settings: { ...DEFAULT_BUDDY_SETTINGS, instructions: 'CANCEL_TREE_ROOT_INSTRUCTIONS', tools: { mode: 'none' }, skills: { mode: 'none' }, npcIds: [fastNpcId, heldNpcId] } })
      const turn = await harness.invoke('chat.startTurn', await turnRequest(harness, { content: 'Delegate both inspections and wait for them', requestId: 'cancel-real-working-tree' })) as LocalTurnStart
      await heldRequest.promise
      const children = runs.listTree(turn.runId).filter(run => run.executionKind === 'npc_child')
      expect(children).toHaveLength(2)
      const fast = children.find(run => run.buddyId === fastNpcId)!
      const held = children.find(run => run.buddyId === heldNpcId)!
      expect(await waitForTerminalRun(harness, fast.id)).toMatchObject({ status: 'completed' })
      await expect.poll(
        () => database.prepare('SELECT phase FROM execution_state WHERE run_id = ?').get(turn.runId)?.phase,
        { timeout: 10_000 },
      ).toBe('waiting')
      expect(held.status).toBe('running')
      expect(JSON.stringify(SessionManager.open(held.piSessionFile!).getBranch())).toContain('WORKING_CHILD_INPUT')
      const completedFacts = await eventLog.read(fast.id)
      const completedRun = runs.findById(fast.id)
      expect(await harness.invoke('chat.cancel', { runId: turn.runId })).toMatchObject({ status: 'cancelled' })
      expect(await waitForTerminalRun(harness, turn.runId)).toMatchObject({ status: 'cancelled' })
      expect(runs.findById(held.id)).toMatchObject({ status: 'cancelled' })
      releaseResponse.resolve()
      await runtime.dispose()
      disposed = true
      expect(runs.listIncomplete()).toEqual([])
      expect(database.prepare('SELECT phase, cleanup_state FROM execution_state WHERE run_id IN (?, ?)').all(turn.runId, held.id)).toEqual([{ phase: 'closed', cleanup_state: 'clean' }, { phase: 'closed', cleanup_state: 'clean' }])
      expect(runs.findById(fast.id)).toEqual(completedRun)
      expect(await eventLog.read(fast.id)).toEqual(completedFacts)
      expect([fastRequests, heldRequests]).toEqual([1, 1])
      for (const runId of [turn.runId, held.id]) {
        const events = await eventLog.read(runId)
        expect(events.filter(event => ['run.cancelled', 'run.completed', 'run.failed'].includes(event.type)).map(event => event.type)).toEqual(['run.cancelled'])
        expect(events.some(event => event.type === 'execution.mailbox.consumed')).toBe(false)
      }
      expect(database.prepare('SELECT COUNT(*) AS count FROM execution_mailbox_receipts WHERE kind = \'consumed\'').get()?.count).toBe(0)
      expect(database.prepare('SELECT COUNT(*) AS count FROM runs').get()?.count).toBe(3)
      expect(provider.errors).toEqual([])
    }
    finally {
      releaseResponse.resolve()
      if (!disposed)
        await runtime.dispose()
      await eventLog.close()
    }
  }, 30_000)

  it('recovers readable historical images and publishes one sanitized degradation after Pi corruption', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-attachment-recovery-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const builtinSkillsDirectory = join(root, 'skills')
    const keptSource = join(root, 'kept.png')
    const missingSource = join(root, 'missing.png')
    const keptBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    await Promise.all([
      mkdir(builtinSkillsDirectory, { recursive: true }),
      writeFile(keptSource, keptBytes),
      writeFile(missingSource, keptBytes),
    ])
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({
      conversationsDirectory: join(buddyHome, 'conversations'),
      database,
    })
    const provider = await startLocalModelProvider()
    const credentials = {
      'offline-provider': { key: 'test-api-key', type: 'api_key' as const },
    }
    const diagnostics: ApplicationDiagnostic[] = []
    let runtime: Awaited<ReturnType<typeof startBuddyService>> | undefined
    try {
      let harness = createRuntimeRpcHarness(credentials)
      runtime = await startBuddyService({
        record: event => diagnostics.push(event),
        buddyHome,
        builtinSkillsDirectories: [builtinSkillsDirectory],
        database,
        eventLog,
        rpc: harness.rpc,
      })
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      await turnRequest(harness, { content: 'Remember both historical images', requestId: 'attachment-recovery-1' })
      await harness.invoke('composerResources.accept', {
        draftId: 'draft-attachment-recovery-1',
        resources: [keptSource, missingSource].map((sourcePath, index) => ({ resourceId: `recovery-${index}`, name: `recovery-${index}.png`, mimeType: 'image/png', sizeBytes: keptBytes.length, sourcePath, storage: 'snapshot' })),
      })
      const attachments = await Promise.all([0, 1].map(index => harness.invoke('composerResources.complete', { draftId: 'draft-attachment-recovery-1', resourceId: `recovery-${index}`, bytes: Uint8Array.from(keptBytes) }))) as ReadonlyArray<BuddyComposerResource>
      expect(attachments).toHaveLength(2)
      const attachmentIds = attachments.map((resource) => {
        if (resource.state !== 'ready' || !('attachmentId' in resource))
          throw new Error('Expected a ready imported resource')
        return resource.attachmentId
      })
      const messageAttachments = attachments.map((resource, index) => ({
        attachmentId: attachmentIds[index]!,
        kind: resource.kind,
        mimeType: resource.mimeType,
        name: resource.name,
        previewUrl: null,
        sizeBytes: resource.sizeBytes,
      }))

      const firstTurn = await harness.invoke('chat.startTurn', await turnRequest(harness, {
        resourceIds: attachments.map(attachment => attachment.resourceId),
        content: 'Remember both historical images',
        requestId: 'attachment-recovery-1',
      })) as LocalTurnStart
      await expect(waitForTerminalRun(harness, firstTurn.runId)).resolves.toMatchObject({
        status: 'completed',
      })
      expect(readDataImageUrls(provider.requests[0])).toHaveLength(2)
      const timeline = await harness.invoke('conversations.listTimeline', {
        branchId: firstTurn.branchId,
        conversationId: firstTurn.conversationId,
        limit: 100,
      }) as {
        items: ReadonlyArray<{
          attachments?: ReadonlyArray<LocalAttachment>
          kind: 'message'
          role: 'assistant' | 'tool' | 'user'
        }>
      }
      expect(timeline.items.find(item => item.kind === 'message' && item.role === 'user'))
        .toMatchObject({
          attachments: messageAttachments,
        })

      const firstRun = createRunRepository(database).findById(firstTurn.runId)
      if (!firstRun?.piSessionFile)
        throw new Error('The first run did not bind a Pi session')
      const missingAttachmentId = attachmentIds[1]!
      const missingAttachment = createAttachmentRepository(database).findById(missingAttachmentId)
      if (!missingAttachment)
        throw new Error('The missing attachment was not persisted')

      await runtime.dispose()
      runtime = undefined
      await Promise.all([
        writeFile(firstRun.piSessionFile, '{broken jsonl}\n'),
        unlink(missingAttachment.storedPath),
      ])

      harness = createRuntimeRpcHarness(credentials)
      runtime = await startBuddyService({
        record: event => diagnostics.push(event),
        buddyHome,
        builtinSkillsDirectories: [builtinSkillsDirectory],
        database,
        eventLog,
        rpc: harness.rpc,
      })
      const secondTurn = await harness.invoke('chat.startTurn', await turnRequest(harness, {
        branchId: firstTurn.branchId,
        content: 'Continue after recovery',
        conversationId: firstTurn.conversationId,
        requestId: 'attachment-recovery-2',
      })) as LocalTurnStart
      await expect(waitForTerminalRun(harness, secondTurn.runId)).resolves.toMatchObject({
        status: 'completed',
      })
      for (const content of ['Remember both historical images', 'Continue after recovery', 'test-api-key', keptBytes.toString('base64')])
        expect(JSON.stringify(diagnostics)).not.toContain(content)
      expect(readDataImageUrls(provider.requests[1])).toEqual([
        `data:image/png;base64,${keptBytes.toString('base64')}`,
      ])

      const internalEvents = await eventLog.read(secondTurn.runId)
      expect(internalEvents.filter(event => event.type === 'session.recovery.degraded'))
        .toMatchObject([{
          payload: {
            missingAttachmentCount: 1,
            missingAttachmentIds: [missingAttachmentId],
            recoveredImageCount: 1,
            source: 'sqlite',
          },
        }])
      const publicEvents = await harness.invoke('runs.listEvents', {
        limit: 100,
        runId: secondTurn.runId,
      }) as ReadonlyArray<LocalRunEvent>
      expect(publicEvents.filter(event => event.type === 'session.recovery.degraded'))
        .toMatchObject([{
          payload: {
            missingAttachmentCount: 1,
            recoveredImageCount: 1,
            source: 'sqlite',
          },
        }])
      expect(JSON.stringify(publicEvents)).not.toContain(missingAttachmentId)
      expect(JSON.stringify(publicEvents)).not.toContain(missingAttachment.storedPath)

      const thirdTurn = await harness.invoke('chat.startTurn', await turnRequest(harness, {
        branchId: firstTurn.branchId,
        content: 'Reuse the recovered session',
        conversationId: firstTurn.conversationId,
        requestId: 'attachment-recovery-3',
      })) as LocalTurnStart
      await expect(waitForTerminalRun(harness, thirdTurn.runId)).resolves.toMatchObject({
        status: 'completed',
      })
      expect((await eventLog.read(thirdTurn.runId)).filter(event => event.type.startsWith('session.')))
        .toEqual([])
    }
    finally {
      await runtime?.dispose()
      await eventLog.close()
    }
  })

  it('reconciles a Pi-committed compaction into Buddy storage after a runtime crash', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-recovery-')))
    directories.push(root)
    const conversationsDirectory = join(root, 'conversations')
    const sessionDirectory = join(
      conversationsDirectory,
      'conversation-1',
      'session',
      'branch-1',
    )
    await mkdir(sessionDirectory, { recursive: true })
    const manager = SessionManager.create(root, sessionDirectory)
    const firstKeptEntryId = manager.appendMessage({
      content: 'Keep this context',
      role: 'user',
      timestamp: Date.now(),
    })
    manager.appendMessage(assistant('Kept response'))
    manager.appendCompaction(
      'Private compacted context',
      firstKeptEntryId,
      1_200,
      undefined,
      false,
      usage(30, 6),
    )
    const piSessionFile = manager.getSessionFile()
    if (!piSessionFile)
      throw new Error('Pi did not create a persistent session file')

    const database = openTrackedDatabase(join(root, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({ conversationsDirectory, database })
    const conversations = createConversationRepository(database)
    const runs = createRunRepository(database)
    const inspectCommittedCompaction = (run: NonNullable<ReturnType<typeof runs.findById>>) =>
      run.piSessionFile
        ? inspectCommittedPiCompaction({
            branchId: run.branchId,
            conversationsDirectory,
            conversationId: run.conversationId,
            piSessionFile: run.piSessionFile,
            startedAt: run.startedAt,
          })
        : Promise.resolve(null)
    prepareTestTurnRequest(database, {
      attachmentBindings: [],
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      createdAt: '2026-08-15T00:00:00.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      model: 'model-1',
      spaceId: null,
      provider: 'provider-1',
      requestFingerprint: 'fingerprint-source',
      requestId: 'request-source',
      runInput: {
        attachmentIds: [],
        contextItems: [],
        prompt: 'Original turn',
        reasoning: null,
        serviceTier: null,
      },
      runId: 'run-source',
      title: null,
      userMessageContent: { text: 'Original turn' },
      userMessageId: 'message-source',
    })
    database.prepare(`
      UPDATE runs
      SET status = 'completed', pi_session_file = ?, completed_at = ?
      WHERE id = 'run-source'
    `).run(piSessionFile, '2026-08-15T00:00:01.000Z')
    prepareTestCommandRequest(database, {
      arguments: '',
      branchId: 'branch-1',
      command: 'compact',
      conversationId: 'conversation-1',
      createdAt: '2026-08-15T00:00:02.000Z',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      requestFingerprint: 'fingerprint-compact',
      requestId: 'request-compact',
      runId: 'run-compact',
    })
    database.prepare(`
      UPDATE runs SET status = 'running' WHERE id = 'run-compact'
    `).run()
    const usageRepository = createUsageRepository(database)
    const lifecycle = new RunLifecycleService({ eventLog, repository: runs })
    const recovery = new RunRecoveryService({
      conversations,
      eventLog,
      inspectCommittedCompaction,
      lifecycle,
      repository: runs,
      usage: new UsageService({ eventLog, repository: usageRepository }),
    })

    expect(await recovery.recoverInterruptedRuns()).toBe(1)
    expect(runs.findById('run-compact')).toMatchObject({ status: 'completed' })
    expect((await eventLog.read('run-compact')).map(event => event.type)).toEqual([
      'context.compaction.completed',
      'usage.recorded',
      'run.completed',
    ])
    expect(usageRepository.listForRun('run-compact')).toHaveLength(1)
    expect(conversations.listTimelinePage(
      'conversation-1',
      'branch-1',
      { limit: 10 },
    ).items.find(item => item.id === 'run-compact')).toMatchObject({
      estimatedTokensAfter: expect.any(Number),
      kind: 'compaction',
      status: 'completed',
      tokensBefore: 1_200,
    })
    expect(JSON.stringify(await eventLog.read('run-compact')))
      .not
      .toContain('Private compacted context')
  })

  it('continues the same Pi history in the new space without moving previous work files', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-move-space-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const target = join(root, 'project')
    await mkdir(target)
    await writeFile(join(target, 'AGENTS.md'), 'Target project instruction marker: TARGET_PROJECT_CONTEXT_400')
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({ conversationsDirectory: join(buddyHome, 'conversations'), database })
    const provider = await startLocalModelProvider()
    const harness = createRuntimeRpcHarness({ 'offline-provider': { key: 'test-api-key', type: 'api_key' } })
    const diagnostics: ApplicationDiagnostic[] = []
    const service = await startBuddyService({ buddyHome, builtinSkillsDirectories: [], database, eventLog, rpc: harness.rpc, record: event => diagnostics.push(event) })
    try {
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      const first = await service.runtime.startTurn(await turnRequest(harness, { content: 'Remember the original task history', requestId: 'before-space-move' }))
      expect((await waitForTerminalRun(harness, first.runId)).status).toBe('completed')
      await expect.poll(() => diagnostics.find(event => event.event === 'execution.settled' && event.runId === first.runId)).toMatchObject({ level: 'info' })
      const originalRun = createRunRepository(database).findById(first.runId)!
      const journal = await readFile(originalRun.piSessionFile!, 'utf8')
      const previous = join(buddyHome, 'conversations', first.conversationId, 'workspace')
      await writeFile(join(previous, 'unfinished.txt'), 'Unpublished work')
      const timestamp = new Date().toISOString()
      createSpaceRepository(database).create({ id: 'target-space', name: 'Target', memoryScope: 'space_only', createdAt: timestamp, primaryDirectory: { id: 'target-directory', root: target, canonicalRoot: target, accessGrantedAt: timestamp, resourcesTrustedAt: timestamp }, additionalDirectories: [] })
      const moved = await harness.invoke('conversations.moveToSpace', { conversationId: first.conversationId, spaceId: 'target-space' })
      expect(moved).toMatchObject({ id: first.conversationId, activeBranchId: first.branchId, spaceId: 'target-space' })
      expect(await readFile(originalRun.piSessionFile!, 'utf8')).toBe(journal)
      const second = await service.runtime.startTurn(await turnRequest(harness, { conversationId: first.conversationId, branchId: first.branchId, content: 'Continue the same task in this project', requestId: 'after-space-move' }))
      expect((await waitForTerminalRun(harness, second.runId)).status).toBe('completed')
      expect(second).toMatchObject({ conversationId: first.conversationId, branchId: first.branchId })
      expect(provider.requests).toHaveLength(2)
      const request = JSON.stringify(provider.requests[1])
      expect(request).toContain('Remember the original task history')
      expect(request).toContain('TARGET_PROJECT_CONTEXT_400')
      expect(request).toContain(JSON.stringify(target).slice(1, -1))
      expect(JSON.stringify(provider.requests[0])).not.toContain('TARGET_PROJECT_CONTEXT_400')
      expect(await readFile(join(previous, 'unfinished.txt'), 'utf8')).toBe('Unpublished work')
      expect(createRunRepository(database).findById(first.runId)).toEqual(originalRun)
      expect((await readFile(originalRun.piSessionFile!, 'utf8')).startsWith(journal)).toBe(true)
    }
    finally {
      await service.dispose()
      await eventLog.close()
    }
  })

  it('previews draft context without writes, then forks edited and regenerated turns with idempotent replay', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-chat-turns-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const builtinSkillsDirectory = join(root, 'skills')
    await mkdir(builtinSkillsDirectory, { recursive: true })
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({
      conversationsDirectory: join(buddyHome, 'conversations'),
      database,
    })
    const provider = await startLocalModelProvider()
    const harness = createRuntimeRpcHarness({
      'offline-provider': { key: 'test-api-key', type: 'api_key' },
    })
    const service = await startBuddyService({
      buddyHome,
      builtinSkillsDirectories: [builtinSkillsDirectory],
      database,
      eventLog,
      rpc: harness.rpc,
    })

    try {
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      const snapshot = await harness.invoke('context.usageSnapshot', {
        branchId: null,
        conversationId: null,
        draftId: 'draft-context-usage',
        approvalPolicy: 'policy',
        executionProfile: 'workspace_write',
        modelSelection: {
          modelId: 'offline-model',
          providerId: 'offline-provider',
          reasoning: null,
          serviceTier: null,
        },
        spaceId: null,
      }) as LocalContextUsageSnapshot
      expect(snapshot).toMatchObject({
        status: 'ready',
        contextWindow: 16_384,
        modelId: 'offline-model',
        providerId: 'offline-provider',
      })
      expect(provider.requests).toEqual([])
      expect(createConversationRepository(database).listRecent()).toEqual([])
      expect(createRunRepository(database).listRecent()).toEqual([])
      const first = await service.runtime.startTurn(await turnRequest(harness, {
        content: 'Original user input',
        requestId: 'chat-fork-start',
      }))
      await expect(waitForTerminalRun(harness, first.runId)).resolves.toMatchObject({
        status: 'completed',
      })
      const conversations = createConversationRepository(database)
      const firstMessages = conversations.listBranchMessages(
        first.conversationId,
        first.branchId,
      )
      const sourceUser = firstMessages.find(message => message.role === 'user')
      if (!sourceUser)
        throw new Error('The source user message was not persisted')

      const editContent = createBuddyUserContent('Edited user input')
      const editDraft = await harness.invoke('composerDrafts.open', {
        draftId: 'draft-chat-fork-edit',
        initialContent: editContent,
        initialExecutionConfig: {
          approvalPolicy: 'policy',
          executionProfile: 'workspace_write',
        },
        initialModelSelection: {
          modelId: 'offline-model',
          providerId: 'offline-provider',
          reasoning: null,
          serviceTier: null,
        },
        scope: {
          branchId: first.branchId,
          conversationId: first.conversationId,
          kind: 'message_edit',
          userMessageId: sourceUser.id,
        },
      }) as { draftId: string, revision: number }
      const edited = await harness.invoke('chat.editUserMessage', {
        conversationId: first.conversationId,
        draftId: editDraft.draftId,
        expectedRevision: editDraft.revision,
        requestId: 'chat-fork-edit',
        userMessageId: sourceUser.id,
      }) as LocalTurnStart
      expect(edited.branchId).not.toBe(first.branchId)
      await expect(waitForTerminalRun(harness, edited.runId)).resolves.toMatchObject({
        status: 'completed',
      })
      const editedMessages = conversations.listBranchMessages(
        edited.conversationId,
        edited.branchId,
      )
      expect(editedMessages.find(message => message.role === 'user')?.content).toMatchObject({
        userContent: {
          body: [{ content: [{ text: 'Edited user input', type: 'text' }] }],
        },
      })
      const editedAssistant = editedMessages.find(message => message.role === 'assistant')
      if (!editedAssistant)
        throw new Error('The edited assistant message was not persisted')

      const regenerationRequest = {
        conversationId: edited.conversationId,
        requestId: 'chat-fork-regenerate',
        sourceRunId: edited.runId,
      }
      const regenerated = await harness.invoke(
        'chat.regenerateAssistant',
        regenerationRequest,
      ) as LocalTurnStart
      expect(regenerated.branchId).not.toBe(edited.branchId)
      await expect(waitForTerminalRun(harness, regenerated.runId)).resolves.toMatchObject({
        status: 'completed',
      })
      const replayed = await harness.invoke(
        'chat.regenerateAssistant',
        regenerationRequest,
      ) as LocalTurnStart

      expect(replayed).toMatchObject({
        branchId: regenerated.branchId,
        conversationId: regenerated.conversationId,
        runId: regenerated.runId,
      })
      expect(provider.requests).toHaveLength(3)
      expect(JSON.stringify(provider.requests[1])).toContain('Edited user input')
      expect(JSON.stringify(provider.requests[2])).toContain('Edited user input')
      expect(conversations.listBranches(first.conversationId)).toHaveLength(3)
      expect(conversations.listBranchMessages(first.conversationId, first.branchId)
        .find(message => message.role === 'user')
        ?.content).toMatchObject({
        userContent: {
          body: [{ content: [{ text: 'Original user input', type: 'text' }] }],
        },
      })
    }
    finally {
      await service.dispose()
      await eventLog.close()
    }
  })

  it('executes a short once automation as a visible unbound conversation', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-automation-runtime-')))
    directories.push(root)
    const buddyHome = join(root, 'buddy')
    const builtinSkillsDirectory = join(root, 'skills')
    await mkdir(builtinSkillsDirectory, { recursive: true })
    const database = openTrackedDatabase(join(buddyHome, 'buddy.sqlite3'))
    const eventLog = createRunEventLog({
      conversationsDirectory: join(buddyHome, 'conversations'),
      database,
    })
    const provider = await startLocalModelProvider()
    const harness = createRuntimeRpcHarness({
      'offline-provider': { key: 'test-api-key', type: 'api_key' },
    })
    let now = Temporal.Instant.from('2026-08-24T01:00:00.000Z')
    const runtime = await startBuddyService({
      automationClock: { now: () => now },
      buddyHome,
      builtinSkillsDirectories: [builtinSkillsDirectory],
      database,
      eventLog,
      rpc: harness.rpc,
    })

    try {
      await harness.invoke('providers.upsertCustom', offlineProviderConfig(provider.baseUrl))
      const automation = await harness.invoke('automations.create', {
        draft: {
          model: {
            mode: 'pinned',
            modelId: 'offline-model',
            providerId: 'offline-provider',
            reasoning: null,
          },
          name: 'Short once integration',
          spaceId: null,
          prompt: 'Run the short once integration task',
          timing: {
            activeFrom: null,
            activeUntil: null,
            schedule: { kind: 'once', runAt: '2026-08-24T01:00:01.000Z' },
            timezone: 'Asia/Shanghai',
          },
        },
        requestId: 'create-short-once-integration',
      }) as LocalAutomation

      now = Temporal.Instant.from('2026-08-24T01:00:02.000Z')
      harness.notifyRuntime('scheduler.wake', { reason: 'resume' })
      const occurrence = await waitForAutomationOccurrence(harness, automation.id)

      expect(occurrence).toMatchObject({
        automationId: automation.id,
        automationName: 'Short once integration',
        automationRevision: 1,
        coalescedMissedCount: 0,
        effectiveStatus: 'completed',
        status: 'bound',
        triggerKind: 'scheduled',
      })
      expect(occurrence.conversationId).not.toBeNull()
      expect(occurrence.runId).not.toBeNull()
      const run = await harness.invoke('runs.get', { runId: occurrence.runId }) as LocalRun
      expect(run).toMatchObject({
        conversationId: occurrence.conversationId,
        approvalPolicy: 'policy' as const,
        executionProfile: 'workspace_write',
        purpose: 'automation',
        status: 'completed',
      })
      const conversation = await harness.invoke('conversations.get', {
        conversationId: occurrence.conversationId,
      }) as { id: string, origin?: string, spaceId: string | null }
      expect(conversation).toMatchObject({
        id: occurrence.conversationId,
        origin: 'automation',
        spaceId: null,
      })
      const recent = await harness.invoke('conversations.list', {}) as ReadonlyArray<{
        automationOccurrence: { occurrenceId: string } | null
        id: string
      }>
      expect(recent).toContainEqual(expect.objectContaining({
        automationOccurrence: expect.objectContaining({ occurrenceId: occurrence.id }),
        id: occurrence.conversationId,
      }))
      const notificationList = await harness.invoke('notifications.list', {}) as LocalNotificationList
      expect(notificationList).toMatchObject({
        items: [{
          action: {
            conversationId: occurrence.conversationId,
            runId: occurrence.runId,
            type: 'open-conversation',
          },
          attention: 'unseen',
          kind: 'automation.run.completed',
          payload: {
            automationId: automation.id,
            automationName: 'Short once integration',
            errorCode: null,
          },
        }],
        unseenCount: 1,
      })
      expect(provider.requests).toHaveLength(1)
    }
    finally {
      await runtime.dispose()
      await eventLog.close()
    }
  })
})

function assistant(text: string): AssistantMessage {
  return {
    api: 'anthropic-messages',
    content: [{ type: 'text', text }],
    model: 'claude-sonnet-4-5',
    provider: 'anthropic',
    role: 'assistant',
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: usage(10, 4),
  }
}

function usage(input: number, output: number): Usage {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.01, output: 0.02, total: 0.03 },
    input,
    output,
    totalTokens: input + output,
  }
}

function openTrackedDatabase(databasePath: string): DatabaseSync {
  const database = openBuddyDatabase({ databasePath })
  databases.push(database)
  return database
}

function offlineProviderConfig(baseUrl: string) {
  return {
    api: 'openai-completions',
    baseUrl,
    displayName: 'Offline integration provider',
    enabled: true,
    id: 'offline-provider',
    models: [{
      contextWindow: 16_384,
      id: 'offline-model',
      input: ['text', 'image'],
      maxTokens: 1_024,
      name: 'Offline model',
      reasoning: false,
    }],
  }
}

async function turnRequest(harness: RuntimeRpcHarness, input: {
  branchId?: string
  content: string
  conversationId?: string
  resourceIds?: readonly string[]
  requestId: string
}) {
  const initialContent = {
    ...createBuddyUserContent(input.content),
    panelResourceIds: [...(input.resourceIds ?? [])],
  }
  const opened = await harness.invoke('composerDrafts.open', {
    draftId: `draft-${input.requestId}`,
    initialContent,
    initialExecutionConfig: {
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
    },
    initialModelSelection: {
      modelId: 'offline-model',
      providerId: 'offline-provider',
      reasoning: null,
      serviceTier: null,
    },
    scope: input.conversationId && input.branchId
      ? {
          branchId: input.branchId,
          conversationId: input.conversationId,
          kind: 'conversation_branch',
        }
      : { kind: 'global' },
  }) as {
    draftId: string
    revision: number
  }
  const draft = await harness.invoke('composerDrafts.save', {
    content: initialContent,
    draftId: opened.draftId,
    executionConfig: {
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
    },
    expectedRevision: opened.revision,
    modelSelection: {
      modelId: 'offline-model',
      providerId: 'offline-provider',
      reasoning: null,
      serviceTier: null,
    },
  }) as {
    draftId: string
    revision: number
  }
  return {
    draftId: draft.draftId,
    expectedRevision: draft.revision,
    requestId: input.requestId,
  }
}

async function waitForTerminalRun(
  harness: RuntimeRpcHarness,
  runId: string,
): Promise<LocalTurnStart['run']> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = await harness.invoke('runs.get', { runId }) as LocalTurnStart['run']
    if (run.status !== 'queued' && run.status !== 'running')
      return run
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Run did not reach a terminal state: ${runId}`)
}

async function waitForAutomationOccurrence(
  harness: RuntimeRpcHarness,
  automationId: string,
): Promise<LocalAutomationOccurrencePage['items'][number]> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const page = await harness.invoke('automations.listOccurrences', {
      automationId,
      limit: 20,
    }) as LocalAutomationOccurrencePage
    const occurrence = page.items[0]
    if (
      occurrence?.runId
      && !['queued', 'running', 'awaiting_approval'].includes(occurrence.effectiveStatus)
    ) {
      return occurrence
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const remaining = await harness.invoke('automations.listOccurrences', { automationId, limit: 1 })
  throw new Error(`Automation occurrence did not reach a terminal state: ${JSON.stringify(remaining)}`)
}

function readDataImageUrls(request: Record<string, unknown> | undefined): string[] {
  const messages = Array.isArray(request?.messages) ? request.messages : []
  return messages.flatMap((message) => {
    const content = readRecord(message)?.content
    if (!Array.isArray(content))
      return []
    return content.flatMap((item) => {
      const imageUrl = readRecord(readRecord(item)?.image_url)?.url
      return typeof imageUrl === 'string' && imageUrl.startsWith('data:image/')
        ? [imageUrl]
        : []
    })
  })
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

interface RuntimeRpcHarness {
  invoke: (method: string, params: unknown) => Promise<unknown>
  notifyRuntime: (method: string, params: unknown) => void
  rpc: BuddyServiceRpcServer
}

function createRuntimeRpcHarness(
  initialCredentials: Readonly<Record<string, Credential>> = {},
  webPages: Readonly<Record<string, string>> = {},
): RuntimeRpcHarness {
  const handlers = new Map<string, Parameters<BuddyServiceRpcServer['onRequest']>[1]>()
  const notificationListeners = new Set<(method: string, params: unknown) => void>()
  const credentials = new Map(Object.entries(initialCredentials).map(([providerId, credential]) =>
    [providerId, structuredClone(credential)],
  ))
  const closed = new Emitter<void>(() => {})
  let isClosed = false
  const rpc = {
    get closed() { return isClosed },
    onDidClose: closed.event,
    close() {
      isClosed = true
      closed.fire()
    },
    notify() {},
    onNotification(listener: (method: string, params: unknown) => void) {
      notificationListeners.add(listener)
      return () => notificationListeners.delete(listener)
    },
    onRequest(method: string, handler: Parameters<BuddyServiceRpcServer['onRequest']>[1]) {
      handlers.set(method, handler)
      return () => handlers.delete(method)
    },
    async request(method: string, params: unknown, _timeout?: number | null, signal = new AbortController().signal, requestId?: string) {
      const input = params as {
        providerId?: string
        requestId?: string
        url?: string
      }
      if (method === 'extensions.agent.list' || method === 'extensions.skills.list' || method === 'host.extensions.shells.list')
        return Promise.resolve([])
      if (method === 'host.networkPermissions.get')
        return Promise.resolve(structuredClone(DEFAULT_NETWORK_PERMISSIONS))
      if ((method === 'host.web.authorize' || method === 'host.web.request') && input.url && input.url in webPages) {
        const authorize = handlers.get('runtime.network.authorize')
        if (!authorize)
          throw new Error('Network authorization handler is missing')
        const result = await authorize({ requestId, url: input.url, operation: 'access' }, signal)
        if (!(result as { ok: boolean }).ok)
          return { ok: false, code: 'WEB_URL_BLOCKED' }
      }
      if (method === 'host.web.authorize')
        return Promise.resolve(input.url && input.url in webPages ? { ok: true } : { ok: false, code: 'WEB_URL_BLOCKED' })
      if (method === 'host.web.request' && input.url && input.url in webPages) {
        queueMicrotask(() => {
          for (const listener of notificationListeners) {
            listener('host.web.chunk', { requestId: input.requestId, chunk: Buffer.from(webPages[input.url!]!).toString('base64') })
            listener('host.web.chunk', { requestId: input.requestId, done: true })
          }
        })
        return Promise.resolve({ ok: true, url: input.url, status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      }
      if (method === 'host.images.preferences')
        return Promise.resolve({})
      if (method === 'host.runtimePreferences.get')
        return Promise.resolve({ ...DEFAULT_RUNTIME_PREFERENCES, cacheWarming: 'off', codemode: 'off', modelRetryLimit: 3 })
      if (method === 'host.credentials.list') {
        return Promise.resolve({
          ok: true,
          providers: [...credentials].map(([providerId, credential]) => ({
            providerId,
            type: credential.type,
          })),
        })
      }
      if (method === 'host.credentials.read') {
        return Promise.resolve({
          ok: true,
          value: structuredClone(credentials.get(input.providerId ?? '') ?? null),
        })
      }
      return Promise.reject(new Error(`Unexpected host request: ${method}`))
    },
  } as unknown as BuddyServiceRpcServer
  return {
    async invoke(method, params) {
      const handler = handlers.get(method)
      if (!handler)
        throw new Error(`Runtime handler is unavailable: ${method}`)
      return handler(params)
    },
    notifyRuntime(method, params) {
      for (const listener of notificationListeners)
        listener(method, params)
    },
    rpc,
  }
}

interface LocalModelProvider {
  baseUrl: string
  requests: Array<Record<string, unknown>>
  errors: unknown[]
}

type LocalModelReply = { text: string } | { toolCall: { id: string, name: string, arguments: Record<string, unknown> } }
type LocalModelResponder = (payload: Record<string, unknown>) => Promise<LocalModelReply>

function toolNames(payload: Record<string, unknown>): string[] {
  return Array.isArray(payload.tools)
    ? payload.tools.flatMap((tool) => {
        const name = readRecord(readRecord(tool)?.function)?.name
        return typeof name === 'string' ? [name] : []
      })
    : []
}

async function startLocalModelProvider(respond?: LocalModelResponder): Promise<LocalModelProvider> {
  const requests: Array<Record<string, unknown>> = []
  const errors: unknown[] = []
  const server = createServer((request, response) => {
    void handleLocalModelRequest(request, response, requests, respond).catch((error) => {
      errors.push(error)
      response.writeHead(500).end('Controlled provider failed')
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, errors }
}

async function handleLocalModelRequest(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  requests: Array<Record<string, unknown>>,
  respond?: LocalModelResponder,
): Promise<void> {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end()
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  requests.push(payload)
  const reply = await respond?.(payload) ?? { text: `offline reply ${requests.length}` }
  const id = `chatcmpl-${requests.length}`
  const common = {
    created: 1_786_759_963,
    id,
    model: payload.model,
    object: 'chat.completion.chunk',
  }
  response.writeHead(200, {
    'cache-control': 'no-cache',
    'content-type': 'text/event-stream',
  })
  response.write(`data: ${JSON.stringify({
    ...common,
    choices: [{
      delta: { role: 'assistant', ...('text' in reply ? { content: reply.text } : { tool_calls: [{ index: 0, id: reply.toolCall.id, type: 'function', function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.arguments) } }] }) },
      finish_reason: null,
      index: 0,
    }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    ...common,
    choices: [{ delta: {}, finish_reason: 'text' in reply ? 'stop' : 'tool_calls', index: 0 }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    ...common,
    choices: [],
    usage: { completion_tokens: 4, prompt_tokens: 10, total_tokens: 14 },
  })}\n\n`)
  response.end('data: [DONE]\n\n')
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

async function startBuddyService(options: Omit<StartBuddyServiceOptions, 'platform'> & { rpc: BuddyServiceRpcServer }) {
  const { rpc, ...configuration } = options
  const service = await startService({ ...configuration, platform: createRpcRuntimePlatform(rpc) })
  service.connectClient('product', rpc)
  service.connectClient('management', rpc)
  return service
}
