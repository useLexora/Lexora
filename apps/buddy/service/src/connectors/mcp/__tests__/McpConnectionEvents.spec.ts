import type { DatabaseSync } from 'node:sqlite'
import type { McpConnectionEvent } from '../mcpEvents'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConnectorRepository } from '../../../storage/connectorRepository'
import { openBuddyDatabase } from '../../../storage/database'
import { createMcpTools } from '../createMcpTools'
import { McpClientSession } from '../McpClientSession'
import { McpConnectionManager } from '../McpConnectionManager'

const databases: DatabaseSync[] = []
const managers: McpConnectionManager[] = []
const tools = [{ name: 'lookup', description: 'private description', inputSchema: { type: 'object' as const, properties: { query: { type: 'string' } } } }]

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()))
  for (const database of databases.splice(0))
    database.close()
  vi.restoreAllMocks()
})

describe('mcpConnectionEvents', () => {
  it('publishes effective pause and resume availability after updating the manager', async () => {
    const fixture = createFixture()
    await fixture.manager.refresh('fixture')
    const observed: boolean[] = []
    fixture.manager.onDidChange((event) => {
      if (event.type === 'availability')
        observed.push(fixture.manager.available(event.connectorId, event.generation))
    })
    fixture.manager.pause('fixture')
    fixture.manager.pause('fixture')
    await fixture.manager.reset('fixture')
    fixture.manager.resume('fixture')
    fixture.manager.resume('fixture')
    expect(fixture.events.filter(event => event.type === 'availability')).toEqual([
      expect.objectContaining({ available: false, generation: 0 }),
      expect.objectContaining({ available: true, generation: 1 }),
    ])
    expect(observed).toEqual([false, true])
  })

  it('accepts a durable catalog independently of observers and does not lend its schema to tool consumers', async () => {
    const fixture = createFixture()
    fixture.manager.onDidChange((event) => {
      if (event.type === 'catalog')
        throw new Error('observer failed after commit')
    })
    await fixture.manager.refresh('fixture')
    expect(fixture.manager.state('fixture')).toMatchObject({ status: 'ready', errorCode: null, toolCount: 1 })
    expect(JSON.parse(fixture.repository.readCatalog('fixture')!.toolsJson)[0].name).toBe('lookup')
    const accepted = fixture.events.find(event => event.type === 'catalog')!
    expect(accepted).toMatchObject({ generation: 0, type: 'catalog' })
    const catalog = fixture.manager.catalog('fixture')
    expect(Reflect.set(catalog[0]!, 'description', 'changed')).toBe(false)
    expect(Reflect.set(catalog[0]!.inputSchema.properties as object, 'query', {})).toBe(false)
    const bound = createMcpTools({ tools: catalog, generation: 0, serverId: 'fixture', serverName: 'Fixture', callTool: async () => ({ content: [] }) })
    const parameters = bound.tools[0]!.parameters
    Reflect.set(parameters, 'properties', { replacement: {} })
    expect(fixture.manager.catalog('fixture')[0]?.inputSchema.properties).toEqual({ query: { type: 'string' } })
    await fixture.manager.refresh('fixture')
    expect(fixture.events.filter(event => event.type === 'catalog')).toHaveLength(1)
    expect(fixture.observerFailures).toHaveLength(1)
  })

  it('does not accept a catalog produced by a reset connection generation', async () => {
    const fixture = createFixture()
    const entered = Promise.withResolvers<void>()
    const delayed = Promise.withResolvers<typeof tools>()
    fixture.listTools.mockImplementationOnce(() => {
      entered.resolve()
      return delayed.promise
    })
    const refresh = fixture.manager.refresh('fixture')
    await entered.promise
    const reset = fixture.manager.reset('fixture')
    delayed.resolve(tools)
    await Promise.all([refresh, reset])
    expect(fixture.repository.readCatalog('fixture')).toBeNull()
    expect(fixture.events.filter(event => event.type === 'catalog')).toEqual([])
    expect(fixture.manager.generation('fixture')).toBe(1)
    await fixture.manager.refresh('fixture')
    expect(fixture.events.filter(event => event.type === 'catalog')).toEqual([expect.objectContaining({ generation: 1 })])
  })

  it('rejects a captured tool when its exposure changes during catalog refresh', async () => {
    const fixture = createFixture()
    await fixture.manager.refresh('fixture')
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    fixture.listTools.mockImplementationOnce(async () => {
      entered.resolve()
      await released.promise
      return tools
    })
    vi.spyOn(McpClientSession.prototype, 'callTool').mockResolvedValue({ content: [{ type: 'text', text: 'completed' }] })
    const call = fixture.manager.callTool('fixture', { generation: fixture.manager.generation('fixture'), exposure: 'deferred' }, tools[0]!, {})
    const rejected = expect(call).rejects.toMatchObject({ code: 'MCP_CONNECTOR_DISABLED' })
    try {
      await entered.promise
      fixture.repository.upsert({ ...fixture.repository.findById('fixture')!, toolExposure: 'hidden' })
      released.resolve()
      await rejected
      expect(fixture.manager.state('fixture').status).toBe('ready')
      expect(fixture.manager.catalog('fixture')).toEqual(tools)
    }
    finally {
      released.resolve()
      await call.catch(() => {})
    }
  })

  it('preserves the accepted catalog if persistence fails before a replacement commits', async () => {
    const fixture = createFixture()
    await fixture.manager.refresh('fixture')
    fixture.events.length = 0
    fixture.listTools.mockResolvedValueOnce([{ name: 'replacement', inputSchema: { type: 'object' } }])
    vi.spyOn(fixture.repository, 'saveCatalog').mockImplementationOnce(() => {
      throw new Error('storage unavailable')
    })
    await expect(fixture.manager.refresh('fixture')).rejects.toThrow('storage unavailable')
    expect(fixture.manager.catalog('fixture')[0]?.name).toBe('lookup')
    expect(JSON.parse(fixture.repository.readCatalog('fixture')!.toolsJson)[0].name).toBe('lookup')
    expect(fixture.events.some(event => event.type === 'catalog')).toBe(false)
    expect(fixture.manager.state('fixture').status).toBe('error')
  })

  it('publishes one acceptance batch with captured generations during reentrant reset', async () => {
    const fixture = createFixture()
    let reset: Promise<void> | undefined
    fixture.manager.onDidChange((event) => {
      if (event.type === 'state' && event.snapshot.status === 'ready' && !reset)
        reset = fixture.manager.reset('fixture')
    })
    await fixture.manager.refresh('fixture')
    await reset
    const changes = fixture.events.filter(event => event.type === 'catalog' || event.type === 'generation')
    expect(changes.map(event => [event.type, event.generation])).toEqual([['catalog', 0], ['generation', 1]])
    expect(changes[0]!.revision).toBeLessThan(changes[1]!.revision)
    expect(fixture.manager.generation('fixture')).toBe(1)
  })
})

function createFixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const repository = createConnectorRepository(database)
  repository.upsert({ id: 'fixture', name: 'Fixture', transport: 'streamable-http', url: 'https://example.test/mcp?secret=private', args: null, command: null, cwd: null, enabled: true, credentialRef: null, executionConfirmedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
  const listTools = vi.spyOn(McpClientSession.prototype, 'listTools').mockResolvedValue(tools)
  vi.spyOn(McpClientSession.prototype, 'close').mockResolvedValue()
  const observerFailures: unknown[] = []
  const manager = new McpConnectionManager({ repository, readCredential: async () => null, authProvider: () => undefined, config: record => ({ id: record.id, name: record.name, transport: 'streamable-http', url: record.url!, enabled: record.enabled, credentialRef: record.credentialRef }), onListenerError: error => observerFailures.push(error) })
  managers.push(manager)
  const events: McpConnectionEvent[] = []
  manager.onDidChange(event => events.push(event))
  return { manager, repository, events, observerFailures, listTools }
}
