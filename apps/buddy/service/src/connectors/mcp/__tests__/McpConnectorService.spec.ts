import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { DatabaseSync } from 'node:sqlite'
import type { ConnectorCredential } from '../../../../../shared/connectors/connectorCredentials'
import type { McpConnectionEvent, McpConnectorEvent } from '../mcpEvents'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PermissionEngine } from '../../../permissions/PermissionEngine'
import { createConnectorRepository } from '../../../storage/connectorRepository'
import { openBuddyDatabase } from '../../../storage/database'
import { createMcpToolName } from '../createMcpTools'
import { McpConnectorService } from '../McpConnectorService'
import { classifyMcpTool } from '../mcpToolContract'
import { observeMcpDiagnostics } from '../observeMcpEvents'

const services: McpConnectorService[] = []
const databases: DatabaseSync[] = []
const directories: string[] = []
const fixtureServer = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url))

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()))
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('mcpConnectorService', () => {
  it('drains an accepted credential and configuration commit while retaining the source for observers', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const repository = createConnectorRepository(database)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const secrets = new Map<string, ConnectorCredential>()
    const service = new McpConnectorService({ connectors: repository, secrets: { read: async id => secrets.get(id) ?? null, delete: async (id) => {
      secrets.delete(id)
    }, write: async (id, value) => {
      entered.resolve()

      await release.promise

      secrets.set(id, value)
    } } })
    services.push(service)
    const events: McpConnectorEvent[] = []
    service.onDidChange(event => events.push(event))
    const accepted = service.save({ config: httpConfig('https://example.test/mcp'), credential: { mode: 'replace', value: { type: 'http', bearerToken: 'fixture-token' } } })
    await entered.promise
    let stopped = false
    const stopping = service.quiesce().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    release.resolve()
    const record = await accepted
    await stopping
    expect(repository.findById(record.id)?.credentialRef).toBe(record.id)
    expect(secrets.has(record.id)).toBe(true)
    expect(events.map(event => event.type)).toEqual(['credential', 'configuration'])
    expect(JSON.stringify(events)).not.toContain('fixture-token')
    await expect(service.setEnabled(record.id, true)).rejects.toMatchObject({ code: 'MCP_SERVER_UNAVAILABLE' })
  })

  it('publishes no configuration or generation changes for unchanged disabled settings', async () => {
    const fixture = await createFixture()
    const configuration = httpConfig('https://example.test/mcp')
    const first = await fixture.service.upsert(configuration)
    const facts: McpConnectorEvent[] = []
    fixture.service.onDidChange(event => facts.push(event))
    fixture.events.length = 0
    expect(await fixture.service.upsert(configuration)).toEqual(first)
    expect(await fixture.service.setEnabled('remote', false)).toEqual(first)
    await fixture.service.clearCredential('remote')
    expect(facts).toEqual([])
    expect(fixture.events).toEqual([])
  })

  it('records credential compensation without publishing a failed SQL change or secret contents', async () => {
    const fixture = createAtomicSaveFailureFixture()
    const facts: McpConnectorEvent[] = []
    const diagnostics: unknown[] = []
    fixture.service.onDidChange(event => facts.push(event))
    observeMcpDiagnostics(fixture.service, event => diagnostics.push(event))
    await expect(fixture.service.save({ config: httpConfig('https://second.example.com/mcp'), credential: { mode: 'replace', value: { type: 'http', bearerToken: 'private-token' } } })).rejects.toThrow('database unavailable')
    expect(facts.map(event => [event.type, event.type === 'credential' ? event.status : event.type])).toEqual([['credential', 'written'], ['credential', 'restored']])
    expect(JSON.stringify(diagnostics)).not.toContain('private-token')
    expect(JSON.stringify(diagnostics)).not.toContain('example.com')
  })

  it('lists and executes a real stdio server while classifying side effects for Buddy approval', async () => {
    const fixture = await createFixture()
    await fixture.service.upsert(stdioConfig(false))
    await expect(fixture.service.setEnabled('fixture', true))
      .rejects
      .toMatchObject({ code: 'MCP_EXECUTION_CONFIRMATION_REQUIRED' })
    await fixture.service.confirmExecution('fixture')
    await fixture.service.confirmExecution('fixture')
    await fixture.service.setEnabled('fixture', true)
    await fixture.service.test('fixture')

    const result = await fixture.service.getTools()
    expect(result.tools.map(tool => tool.name)).toEqual([
      createMcpToolName('fixture', 'echo_read'),
      createMcpToolName('fixture', 'write_remote'),
    ])
    const echo = result.tools[0]
    if (!echo)
      throw new Error('echo tool was not loaded')
    const output = await executeTool(echo, { text: 'hello' })
    expect(output).toMatchObject({
      content: [{ type: 'text', text: 'echo:hello' }],
      isError: false,
    })

    const root = await mkdtemp(join(tmpdir(), 'lexora-buddy-mcp-policy-'))
    directories.push(root)
    const policy = new PermissionEngine()
    const readClassification = classifyMcpTool(result.classifications, {
      toolName: result.tools[0]!.name,
    })!
    const writeClassification = classifyMcpTool(result.classifications, {
      toolName: result.tools[1]!.name,
    })!
    expect(writeClassification.requireApproval).toBe(true)
    await expect(policy.decide({
      approvalPolicy: 'policy',
      approvalAvailable: true,
      arguments: { text: 'hello' },
      cwd: root,
      owner: { id: 'conversation-1', kind: 'conversation' },
      profile: 'workspace_write',
      grants: [{ canonicalRoot: root, grantId: 'workspace-1', kind: 'workspace' as const, root }],
      ...readClassification,
      toolName: createMcpToolName('fixture', 'echo_read'),
    })).resolves.toMatchObject({ kind: 'mcp', type: 'ask' })
    await expect(policy.decide({
      approvalPolicy: 'policy',
      approvalAvailable: true,
      arguments: { text: 'hello' },
      cwd: root,
      owner: { id: 'conversation-1', kind: 'conversation' },
      profile: 'workspace_write',
      grants: [{ canonicalRoot: root, grantId: 'workspace-1', kind: 'workspace' as const, root }],
      ...writeClassification,
      toolName: createMcpToolName('fixture', 'write_remote'),
    })).resolves.toMatchObject({ kind: 'mcp', type: 'ask' })
    expect(fixture.secrets.values.size).toBe(0)
    await fixture.service.close()
  })

  it('keeps secrets out of config and reports a crashed server without failing the service', async () => {
    const fixture = await createFixture()
    await fixture.service.upsert({ ...stdioConfig(false), args: [fixtureServer, '--exit-soon'] })
    await fixture.service.confirmExecution('fixture')
    await fixture.service.saveCredential('fixture', {
      env: { FIXTURE_TOKEN: 'secret-value' },
      type: 'stdio',
    })
    await fixture.service.confirmExecution('fixture')
    await fixture.service.setEnabled('fixture', true)
    await fixture.service.test('fixture')
    const tools = await fixture.service.getTools()
    expect(tools.tools).toHaveLength(2)
    expect(JSON.stringify(fixture.service.list())).not.toContain('secret-value')

    await vi.waitUntil(() => fixture.events.some(event => (
      event.type === 'state' && event.snapshot.errorCode === 'MCP_SERVER_DISCONNECTED'
    )))
    const result = await executeTool(tools.tools[0]!, { text: 'hello' })
    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'echo:hello' }],
      isError: false,
    })
    await fixture.service.close()
  })

  it('reports a missing command without letting context previews retry it', async () => {
    const fixture = await createFixture(2)
    await fixture.service.upsert({ ...stdioConfig(false), command: '/lexora/does-not-exist' })
    await fixture.service.confirmExecution('fixture')
    expect(await fixture.service.test('fixture')).toMatchObject({ errorCode: 'MCP_COMMAND_NOT_FOUND' })
    expect(fixture.service.getTools().tools).toEqual([])
    expect(fixture.service.getTools().tools).toEqual([])
    expect(fixture.service.state('fixture').errorCode).toBe('MCP_COMMAND_NOT_FOUND')
  })

  it('allows public HTTP endpoints while rejecting plaintext secret fields and URL credentials', async () => {
    const fixture = await createFixture()
    await expect(fixture.service.upsert({
      ...stdioConfig(false),
      env: { TOKEN: 'plaintext' },
    } as never)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(fixture.service.upsert({
      credentialRef: null,
      enabled: false,
      id: 'remote',
      name: 'Remote',
      transport: 'streamable-http',
      url: 'http://example.com/mcp',
    })).resolves.toMatchObject({ id: 'remote', url: 'http://example.com/mcp' })
    await expect(fixture.service.upsert({
      credentialRef: null,
      enabled: false,
      id: 'remote',
      name: 'Remote',
      transport: 'streamable-http',
      url: 'http://user:secret@example.com/mcp',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('creates one connector session while credential loading is in flight', async () => {
    const fixture = await createFixture()
    await fixture.service.upsert(stdioConfig(false))
    await fixture.service.confirmExecution('fixture')
    await fixture.service.saveCredential('fixture', { env: { TOKEN: 'secret' }, type: 'stdio' })
    await fixture.service.confirmExecution('fixture')
    await fixture.service.setEnabled('fixture', true)
    await fixture.service.test('fixture')
    fixture.secrets.read.mockClear()

    const [first, second] = await Promise.all([
      fixture.service.getTools(),
      fixture.service.getTools(),
    ])

    expect(first.tools).toHaveLength(2)
    expect(second.tools).toHaveLength(2)
    expect(fixture.secrets.read).not.toHaveBeenCalled()
    await fixture.service.close()
  })

  it('restores the previous secret when saving its SQLite reference fails', async () => {
    const fixture = createCredentialFailureFixture()

    await expect(fixture.service.saveCredential('fixture', {
      env: { TOKEN: 'new-secret' },
      type: 'stdio',
    })).rejects.toThrow('database unavailable')

    expect(fixture.secret).toEqual({ env: { TOKEN: 'old-secret' }, type: 'stdio' })
  })

  it('keeps the previous secret when clearing its SQLite reference fails', async () => {
    const fixture = createCredentialFailureFixture()

    await expect(fixture.service.clearCredential('fixture'))
      .rejects
      .toThrow('database unavailable')

    expect(fixture.secret).toEqual({ env: { TOKEN: 'old-secret' }, type: 'stdio' })
  })

  it('keeps the secret when the connector record was not removed', async () => {
    const fixture = createCredentialFailureFixture()

    await expect(fixture.service.remove('fixture')).resolves.toBe(false)

    expect(fixture.secret).toEqual({ env: { TOKEN: 'old-secret' }, type: 'stdio' })
  })

  it('rejects keeping a credential when the HTTP target changes', async () => {
    const fixture = await createFixture()
    await fixture.service.upsert(httpConfig('https://first.example.com/mcp'))
    await fixture.service.saveCredential('remote', {
      bearerToken: 'first-secret',
      type: 'http',
    })
    fixture.secrets.read.mockClear()

    await expect(fixture.service.save({
      config: httpConfig('https://second.example.com/mcp'),
      credential: { mode: 'keep' },
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

    expect(fixture.service.list()[0]).toMatchObject({
      credentialRef: 'remote',
      url: 'https://first.example.com/mcp',
    })
    expect(fixture.secrets.values.get('remote')).toEqual({
      bearerToken: 'first-secret',
      type: 'http',
    })
    expect(fixture.secrets.read).not.toHaveBeenCalled()
  })

  it('rolls back a replaced credential when the atomic connector save fails', async () => {
    const fixture = createAtomicSaveFailureFixture()

    await expect(fixture.service.save({
      config: httpConfig('https://second.example.com/mcp'),
      credential: {
        mode: 'replace',
        value: { bearerToken: 'new-secret', type: 'http' },
      },
    })).rejects.toThrow('database unavailable')

    expect(fixture.record.url).toBe('https://first.example.com/mcp')
    expect(fixture.secret).toEqual({ bearerToken: 'old-secret', type: 'http' })
  })

  it('does not roll back a committed credential when session invalidation fails', async () => {
    const fixture = await createFixture()
    await fixture.service.upsert(httpConfig('https://first.example.com/mcp'))
    await fixture.service.saveCredential('remote', {
      bearerToken: 'old-secret',
      type: 'http',
    })
    fixture.service.onDidChange(() => {
      throw new Error('session disposal failed')
    })

    await expect(fixture.service.save({
      config: httpConfig('https://second.example.com/mcp'),
      credential: {
        mode: 'replace',
        value: { bearerToken: 'new-secret', type: 'http' },
      },
    })).resolves.toMatchObject({ url: 'https://second.example.com/mcp' })

    expect(fixture.service.list()[0]?.url).toBe('https://second.example.com/mcp')
    expect(fixture.secrets.values.get('remote')).toEqual({
      bearerToken: 'new-secret',
      type: 'http',
    })
  })
})

function executeTool(tool: ToolDefinition, parameters: Record<string, unknown>) {
  return tool.execute('test-tool-call', parameters, undefined, undefined, {} as never)
}

function stdioConfig(enabled: boolean) {
  return {
    args: [fixtureServer],
    command: process.execPath,
    credentialRef: null,
    cwd: null,
    enabled,
    id: 'fixture',
    name: 'Local Fixture',
    transport: 'stdio' as const,
  }
}

function httpConfig(url: string) {
  return {
    credentialRef: null,
    enabled: false,
    id: 'remote',
    name: 'Remote',
    transport: 'streamable-http' as const,
    url,
  }
}

async function createFixture(maxReconnectAttempts?: number) {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const values = new Map<string, ConnectorCredential>()
  const events: McpConnectionEvent[] = []
  const observerFailures: unknown[] = []
  const read = vi.fn(async (id: string) => {
    await new Promise(resolve => setImmediate(resolve))
    return values.get(id) ?? null
  })
  const service = new McpConnectorService({
    connectors: createConnectorRepository(database),
    onListenerError: error => observerFailures.push(error),
    maxReconnectAttempts,
    secrets: {
      async delete(id) {
        values.delete(id)
      },
      read,
      async write(id, credential) {
        values.set(id, credential)
      },
    },
  })
  service.onDidChangeConnection(event => events.push(event))
  services.push(service)
  return {
    events,
    observerFailures,
    secrets: { read, values },
    service,
  }
}

function createCredentialFailureFixture() {
  let secret: ConnectorCredential | null = { env: { TOKEN: 'old-secret' }, type: 'stdio' }
  const record = {
    args: [],
    command: process.execPath,
    createdAt: '2026-08-14T00:00:00.000Z',
    credentialRef: 'fixture',
    cwd: null,
    enabled: false,
    id: 'fixture',
    name: 'Fixture',
    transport: 'stdio' as const,
    executionConfirmedAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    url: null,
  }
  const service = new McpConnectorService({
    connectors: {
      readCatalog: () => null,
      saveCatalog: () => {},
      clearCatalog: () => {},
      findById: () => record,
      list: () => [record],
      remove: () => false,
      upsert: () => {
        throw new Error('database unavailable')
      },
    },
    secrets: {
      async delete() {
        secret = null
      },
      async read() {
        return secret
      },
      async write(_id, value) {
        secret = value
      },
    },
  })
  return {
    get secret() {
      return secret
    },
    service,
  }
}

function createAtomicSaveFailureFixture() {
  let secret: ConnectorCredential | null = { bearerToken: 'old-secret', type: 'http' }
  const record = {
    args: null,
    command: null,
    createdAt: '2026-08-14T00:00:00.000Z',
    credentialRef: 'remote',
    cwd: null,
    enabled: false,
    id: 'remote',
    name: 'Remote',
    transport: 'streamable-http' as const,
    executionConfirmedAt: null,
    updatedAt: '2026-08-14T00:00:00.000Z',
    url: 'https://first.example.com/mcp',
  }
  const service = new McpConnectorService({
    connectors: {
      readCatalog: () => null,
      saveCatalog: () => {},
      clearCatalog: () => {},
      findById: () => record,
      list: () => [record],
      remove: () => false,
      upsert: () => {
        throw new Error('database unavailable')
      },
    },
    secrets: {
      async delete() {
        secret = null
      },
      async read() {
        return secret
      },
      async write(_id, value) {
        secret = value
      },
    },
  })
  return {
    record,
    get secret() {
      return secret
    },
    service,
  }
}
