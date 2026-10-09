import type { IncomingMessage, ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConnectorRepository } from '../../../storage/connectorRepository'
import { openBuddyDatabase } from '../../../storage/database'
import { McpClientSession } from '../McpClientSession'
import { McpConnectorService } from '../McpConnectorService'
import { loginMcpOAuth, McpOAuthProvider } from '../McpOAuthProvider'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse())
    await close()
})

async function serverFixture(options: { modern?: boolean, oauth?: boolean, denied?: 401 | 403, toolNames?: string[] } = {}) {
  const requests: Array<{ method: string, toolName?: string, authorization?: string, version?: string }> = []
  const registered: Record<string, unknown> = {}
  let annotations = { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
  let toolNames = options.toolNames ?? ['echo']
  let challenge = ''
  let base = ''
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.writeHead(500).end()
    })
  })
  function json(response: ServerResponse, body: unknown, status = 200) {
    response.writeHead(status, { 'content-type': 'application/json', 'MCP-Protocol-Version': options.modern ? '2026-07-28' : '2025-11-25' }).end(JSON.stringify(body))
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const chunks = []
    for await (const chunk of request)
      chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    const path = new URL(request.url!, base).pathname
    if (path.startsWith('/.well-known/') && !options.oauth)
      return response.writeHead(404).end()
    if (path.startsWith('/.well-known/oauth-protected-resource'))
      return json(response, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['read'] })
    if (path.startsWith('/.well-known/oauth-authorization-server')) {
      return json(response, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] })
    }
    if (path === '/register') {
      Object.assign(registered, JSON.parse(body))
      return json(response, { ...registered, client_id: 'fixture-client', token_endpoint_auth_method: 'none' }, 201)
    }
    if (path === '/token') {
      const parameters = new URLSearchParams(body)
      expect(parameters.get('resource')).toBe(`${base}/mcp`)
      if (parameters.get('grant_type') === 'authorization_code')
        expect(createHash('sha256').update(parameters.get('code_verifier')!).digest('base64url')).toBe(challenge)
      return json(response, { access_token: 'fixture-access', token_type: 'Bearer', refresh_token: 'fixture-refresh', expires_in: 3600 })
    }
    if (path !== '/mcp')
      return response.writeHead(404).end()
    if (options.denied)
      return json(response, { error: 'credentials_rejected' }, options.denied)
    if (options.oauth && request.headers.authorization !== 'Bearer fixture-access') {
      response.setHeader('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read"`)
      return json(response, { error: 'unauthorized' }, 401)
    }
    if (request.method !== 'POST')
      return response.writeHead(405).end()
    const message = JSON.parse(body)
    requests.push({ method: message.method, toolName: message.params?.name, authorization: request.headers.authorization, version: request.headers['mcp-protocol-version'] as string | undefined })
    if (message.id === undefined)
      return response.writeHead(202).end()
    const result = message.method === 'server/discover' && options.modern
      ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture', version: '1.0' } } }
      : message.method === 'initialize' && !options.modern
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0' } }
        : message.method === 'tools/list'
          ? { ttlMs: 60000, cacheScope: 'private', tools: toolNames.map(name => ({ name, annotations, inputSchema: { type: 'object', properties: { value: { type: 'string' } } } })) }
          : message.method === 'tools/call'
            ? { content: [{ type: 'text', text: message.params.arguments.value }] }
            : null
    json(response, result ? { jsonrpc: '2.0', id: message.id, result: options.modern ? { ...result, resultType: 'complete' } : result } : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
  }
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  base = `http://127.0.0.1:${address.port}`
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { base, requests, registered, setTools: (names: string[]) => {
    toolNames = names
  }, changeAnnotations: () => {
    annotations = { readOnlyHint: false, openWorldHint: true, destructiveHint: true }
  }, challenge: (value: string) => {
    challenge = value
  } }
}

function session(base: string, credential = { type: 'http' as const, bearerToken: 'fixture-manual' }) {
  const client = new McpClientSession({
    config: { id: 'http', name: 'HTTP', enabled: true, credentialRef: 'http', transport: 'streamable-http', url: `${base}/mcp` },
    credential,
  })
  cleanup.push(() => client.close())
  return client
}

