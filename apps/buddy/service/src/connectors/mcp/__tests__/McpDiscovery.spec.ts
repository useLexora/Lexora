import type { Api, AssistantMessage, Context, JsonObject, Model } from '@earendil-works/pi-ai'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { expect, it, vi } from 'vitest'
import { createEstimatedContextUsage } from '../../../agent/context/contextUsageBreakdown'
import { createCodemodeCapability } from '../../../agent/extensions/codemodeExtension'
import { createToolDiscoveryCapability } from '../../../agent/extensions/discovery/toolDiscoveryExtension'
import { createToolPolicyExtension } from '../../../agent/extensions/toolPolicyExtension'
import { createIsolatedBuddyContextSnapshot, createIsolatedBuddySession } from '../../../agent/sessions/__tests__/isolatedBuddySession'
import { ToolAuthorizationService } from '../../../permissions/ToolAuthorizationService'
import { createConnectorRepository } from '../../../storage/connectorRepository'
import { openBuddyDatabase } from '../../../storage/database'
import { McpConnectorService } from '../McpConnectorService'
import { createMcpCapability } from '../mcpExtension'

function reply(model: Model<Api>, call?: { name: string, arguments: JsonObject }) {
  const message: AssistantMessage = {
    api: model.api,
    model: model.id,
    provider: model.provider,
    role: 'assistant',
    timestamp: Date.now(),
    stopReason: call ? 'toolUse' : 'stop',
    content: call ? [{ type: 'toolCall', id: `call-${Date.now()}`, ...call }] : [{ type: 'text', text: 'Done' }],
    usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message }))
  return stream
}

