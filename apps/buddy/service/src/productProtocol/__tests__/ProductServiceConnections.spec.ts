import type { DesktopOpenResult } from '../../../../shared/service/localServiceProtocol'
import type { RuntimePlatform } from '../../platform/RuntimePlatform'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buddySettingsSchema } from '../../../../shared/buddies/buddySettings'
import { DEFAULT_NETWORK_PERMISSIONS } from '../../../../shared/permissions/networkPermissions'
import { DEFAULT_RUNTIME_PREFERENCES, runtimePreferencesRpc } from '../../../../shared/runtime/runtimePreferences'
import { startBuddyService } from '../../BuddyService'
import { SqliteRunEventLog } from '../../events/SqliteRunEventLog'
import { createRpcRuntimePlatform } from '../../platform/createRpcRuntimePlatform'
import { createServiceConnection } from '../../rpc/__tests__/serviceConnectionHarness'
import { createBuddyRepository } from '../../storage/buddyRepository'
import { openBuddyMigrationCandidate } from '../../storage/database'

describe('product service transport ownership', () => {
  it('keeps legacy reads while requiring product admission for SQLite writes', async () => {
    const { service, peer, close } = await fixture()
    try {
      service.connectClient('product', peer.server)
      service.connectClient('management', peer.server)
      expect(await peer.client.request('conversations.list', {})).toEqual([])
      expect(await peer.client.request('composerResources.list', { draftId: 'missing' })).toEqual([])
      for (const method of ['composerDrafts.save', 'chat.startTurn', 'conversations.rename', 'approvals.resolve', 'approvals.approve', 'questions.answer', 'questions.cancel', 'questions.retry'])
        await expect(peer.client.request(method, {})).rejects.toMatchObject({ data: { code: 'METHOD_NOT_AVAILABLE' } })
      expect(await peer.client.request('questions.list', { conversationId: 'missing', branchId: 'missing' })).toEqual([])
      const frames: unknown[] = []
      peer.client.onNotification((method, params) => {
        if (method === 'product.frame')
          frames.push(JSON.parse((params as { frame: string }).frame))
      })
      await peer.client.request('product.exchange', { frame: JSON.stringify({ jsonrpc: '2.0', id: 'initialize', method: 'initialize', params: { protocol: { major: 1, minMinor: 1, maxMinor: 1 }, client: { kind: 'desktop', version: 'test' }, supportedContentKinds: [], supportedReviewKinds: [] } }) })
      expect(frames).toMatchObject([{ result: { profileId: 'test-profile', capabilities: expect.arrayContaining(['chat.getNewTaskDefaults']) } }])
      await peer.client.request('product.exchange', { frame: JSON.stringify({ jsonrpc: '2.0', id: 'info', method: 'service.info', params: {} }) })
      expect(Object.keys((frames.at(-1) as { result: object }).result)).toEqual(['name'])
    }
    finally {
      await close()
    }
  })
  it('reads current Desktop task defaults without granting the reader write access', async () => {
    const f = await fixture()
    try {
      let hostMode: string = 'read_only'
      f.peer.client.onRequest(runtimePreferencesRpc.getDefaultPermissionMode, () => hostMode)
      const reader = await f.connect('remote-reader', 'reader')
      expect(reader.result()).toMatchObject({ protocol: { major: 1, minor: 1 }, capabilities: expect.arrayContaining(['chat.getNewTaskDefaults', 'conversations.getRecentWindow', 'conversations.getTurnWindow', 'conversations.listActivitySteps', 'conversations.listOrderedActivitySteps', 'conversations.readLiveText']) })
      await reader.send('conversations.getTurnWindow', { conversationId: 'missing', branchId: 'missing' })
      expect(reader.error()).toMatchObject({ code: 'OBJECT_DELETED' })
      for (const [mode, executionProfile, approvalPolicy] of [
        ['read_only', 'read_only', 'policy'],
        ['manual_approval', 'workspace_write', 'manual'],
        ['policy_approval', 'workspace_write', 'policy'],
        ['full_access', 'full_access', 'policy'],
      ] as const) {
        hostMode = mode
        await reader.send('chat.getNewTaskDefaults', {})
        expect(reader.result()).toEqual({ executionConfig: { executionProfile, approvalPolicy }, modelSelection: null, modelDisplayName: null })
      }
      await reader.send('conversations.setPermissionSettings', {})
      expect(reader.error()).toMatchObject({ code: 'NOT_AUTHORIZED' })
      await reader.send('chat.getNewTaskDefaults', { conversationId: 'existing' })
      expect(reader.error()).toMatchObject({ code: 'INVALID_PARAMS' })
      hostMode = 'invalid'
      await reader.send('chat.getNewTaskDefaults', {})
      expect(reader.error()).toMatchObject({ code: 'INTERNAL_ERROR', acceptance: 'not_accepted' })
    }
    finally {
      await f.close()
    }
  })

  it('returns the concrete name for the same buddy or application default as getInputSelection', async () => {
    const f = await fixture({ getDefaultPermissionMode: async () => 'manual_approval' })
    try {
      f.service.connectClient('management', f.peer.server)
      const modelId = 'shared-model'
      for (const [id, name] of [['application', 'Application model'], ['actor', 'Actor model']]) {
        await f.peer.client.request('providers.createCustom', { id, displayName: `${id} provider`, api: 'openai-completions', authentication: 'none', baseUrl: 'https://example.test/v1', enabled: true, models: [{ id: modelId, name }] })
      }
      const reader = await f.connect('remote-reader', 'reader')
      const executionConfig = { executionProfile: 'workspace_write', approvalPolicy: 'manual' }
      const application = { modelId, providerId: 'application', reasoning: null }
      await f.peer.client.request('providers.setDefaultModel', { model: application })
      await reader.send('chat.getNewTaskDefaults', {})
      expect(reader.result()).toEqual({ executionConfig, modelSelection: { ...application, serviceTier: null }, modelDisplayName: 'Application model' })

      const buddies = createBuddyRepository(f.database)
      const buddy = buddies.get(buddies.state().defaultBuddyId)
      const modelSelection = { modelId, providerId: 'actor', reasoning: 'high', serviceTier: 'priority' } as const
      const updated = buddies.update({ buddyId: buddy.id, expectedRevision: buddy.revision, settings: buddySettingsSchema.parse({ ...buddy.settings, model: modelSelection }) })
      await reader.send('chat.getNewTaskDefaults', {})
      expect(reader.result()).toEqual({ executionConfig, modelSelection, modelDisplayName: 'Actor model' })
      await reader.send('providers.getInputSelection', {})
      expect(reader.result()).toEqual({ modelSelection })

      const missing = { ...modelSelection, providerId: 'removed-provider' }
      buddies.update({ buddyId: buddy.id, expectedRevision: updated.revision, settings: buddySettingsSchema.parse({ ...updated.settings, model: missing }) })
      await reader.send('chat.getNewTaskDefaults', {})
      expect(reader.result()).toEqual({ executionConfig, modelSelection: missing, modelDisplayName: null })
    }
    finally {
      await f.close()
    }
  })

  it('omits the optional query when the platform cannot supply Desktop defaults', async () => {
    const f = await fixture({ getDefaultPermissionMode: undefined })
    try {
      const reader = await f.connect('remote-reader', 'reader')
      expect(reader.result()).toMatchObject({ capabilities: expect.not.arrayContaining(['chat.getNewTaskDefaults']) })
      await reader.send('chat.getNewTaskDefaults', {})
      expect(reader.error()).toMatchObject({ code: 'METHOD_NOT_AVAILABLE' })
    }
    finally {
      await f.close()
    }
  })

  it('shares actor admission across connections and drains every actor before stopping', async () => {
    const opened: Array<ReturnType<typeof Promise.withResolvers<DesktopOpenResult>> & { signal?: AbortSignal }> = []
    const visible = { accepted: true, uiReady: true, targetVisible: true, visible: true, focused: true }
    const f = await fixture({ openDesktop: async (_intent, signal) => {
      const request = { ...Promise.withResolvers<DesktopOpenResult>(), signal }
      opened.push(request)
      return request.promise
    } })
    try {
      const identity = f.service.commands!.identity
      const owner = String(f.database.prepare('SELECT local_actor_id FROM storage_profile').get()!.local_actor_id)
      f.database.exec('INSERT INTO storage_actors VALUES (\'remote-test\', \'device\', \'active\', \'2026-11-14T00:00:00.000Z\')')
      const first = await f.connect(owner)
      const second = await f.connect(owner)
      const remote = await f.connect('remote-test')
      const envelope = { dataGeneration: identity.dataGeneration, expectedServiceInstanceId: identity.serviceInstanceId, commandId: 'shared-command', intent: { kind: 'settings' } }
      const lookup = { dataGeneration: identity.dataGeneration, commandId: envelope.commandId }
      const pending = first.send('desktop.open', envelope)
      await expect.poll(() => opened.length).toBe(1)
      await second.send('commands.get', lookup)
      expect(second.result()).toEqual({ lookup: 'pending' })
      await remote.send('commands.get', lookup)
      expect(remote.result()).toEqual({ lookup: 'not_found' })
      first.connection.close()
      const reconnected = await f.connect(owner)
      await reconnected.send('commands.get', lookup)
      expect(reconnected.result()).toEqual({ lookup: 'pending' })
      const duplicate = reconnected.send('desktop.open', envelope)
      opened[0]!.resolve(visible)
      await Promise.all([pending, duplicate])
      expect(opened).toHaveLength(1)
      await second.send('commands.get', lookup)
      expect(second.result()).toMatchObject({ lookup: 'decided', receipt: { decision: 'accepted', result: { desktop: visible } } })
      const separate = remote.send('desktop.open', envelope)
      await expect.poll(() => opened.length).toBe(2)
      opened[1]!.resolve(visible)
      await separate
      expect(f.database.prepare('SELECT actor_id FROM command_receipts WHERE command_id = ? ORDER BY actor_id').all(envelope.commandId)).toEqual([{ actor_id: owner }, { actor_id: 'remote-test' }].sort((a, b) => a.actor_id.localeCompare(b.actor_id)))
      const interrupted = remote.send('desktop.open', { ...envelope, commandId: 'shutdown-command' })
      await expect.poll(() => opened.length).toBe(3)
      expect(f.service.prepareIdleShutdown()).toBe(false)
      let stopped = false
      const stopping = f.service.dispose().then(() => {
        stopped = true
      })
      expect(opened[2]!.signal?.aborted).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(stopped).toBe(false)
      opened[2]!.resolve(visible)
      await Promise.all([interrupted, stopping])
      expect(f.database.prepare('SELECT command_id FROM command_receipts WHERE command_id = ?').all('shutdown-command')).toEqual([])
    }
    finally {
      for (const request of opened) request.resolve(visible)
      await f.close()
    }
  })
})

