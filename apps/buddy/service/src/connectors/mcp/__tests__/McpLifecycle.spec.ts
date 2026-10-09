import type { McpConnectorServiceOptions } from '../McpConnectorService'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConnectorRepository } from '../../../storage/connectorRepository'
import { openBuddyDatabase } from '../../../storage/database'
import { McpConnectorService } from '../McpConnectorService'

const fixtureServer = fileURLToPath(new URL('./fixtures/process-contract-server.mjs', import.meta.url))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close()))
})

function fixture(options: Partial<McpConnectorServiceOptions> = {}) {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const repository = createConnectorRepository(database)
  const service = new McpConnectorService({ connectors: repository, secrets: { read: async () => null, write: async () => {}, delete: async () => {} }, ...options })
  cleanup.push(async () => {
    await service.close()
    database.close()
  })
  return { service, repository }
}
const config = { id: 'lifecycle', name: 'Original name', command: process.execPath, args: [fixtureServer], cwd: null, enabled: false, credentialRef: null, transport: 'stdio' as const }

async function ready(service: McpConnectorService) {
  await service.upsert(config)
  await service.confirmExecution(config.id)
  await service.setEnabled(config.id, true)
  await vi.waitUntil(() => service.state(config.id).status === 'ready')
}

describe('mCP global lifecycle', () => {
  it('removes disabled tools from discovery and blocks previously captured calls, reaping the process', async () => {
    const { service } = fixture()
    await ready(service)
    const snapshot = service.getTools()
    const runtime = snapshot.tools.find(tool => tool.label.endsWith('runtime'))!
    const result = await runtime.execute('1', {}, undefined, undefined, {} as never)
    const pid = JSON.parse((result.content[0] as { text: string }).text).pid as number
    await service.setEnabled(config.id, false)
    expect(service.getTools().tools).toHaveLength(0)
    expect(snapshot.available(runtime.name)).toBe(false)
    expect(() => process.kill(pid, 0)).toThrow()
    expect(await runtime.execute('2', {}, undefined, undefined, {} as never)).toMatchObject({ details: { code: 'MCP_CONNECTOR_DISABLED' } })
    expect(service.list()[0]?.name).toBe(config.name)
  })

  it('keeps live connections and catalogs across metadata changes while rejecting stale tool policies', async () => {
    const { service, repository } = fixture()
    await ready(service)
    const snapshot = service.getTools()
    const names = snapshot.tools.map(tool => tool.name)
    const runtime = snapshot.tools.find(tool => tool.label.endsWith('runtime'))!
    const result = await runtime.execute('initial', {}, undefined, undefined, {} as never)
    const pid = JSON.parse((result.content[0] as { text: string }).text).pid as number
    const catalog = repository.readCatalog(config.id)
    const revision = service.resourceRevisions()
    await service.save({ config: { ...config, name: 'Renamed', enabled: true }, credential: { mode: 'clear' } })
    expect(service.state(config.id).status).toBe('ready')
    expect(service.getTools().tools.map(tool => tool.name)).toEqual(names)
    expect(repository.readCatalog(config.id)).toEqual(catalog)
    expect(service.resourceRevisions()).not.toEqual(revision)
    expect(() => process.kill(pid, 0)).not.toThrow()
    for (const toolExposure of ['direct', 'codemode', 'hidden', 'deferred'] as const) {
      await service.save({ config: { ...config, name: 'Renamed', enabled: true, toolExposure }, credential: { mode: 'clear' } })
      expect(service.state(config.id).status).toBe('ready')
      expect(repository.readCatalog(config.id)).toEqual(catalog)
      expect(() => process.kill(pid, 0)).not.toThrow()
      const current = service.getTools()
      expect(current.tools.map(tool => tool.name)).toEqual(names)
      expect(current.tools.every(tool => tool.exposure === (toolExposure === 'codemode' ? 'deferred' : toolExposure))).toBe(true)
      if (toolExposure !== 'deferred') {
        expect(snapshot.available(runtime.name)).toBe(false)
        expect(await runtime.execute('stale', {}, undefined, undefined, {} as never)).toMatchObject({ details: { code: 'MCP_CONNECTOR_DISABLED' } })
      }
      if (toolExposure === 'hidden') {
        const hidden = current.tools.find(tool => tool.name === runtime.name)!
        expect(current.available(hidden.name)).toBe(false)
        expect(await hidden.execute('hidden', {}, undefined, undefined, {} as never)).toMatchObject({ details: { code: 'MCP_CONNECTOR_DISABLED' } })
      }
    }
    const resumed = await runtime.execute('resumed', {}, undefined, undefined, {} as never)
    expect(JSON.parse((resumed.content[0] as { text: string }).text).pid).toBe(pid)
    await service.close()
    const read = vi.fn(async () => null)
    const preview = new McpConnectorService({ connectors: repository, secrets: { read, write: async () => {}, delete: async () => {} } })
    expect(preview.getTools().tools.map(tool => tool.name)).toEqual(names)
    expect(read).not.toHaveBeenCalled()
    expect(preview.state(config.id).status).toBe('idle')
    await preview.close()
  })

  it('reaps a temporary test connection without enabling it', async () => {
    const { service } = fixture()
    await service.upsert(config)
    await service.confirmExecution(config.id)
    const states: string[] = []
    service.onDidChangeConnection((event) => {
      if (event.type === 'state')
        states.push(event.snapshot.status)
    })
    const result = await service.test(config.id)
    expect(result).toMatchObject({ status: 'ready', toolCount: 4 })
    expect(Reflect.set(result, 'status', 'error')).toBe(false)
    expect(service.state(config.id)).toMatchObject({ status: 'disabled', errorCode: null, toolCount: 4 })
    expect(states.at(-1)).toBe('disabled')
    expect(states).not.toContain('ready')
    expect(service.list()[0]?.enabled).toBe(false)
    expect(service.getTools().tools).toHaveLength(0)
  })
})