it.each(['search', 'codemode'] as const)('invokes MCP through %s with complete results and per-call approval', async (mode) => {
  const routes = Array.from({ length: 4000 }, (_, id) => ({ id, summary: `route-${id}-${'x'.repeat(40)}` }))
  const calls: unknown[] = []
  const catalogRequested = Promise.withResolvers<void>()
  const catalogReady = Promise.withResolvers<void>()
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    const chunks = []
    for await (const chunk of request)
      chunks.push(chunk)
    const message = JSON.parse(Buffer.concat(chunks).toString())
    if (message.method === 'tools/list') {
      catalogRequested.resolve()
      await catalogReady.promise
    }
    if (message.id === undefined) {
      response.writeHead(202).end()
      return
    }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'Maps', version: '1' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'maps_direction_bicycling', description: '骑行路径规划，查询起点至终点的路线。', outputSchema: { type: 'object', properties: { routes: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' }, summary: { type: 'string' } }, required: ['id', 'summary'] } } }, required: ['routes'] }, inputSchema: { type: 'object', required: ['origin', 'destination'], properties: { origin: { type: 'string' }, destination: { type: 'string' } } } }] }
        : message.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'Fixture route: 180 km' }], structuredContent: { routes }, isError: message.params.arguments.origin === 'error' }
          : null
    if (message.method === 'tools/call')
      calls.push(message.params)
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result
      ? { jsonrpc: '2.0', id: message.id, result }
      : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const root = await mkdtemp(join(tmpdir(), 'buddy-mcp-discovery-'))
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const service = new McpConnectorService({ connectors: createConnectorRepository(database), secrets: { read: async () => null, write: async () => {}, delete: async () => {} } })
  let created: Awaited<ReturnType<typeof createIsolatedBuddySession>> | undefined
  try {
    await service.upsert({ id: 'maps', name: 'Maps', transport: 'streamable-http', url: `http://127.0.0.1:${port}/mcp?key=fixture-secret`, enabled: false, credentialRef: null, toolNamespace: 'maps', toolExposure: mode === 'search' ? 'deferred' : mode })
    await service.setEnabled('maps', true)
    const preparation = service.prepareForRun(new AbortController().signal)
    await catalogRequested.promise
    expect(service.getTools().tools).toEqual([])
    catalogReady.resolve()
    await preparation
    expect(service.state('maps').status).toBe('ready')
    let codemodeEnabled = true
    const mcp = createMcpCapability(service.getTools(), () => codemodeEnabled)
    const codemode = createCodemodeCapability(() => codemodeEnabled)
    const discovery = createToolDiscoveryCapability([...mcp.disclosure!, ...codemode.disclosure!])
    const approvals: string[] = []
    const policy = createToolPolicyExtension({
      authorization: new ToolAuthorizationService({
        approvalAvailable: true,
        approvalPolicy: 'policy',
        executionProfile: 'workspace_write',
        cwd: root,
        owner: { id: 'conversation-1', kind: 'conversation' },
        getGrants: () => [],
        approvalService: { request: async (input) => {
          approvals.push(input.toolName)
          expect(calls).toHaveLength(approvals.length - 1)
          return { approvalId: `approval-${approvals.length}`, decision: approvals.length === 3 ? 'denied' : 'approved_once' }
        } },
      }),
      getRunContext: () => ({ runId: 'run-1', signal: new AbortController().signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {} }),
      classifyTool: async event => await mcp.classify(event, new AbortController().signal) ?? { access: 'read' },
    })
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
    const model = runtime.getModels()[0]!
    await runtime.setRuntimeApiKey(model.provider, 'offline-fixture')
    const requests: Context[] = []
    const toolName = mcp.disclosure![0]!.tools[0]!.name
    vi.spyOn(runtime, 'streamSimple').mockImplementation((selected, context) => {
      requests.push(structuredClone({
        systemPrompt: getCurrentSystemPrompt(context.messages),
        tools: getCurrentTools(context.messages).map(({ name, description, parameters }) => ({ name, description, parameters })),
        messages: context.messages.filter(message => message.role !== 'system'),
      }))
      if (mode === 'codemode') {
        const code = `text({ discovered: (await searchTools('maps_direction_bicycling', { namespace: 'maps' })).map(tool => tool.name) }); text(await describeNamespace('maps')); text(await describeTool('${toolName}')); const result = await tools.${toolName}({ origin: '120,30', destination: '121,31' }); text({ count: result.structuredContent.routes.length, tail: result.structuredContent.routes.at(-1).id }); const failed = await tools.${toolName}({ origin: 'error', destination: '121,31' }); text({ businessError: failed.isError }); try { await tools.${toolName}({ origin: 'denied', destination: '121,31' }); } catch (error) { text(error.message); }`
        return reply(selected, requests.length === 1 ? { name: 'codemode', arguments: { code } } : undefined)
      }
      return reply(selected, requests.length === 1
        ? { name: 'lexora_tool_search', arguments: { query: '骑行路线规划' } }
        : requests.length === 2 ? { name: toolName, arguments: { origin: '120,30', destination: '121,31' } } : undefined)
    })
    const options = {
      agentDir: join(root, 'agent'),
      branchId: 'branch-1',
      canonicalRoot: root,
      conversationId: 'conversation-1',
      conversationsDirectory: join(root, 'conversations'),
      cwd: root,
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write' as const,
      model,
      modelRuntime: runtime,
      inProcessExtensions: [mcp.extension, codemode.extension, discovery.extension, policy],
      resources: { skillReadRoots: [], skillReferences: [], approvedSkills: [], context: { agentsFiles: [], diagnostics: [] }, directoryContext: '', revision: 'empty' },
    }
    const preview = await createIsolatedBuddyContextSnapshot(options)
    created = await createIsolatedBuddySession(options)
    await created.session.prompt('规划从杭州骑行至上海的路线')
    const first = requests[0]!
    expect(first.tools?.some(tool => tool.name === toolName)).toBe(false)
    expect(JSON.stringify(first)).not.toContain('fixture-secret')
    const output = created.session.messages.filter(message => message.role === 'toolResult').flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
    if (mode === 'search') {
      expect(first.tools?.find(tool => tool.name === 'lexora_tool_search')?.description).toContain('骑行路径规划')
      expect(requests[1]?.tools?.filter(tool => tool.name === toolName)).toHaveLength(1)
      expect(approvals).toEqual([toolName])
      expect(calls).toMatchObject([{ name: 'maps_direction_bicycling', arguments: { origin: '120,30', destination: '121,31' } }])
      expect(output).toContain('Fixture route: 180 km')
    }
    else {
      expect(output).toContain(`\"discovered\":[\"${toolName}\"]`)
      expect(output).toContain('CallToolResult')
      expect(output).toContain('3999')
      expect(output).toContain('4000')
      expect(output).toContain('businessError')
      expect(output).toContain('true')
      expect(output).toContain('APPROVAL_DENIED')
      expect(output).not.toContain('route-3998')
      expect(calls).toHaveLength(2)
      expect(approvals).toEqual([toolName, toolName, toolName])
      codemodeEnabled = false
      await created.session.prompt('关闭脚本模式')
      expect(created.session.getCallableToolNames()).not.toContain(toolName)
    }
    const callCount = calls.length
    expect(preview).toEqual(createEstimatedContextUsage({ ...first, messages: [] }))
    await service.upsert({ id: 'maps', name: 'Maps', transport: 'streamable-http', url: `http://127.0.0.1:${port}/mcp?key=fixture-secret`, enabled: true, credentialRef: null, toolNamespace: 'maps', toolExposure: 'hidden' })
    await created.session.prompt('隐藏这组工具')
    const hidden = requests.at(-1)!
    expect(hidden.tools?.some(tool => tool.name === toolName)).toBe(false)
    expect(hidden.tools?.find(tool => tool.name === 'lexora_tool_search')?.description).not.toContain('骑行路径规划')
    expect(created.session.getCallableToolNames()).not.toContain(toolName)
    expect(service.state('maps')).toMatchObject({ status: 'ready', toolCount: 1 })
    expect(calls).toHaveLength(callCount)
    await service.setEnabled('maps', false)
    await created.session.prompt('继续')
    const disabled = requests.at(-1)!
    expect(disabled.tools?.some(tool => tool.name === toolName)).toBe(false)
    expect(disabled.tools?.find(tool => tool.name === 'lexora_tool_search')?.description).not.toContain('骑行路径规划')
    expect(calls).toHaveLength(callCount)
    expect(created.session.getCallableToolNames()).not.toContain(toolName)
  }
  finally {
    catalogReady.resolve()
    await created?.shutdown('quit')
    await service.close()
    database.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