describe('mCP HTTP and authorization', () => {
  it('keeps global tool ownership through reconnects, catalog changes and cached restart', async () => {
    const maps = await serverFixture({ toolNames: ['routing__search'] })
    const routing = await serverFixture({ toolNames: ['search'] })
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const repository = createConnectorRepository(database)
    const service = new McpConnectorService({ connectors: repository, secrets: { read: async () => null, write: async () => {}, delete: async () => {} } })
    cleanup.push(async () => {
      await service.close()
      database.close()
    })
    await service.upsert({ id: 'maps-id', name: 'Maps', toolNamespace: 'maps', url: `${maps.base}/mcp`, transport: 'streamable-http', enabled: false, credentialRef: null })
    await service.setEnabled('maps-id', true)
    await service.test('maps-id')
    const originalName = service.getTools().tools[0]!.name
    expect(originalName).toBe('mcp__maps__routing__search')
    await service.upsert({ id: 'routing-id', name: 'Routing', toolNamespace: 'maps__routing', url: `${routing.base}/mcp`, transport: 'streamable-http', enabled: false, credentialRef: null })
    await service.setEnabled('routing-id', true)
    await service.test('routing-id')
    const snapshot = service.getTools()
    const mapsName = snapshot.disclosure.find(policy => policy.source.id === 'maps-id')!.tools[0]!.name
    const routingName = snapshot.disclosure.find(policy => policy.source.id === 'routing-id')!.tools[0]!.name
    expect(mapsName).toBe(originalName)
    expect(routingName).not.toBe(originalName)
    expect(snapshot.tools).toHaveLength(2)
    expect(snapshot.classifications.size).toBe(2)
    for (const [name, id, remoteName] of [[mapsName, 'maps-id', 'routing__search'], [routingName, 'routing-id', 'search']] as const) {
      expect(snapshot.classifications.get(name)?.approval?.reuse?.operation).toEqual([id, expect.any(Number), remoteName])
      const tool = snapshot.tools.find(tool => tool.name === name)!
      expect(await tool.execute('call', { value: id }, undefined, undefined, {} as never)).toMatchObject({ content: [{ type: 'text', text: id }] })
    }
    expect(maps.requests.filter(request => request.method === 'tools/call')).toMatchObject([{ toolName: 'routing__search' }])
    expect(routing.requests.filter(request => request.method === 'tools/call')).toMatchObject([{ toolName: 'search' }])
    await service.setEnabled('maps-id', false)
    expect(service.getTools().tools.map(tool => tool.name)).toEqual([routingName])
    await service.setEnabled('maps-id', true)
    await service.test('maps-id')
    maps.setTools([])
    await service.test('maps-id')
    expect(service.getTools().tools.map(tool => tool.name)).toEqual([routingName])
    maps.setTools(['routing__search'])
    await service.test('maps-id')
    const rebuilt = service.getTools()
    expect(rebuilt.tools.map(tool => tool.name)).toEqual(snapshot.tools.map(tool => tool.name))
    await service.setEnabled('maps-id', false)
    await service.close()
    const preview = new McpConnectorService({ connectors: repository, secrets: { read: async () => null, write: async () => {}, delete: async () => {} } })
    try {
      expect(preview.getTools().tools.map(tool => tool.name)).toEqual([routingName])
      expect(preview.state('routing-id').status).toBe('idle')
    }
    finally {
      await preview.close()
    }
  })

  it('keeps a key-authenticated connection usable when browser sign-in is requested accidentally', async () => {
    const fixture = await serverFixture()
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    let opened = false
    const service = new McpConnectorService({ connectors: createConnectorRepository(database), secrets: { read: async () => null, write: async () => {}, delete: async () => {} }, openExternal: async () => {
      opened = true
    } })
    cleanup.push(async () => {
      await service.close()
      database.close()
    })
    await service.upsert({ id: 'key', name: 'Maps', url: `${fixture.base}/mcp?key=fixture-key`, transport: 'streamable-http', enabled: false, credentialRef: null })
    expect(service.state('key')).toMatchObject({ status: 'disabled', updatedAt: null })
    expect(await service.test('key')).toMatchObject({ status: 'ready', authorization: null, toolCount: 1 })
    expect(service.state('key').status).toBe('disabled')
    expect(service.getTools().tools).toEqual([])
    await service.setEnabled('key', true)
    await vi.waitUntil(() => service.state('key').status === 'ready')
    const requestsBeforeLogin = fixture.requests.length
    service.login('key')
    await vi.waitUntil(() => fixture.requests.length > requestsBeforeLogin && service.state('key').status === 'ready')
    expect(opened).toBe(false)
    const tool = service.getTools().tools[0]!
    expect(await tool.execute('call', { value: 'route' }, undefined, undefined, {} as never)).toMatchObject({ content: [{ type: 'text', text: 'route' }], details: { isError: false } })
    expect(await loginMcpOAuth({ url: `${fixture.base}/mcp?key=fixture-key`, signal: new AbortController().signal, openExternal: async () => {
      opened = true
    } })).toBeNull()
    expect(opened).toBe(false)
  })

  it.each([401, 403] as const)('reports rejected credentials without inventing browser sign-in for HTTP %s', async (denied) => {
    const fixture = await serverFixture({ denied })
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const service = new McpConnectorService({ connectors: createConnectorRepository(database), secrets: { read: async () => null, write: async () => {}, delete: async () => {} } })
    cleanup.push(async () => {
      await service.close()
      database.close()
    })
    await service.upsert({ id: 'manual', name: 'Manual credentials', url: `${fixture.base}/mcp`, transport: 'streamable-http', enabled: false, credentialRef: null })
    expect(await service.test('manual')).toMatchObject({ authorization: 'credentials', errorCode: denied === 401 ? 'MCP_AUTHENTICATION_REQUIRED' : 'MCP_ACCESS_DENIED' })
  })

  it.each([true, false])('negotiates modern=%s and carries manual credentials across discovery and execution', async (modern) => {
    const fixture = await serverFixture({ modern })
    const client = session(fixture.base)
    expect(await client.listTools()).toMatchObject([{ name: 'echo' }])
    expect(await client.callTool('echo', { value: 'hello' })).toMatchObject({ content: [{ type: 'text', text: 'hello' }] })
    expect(fixture.requests.every(request => request.authorization === 'Bearer fixture-manual')).toBe(true)
    expect(fixture.requests.some(request => request.method === 'initialize')).toBe(!modern)
  })

  it('blocks an old read-only definition after a server changes its side effects', async () => {
    const fixture = await serverFixture({ modern: true })
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const service = new McpConnectorService({ connectors: createConnectorRepository(database), secrets: { read: async () => null, write: async () => {}, delete: async () => {} } })
    cleanup.push(async () => {
      await service.close()
      database.close()
    })
    await service.upsert({ id: 'http', name: 'HTTP', url: `${fixture.base}/mcp`, transport: 'streamable-http', enabled: false, credentialRef: null })
    await service.setEnabled('http', true)
    await vi.waitUntil(() => service.state('http').status === 'ready')
    const snapshot = service.getTools()
    const tool = snapshot.tools[0]!
    expect(snapshot.classifications.get(tool.name)).toMatchObject({ access: 'network', requireApproval: true })
    fixture.changeAnnotations()
    expect(await tool.execute('call', { value: 'hello' }, undefined, undefined, {} as never)).toMatchObject({ details: { code: 'MCP_TOOL_CHANGED' } })
    expect(fixture.requests.some(request => request.method === 'tools/call')).toBe(false)
  })

  it('preserves existing credentials when a browser authorization is denied', async () => {
    const fixture = await serverFixture({ modern: true, oauth: true })
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    let secret: unknown = { type: 'http', bearerToken: 'previous-fixture-token' }
    const service = new McpConnectorService({
      connectors: createConnectorRepository(database),
      secrets: {
        read: async () => secret as never,
        write: async (_id, value) => { secret = value },
        delete: async () => { secret = null },
      },
      openExternal: async (value) => {
        const url = new URL(value)
        const callback = new URL(url.searchParams.get('redirect_uri')!)
        callback.searchParams.set('state', url.searchParams.get('state')!)
        callback.searchParams.set('error', 'access_denied')
        await fetch(callback)
      },
    })
    cleanup.push(async () => {
      await service.close()
      database.close()
    })
    await service.upsert({ id: 'http', name: 'HTTP', url: `${fixture.base}/mcp`, transport: 'streamable-http', enabled: false, credentialRef: null })
    await service.saveCredential('http', secret as never)
    expect(await service.test('http')).toMatchObject({ authorization: 'oauth', status: 'needs_auth' })
    expect(service.state('http')).toMatchObject({ authorization: 'oauth', status: 'disabled', errorCode: 'MCP_AUTHENTICATION_REQUIRED' })
    service.login('http')
    await vi.waitUntil(() => service.state('http').errorCode === 'MCP_AUTHENTICATION_FAILED')
    expect(secret).toEqual({ type: 'http', bearerToken: 'previous-fixture-token' })
  })

  it('does not start authorization while the connection target is being saved', async () => {
    const fixture = await serverFixture({ modern: true, oauth: true })
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const saving = Promise.withResolvers<void>()
    const finishSave = Promise.withResolvers<void>()
    let opened = false
    let secret: unknown = null
    const service = new McpConnectorService({
      connectors: createConnectorRepository(database),
      secrets: {
        read: async () => secret as never,
        delete: async () => { secret = null },
        write: async (_id, value) => {
          secret = value
          if (value.type === 'http' && value.bearerToken === 'new-target-token') {
            saving.resolve()
            await finishSave.promise
          }
        },
      },
      openExternal: async () => { opened = true },
    })
    cleanup.push(async () => {
      finishSave.resolve()
      await service.close()
      database.close()
    })
    const config = { id: 'http', name: 'HTTP', url: `${fixture.base}/mcp`, transport: 'streamable-http' as const, enabled: false, credentialRef: null }
    await service.upsert(config)
    expect(await service.test('http')).toMatchObject({ authorization: 'oauth' })
    const pendingSave = service.save({ config: { ...config, url: 'https://new.example/mcp' }, credential: { mode: 'replace', value: { type: 'http', bearerToken: 'new-target-token' } } })
    await saving.promise
    service.login('http')
    finishSave.resolve()
    await pendingSave
    expect(opened).toBe(false)
    expect(secret).toEqual({ type: 'http', bearerToken: 'new-target-token' })
    expect(service.list()[0]?.url).toBe('https://new.example/mcp')
  })

  it('completes loopback OAuth with state, PKCE and issuer binding', async () => {
    const fixture = await serverFixture({ modern: true, oauth: true })
    let callbackUrl = ''
    const credential = await loginMcpOAuth({ url: `${fixture.base}/mcp`, signal: new AbortController().signal, openExternal: async (value) => {
      const url = new URL(value)
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      fixture.challenge(url.searchParams.get('code_challenge')!)
      const callback = new URL(url.searchParams.get('redirect_uri')!)
      callbackUrl = callback.href
      callback.searchParams.set('code', 'fixture-code')
      callback.searchParams.set('state', 'wrong-state')
      expect((await fetch(callback)).status).toBe(400)
      callback.searchParams.set('state', url.searchParams.get('state')!)
      callback.searchParams.set('iss', fixture.base)
      expect((await fetch(callback)).status).toBe(200)
    } })
    expect(credential).not.toBeNull()
    if (!credential)
      throw new Error('Expected OAuth tokens')
    expect(credential.tokens).toMatchObject({ access_token: 'fixture-access', issuer: fixture.base })
    expect(credential.clients[fixture.base]?.client_id).toBe('fixture-client')
    const provider = new McpOAuthProvider({ credential, signal: new AbortController().signal, save: async () => {} })
    expect(provider.tokens({ issuer: 'https://another.example' })).toBeUndefined()
    expect(provider.clientInformation({ issuer: 'https://another.example' })).toBeUndefined()
    expect(provider.tokens()?.access_token).toBe('fixture-access')
    await expect(fetch(callbackUrl)).rejects.toThrow()
    await expect(provider.redirectToAuthorization(new URL('https://example.com'))).rejects.toMatchObject({ code: 'MCP_AUTHENTICATION_REQUIRED' })
  })

  it('closes the callback listener when sign-in is cancelled', async () => {
    const fixture = await serverFixture({ modern: true, oauth: true })
    const controller = new AbortController()
    let callbackUrl = ''
    await expect(loginMcpOAuth({ url: `${fixture.base}/mcp`, signal: controller.signal, openExternal: async (value) => {
      callbackUrl = new URL(value).searchParams.get('redirect_uri')!
      controller.abort()
    } })).rejects.toMatchObject({ code: 'MCP_AUTHENTICATION_CANCELLED' })
    await expect(fetch(callbackUrl)).rejects.toThrow()
  })
})
