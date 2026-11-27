import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { SessionResourceChange } from '../../../agent/resources/SessionResourceReconciler'
import type { SkillEvent } from '../../../skills/skillEvents'
import type { McpConnectionEvent } from '../mcpEvents'
import { describe, expect, it, vi } from 'vitest'
import { Emitter, filterEvent } from '../../../../../shared/events/Emitter'
import { SessionResourceReconciler } from '../../../agent/resources/SessionResourceReconciler'
import { BuddySessionRegistry } from '../../../agent/sessions/BuddySessionRegistry'
import { createConnectorRepository } from '../../../storage/connectorRepository'
import { openBuddyDatabase } from '../../../storage/database'
import { McpClientSession } from '../McpClientSession'
import { McpConnectorService } from '../McpConnectorService'
import { McpSessionResourceConsumer } from '../McpSessionResourceConsumer'

const identity = { approvalPolicy: 'policy' as const, branchId: 'branch', canonicalRoot: '/workspace', conversationId: 'conversation', executionProfile: 'workspace_write' as const, grantRevision: 'grant', resourceRevision: 'resources', skillRevision: 'skills', scratchRoot: '/scratch', sessionMode: 'interactive' as const, spaceId: null }
const config = { id: 'fixture', name: 'Fixture', transport: 'streamable-http' as const, url: 'https://example.test/mcp', enabled: true, credentialRef: null }

const catalog = [{ name: 'lookup', inputSchema: { type: 'object' as const } }]

interface InstalledSession {
  readonly tools: readonly ToolDefinition[]
  closed: boolean
  shutdown: () => Promise<void>
}

describe('mcpSessionResources', () => {
  it.each(['enable', 'exposure'] as const)('defers a connector %s update until run release and reports the versions actually installed by the next session', async (operation) => {
    const fixture = createFixture()
    const { service, sessions, consumer, applied } = fixture
    const gate = Promise.withResolvers<void>()
    let run: Promise<void> | undefined
    try {
      await service.upsert({ ...config, enabled: operation === 'exposure' })
      await service.prepareForRun(new AbortController().signal)
      const original = service.resourceRevisions()
      const first = await sessions.getOrCreate(identity, null, fixture.createSession)
      await consumer.whenIdle()
      run = sessions.withConversationRun(identity, 'run', undefined, () => gate.promise)
      await vi.waitFor(() => expect(sessions.getActiveRun(identity)?.runId).toBe('run'))
      if (operation === 'enable')
        await service.setEnabled('fixture', true)
      else
        await service.upsert({ ...config, toolExposure: 'codemode' })
      await service.prepareForRun(new AbortController().signal)
      await consumer.whenIdle()
      expect(sessions.snapshot()[0]?.invalidationPending).toBe(true)
      expect(first.session.closed).toBe(false)
      expect(applied).toEqual([expect.objectContaining({ capabilityRevisions: original })])
      gate.resolve()
      await run
      expect(first.session.closed).toBe(true)
      const installed = service.getTools().resourceRevisions!
      expect(installed).not.toEqual(original)
      await sessions.getOrCreate(identity, null, fixture.createSession)
      await consumer.whenIdle()
      expect(sessions.snapshot()[0]?.invalidationPending).toBe(false)
      expect(applied.at(-1)).toMatchObject({ type: 'applied', capabilityRevisions: installed })
      expect(installed).toEqual([expect.objectContaining({ source: 'connector', id: 'fixture' })])
    }
    finally {
      gate.resolve()
      await run
      await fixture.dispose()
    }
  })

  it('rejects an in-flight binding across a connection test and calls the unchanged tool in the next run of the same session identity', async () => {
    const fixture = createFixture()
    const { service, sessions, consumer } = fixture
    const remoteCall = vi.spyOn(McpClientSession.prototype, 'callTool').mockResolvedValue({ content: [{ type: 'text', text: 'lookup result' }] })
    try {
      await service.upsert(config)
      await service.prepareForRun(new AbortController().signal)
      const changes: McpConnectionEvent[] = []
      service.onDidChangeConnection(event => changes.push(event))
      const first = await sessions.withConversationRun(identity, 'first', undefined, async () => {
        const binding = await sessions.getOrCreate(identity, '/session', fixture.createSession)
        const refreshEntered = Promise.withResolvers<void>()
        const refreshReleased = Promise.withResolvers<typeof catalog>()
        fixture.listTools.mockImplementationOnce(() => {
          refreshEntered.resolve()
          return refreshReleased.promise
        })
        const stale = binding.session.tools[0]!.execute('stale', {}, undefined, undefined, {} as never)
        await refreshEntered.promise
        const retest = service.test(config.id)
        try {
          await vi.waitFor(() => expect(changes.some(event => event.type === 'generation')).toBe(true))
        }
        finally {
          refreshReleased.resolve(catalog)
        }
        expect(await retest).toMatchObject({ status: 'ready', toolCount: 1 })
        expect(await stale).toMatchObject({ isError: true, details: { code: 'MCP_CONNECTOR_DISABLED' } })
        expect(remoteCall).not.toHaveBeenCalled()
        expect(changes.filter(event => event.type === 'catalog')).toEqual([])
        await consumer.whenIdle()
        expect(sessions.snapshot()[0]?.invalidationPending).toBe(true)
        expect(binding.session.closed).toBe(false)
        return binding
      })
      expect(first.session.closed).toBe(true)
      await sessions.withConversationRun(identity, 'next', undefined, async () => {
        const next = await sessions.getOrCreate(identity, '/session', fixture.createSession)
        expect(next.resourceRevisions).not.toEqual(first.resourceRevisions)
        expect(next.session.tools[0]!.name).toBe(first.session.tools[0]!.name)
        const result = await next.session.tools[0]!.execute('next', {}, undefined, undefined, {} as never)
        expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'lookup result' }] })
      })
    }
    finally {
      await fixture.dispose()
    }
  })

  it.each(['target change', 'failed reset', 'failed configuration write'] as const)('rebuilds a session prepared with a paused catalog after %s once its run is released', async (operation) => {
    const fixture = createFixture()
    const { service, sessions, consumer } = fixture
    const closeEntered = Promise.withResolvers<void>()
    const closeReleased = Promise.withResolvers<void>()
    const runEntered = Promise.withResolvers<void>()
    const runReleased = Promise.withResolvers<void>()
    const warmed = Promise.withResolvers<void>()
    let mutation: Promise<unknown> | undefined
    let run: Promise<void> | undefined
    try {
      await service.upsert(config)
      await service.prepareForRun(new AbortController().signal)
      expect(service.getTools().tools).toHaveLength(1)
      const changes: McpConnectionEvent[] = []
      service.onDidChangeConnection((event) => {
        changes.push(event)
        if (event.type === 'state' && event.snapshot.status === 'ready')
          warmed.resolve()
      })
      fixture.close.mockImplementationOnce(async () => {
        closeEntered.resolve()
        await closeReleased.promise
        if (operation === 'failed reset')
          throw new Error('connection cleanup failed')
      })
      if (operation === 'failed configuration write') {
        vi.spyOn(fixture.repository, 'upsert').mockImplementationOnce(() => {
          throw new Error('configuration write failed')
        })
      }
      const result = service.upsert({ ...config, url: 'https://changed.example.test/mcp' }).then(
        () => ({ status: 'fulfilled' as const }),
        error => ({ status: 'rejected' as const, error }),
      )
      mutation = result
      await closeEntered.promise
      await service.prepareForRun(new AbortController().signal)
      const first = await sessions.getOrCreate(identity, null, fixture.createSession)
      await consumer.whenIdle()
      expect(first.session.tools).toEqual([])
      expect(sessions.snapshot()[0]).toMatchObject({ resourceRevisions: [], invalidationPending: false })
      run = sessions.withConversationRun(identity, 'run', undefined, () => {
        runEntered.resolve()
        return runReleased.promise
      })
      await runEntered.promise
      closeReleased.resolve()
      expect(await result).toMatchObject({ status: operation === 'target change' ? 'fulfilled' : 'rejected' })
      await warmed.promise
      await consumer.whenIdle()
      expect(fixture.repository.findById('fixture')?.url).toBe(operation === 'target change' ? 'https://changed.example.test/mcp' : config.url)
      expect(changes.filter(event => event.type === 'catalog')).toMatchObject(operation === 'target change' ? [{ tools: [] }, { tools: [{ name: 'lookup' }] }] : [])
      expect(service.getTools().tools).toHaveLength(1)
      expect(sessions.snapshot()[0]?.invalidationPending).toBe(true)
      expect(sessions.getActiveRun(identity)?.runId).toBe('run')
      expect(first.session.closed).toBe(false)
      runReleased.resolve()
      await run
      expect(first.session.closed).toBe(true)
      const next = await sessions.getOrCreate(identity, '/session', fixture.createSession)
      await consumer.whenIdle()
      expect(next).not.toBe(first)
      expect(next.session.tools.map(tool => tool.name)).toEqual(service.getTools().tools.map(tool => tool.name))
      expect(sessions.snapshot()[0]).toMatchObject({ resourceRevisions: service.resourceRevisions(), invalidationPending: false })
    }
    finally {
      closeReleased.resolve()
      runReleased.resolve()
      await mutation
      await run
      await fixture.dispose()
    }
  })
})

function createFixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const repository = createConnectorRepository(database)
  const service = new McpConnectorService({ connectors: repository, secrets: { read: async () => null, write: async () => {}, delete: async () => {} } })
  const listTools = vi.spyOn(McpClientSession.prototype, 'listTools').mockResolvedValue(catalog)
  const close = vi.spyOn(McpClientSession.prototype, 'close').mockResolvedValue()
  const source = new Emitter<SkillEvent>(() => {})
  const resolution = { revision: 'skills', skills: [], references: [], paths: [], readRoots: [], diagnostics: [] }
  const sessions = new BuddySessionRegistry<InstalledSession>()
  const resources = new SessionResourceReconciler({ sessions, skills: { quiesce: async () => {}, onDidCommitInstallation: filterEvent(source.event, (event): event is Extract<SkillEvent, { type: 'installation' }> => event.type === 'installation'), onDidChangeResources: filterEvent(source.event, (event): event is Extract<SkillEvent, { type: 'resources' }> => event.type === 'resources'), loadForSpace: async () => resolution, resourceSnapshots: () => [{ spaceId: null, resolution }] } })
  const consumer = new McpSessionResourceConsumer({ service, sessions, resources })
  const applied: SessionResourceChange[] = []
  resources.onDidChange((event) => {
    if (event.type === 'applied')
      applied.push(event)
  })
  return {
    repository,
    service,
    sessions,
    consumer,
    applied,
    listTools,
    close,
    createSession: async () => {
      const tools = service.getTools()
      const session: InstalledSession = { tools: tools.tools, closed: false, shutdown: async () => {
        session.closed = true
      } }
      return { piSessionFile: '/session', resourceRevisions: tools.resourceRevisions, session }
    },
    dispose: async () => {
      await consumer.dispose()
      await resources.dispose()
      await sessions.dispose()
      await service.close()
      source.dispose()
      database.close()
      vi.restoreAllMocks()
    },
  }
}