async function fixture(platform?: Partial<RuntimePlatform>) {
  const root = await mkdtemp(join(tmpdir(), 'lexora-product-peers-'))
  const buddyHome = join(root, 'buddy')
  const database = openBuddyMigrationCandidate({ databasePath: join(buddyHome, 'buddy.sqlite3') })
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  const events = new SqliteRunEventLog({ database })
  const peer = createServiceConnection()
  for (const method of ['extensions.agent.list', 'extensions.skills.list', 'host.extensions.shells.list'])
    peer.client.onRequest(method, () => [])
  peer.client.onRequest('host.networkPermissions.get', () => structuredClone(DEFAULT_NETWORK_PERMISSIONS))
  peer.client.onRequest('host.images.preferences', () => ({}))
  peer.client.onRequest('host.runtimePreferences.get', () => ({ ...DEFAULT_RUNTIME_PREFERENCES, cacheWarming: 'off', codemode: 'off' }))
  peer.client.onRequest('host.credentials.list', () => ({ ok: true, providers: [] }))
  peer.client.onRequest('host.credentials.read', () => ({ ok: true, value: null }))
  const service = await startBuddyService({ buddyHome, database, eventLog: events, platform: { ...createRpcRuntimePlatform(peer.server), ...platform }, builtinSkillsDirectories: [], productIdentity: { serviceId: 'test-service', profileId: 'test-profile' } })
  return {
    database,
    peer,
    service,
    async connect(actorId: string, role: 'reader' | 'owner' = 'owner') {
      const owner = String(database.prepare('SELECT local_actor_id FROM storage_profile').get()!.local_actor_id)
      const frames: Array<{ result?: unknown, error?: unknown }> = []
      const connection = service.createProductConnection({
        context: { ...service.commands!.identity, serviceId: 'test-service', profileId: 'test-profile', connectionId: randomUUID(), clientSessionId: randomUUID(), deviceId: actorId, ownerPrincipalId: owner, credentialId: actorId, grantGeneration: '0', role },
        trustedPrincipal: { actorId, assertAuthenticated() {} },
        assertCurrent() {},
        send: (frame) => {
          frames.push(JSON.parse(frame))
          return true
        },
        close() {},
      })
      let requestId = 0
      const send = (method: string, params: unknown) => connection.receive(JSON.stringify({ jsonrpc: '2.0', id: String(++requestId), method, params }))
      await send('initialize', { protocol: { major: 1, minMinor: 1, maxMinor: 1 }, client: { kind: 'mobile', version: 'test' }, supportedContentKinds: [], supportedReviewKinds: [] })
      return { send, connection, result: () => frames.at(-1)?.result, error: () => frames.at(-1)?.error }
    },
    async close() {
      await service.dispose()
      await events.close()
      peer.close()
      database.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
