import type { Api, AssistantMessage, Model, ToolCall } from '@earendil-works/pi-ai'
import type { BuddySettings } from '../../../../../../shared/buddies/buddySettings'
import type { BuddyExecutionProfile } from '../../../../../../shared/permissions/executionProfile'
import type { BuddyCapability } from '../../BuddyCapability'
import type { BuddySessionExtensionServices } from '../../createBuddySessionExtensions'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createAssistantMessageEventStream, getCurrentTools, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { defineTool, ModelRuntime } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MutationCoordinator } from '../../../../changes/MutationCoordinator'
import { createIsolatedBuddySession } from '../../../sessions/__tests__/isolatedBuddySession'
import { createBuddySessionExtensions } from '../../createBuddySessionExtensions'

const allowedMcp = 'mcp__scope__read'
const deniedMcp = 'mcp__scope__mutate'
const pluginTool = 'lexora_plugin_scope'
const editTool = 'lexora_scope_document'
const marker = 'UNSELECTED_TOOL_DETAILS'
const stableId = (kind: string, source: string, tool: string) => JSON.stringify([kind, source, tool])
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

describe('role tool scope in real Pi sessions', () => {
  it.skipIf(process.platform !== 'linux')('keeps discovered host commands authorized across full-access turns and session recovery', async () => {
    const f = await fixture({ executionProfile: 'workspace_write' })
    const command = { command: 'printf host-command-output' }
    await f.turn({ name: 'lexora_tool_search', arguments: { toolNames: ['lexora_host_shell'] } })
    await f.turn({ name: 'lexora_host_shell', arguments: command })
    expect(f.lastResult()).toBe('host-command-output')
    expect(f.approved).toEqual(['lexora_host_shell'])

    f.extensions.updatePermissionSettings({ approvalPolicy: 'policy', executionProfile: 'full_access' })
    for (const name of ['lexora_host_shell', 'bash', 'lexora_host_shell']) {
      await f.turn({ name, arguments: command })
      expect(f.lastResult()).toBe('host-command-output')
    }
    expect(f.approved).toEqual(['lexora_host_shell'])
    await f.shutdown()

    const resumed = await fixture({ root: f.root, piSessionFile: f.sessionFile, executionProfile: 'full_access' })
    await resumed.turn({ name: 'lexora_host_shell', arguments: command })
    expect(resumed.lastResult()).toBe('host-command-output')
    expect(resumed.approved).toEqual([])
    expect(resumed.requests[0]?.names).toContain('lexora_host_shell')

    resumed.extensions.updatePermissionSettings({ approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    await resumed.turn({ name: 'lexora_host_shell', arguments: command })
    expect(resumed.lastResult()).toBe('host-command-output')
    expect(resumed.approved).toEqual(['lexora_host_shell'])
    resumed.extensions.updatePermissionSettings({ approvalPolicy: 'policy', executionProfile: 'read_only' })
    await resumed.turn({ name: 'lexora_host_shell', arguments: command })
    expect(resumed.lastResult()).toContain('READ_ONLY_PROFILE')
    expect(resumed.approved).toEqual(['lexora_host_shell'])
  })

  it('keeps none empty across declarations, search and native CodeMode catalogs', async () => {
    const f = await fixture({ tools: { mode: 'none' } })
    await f.turn({ name: 'lexora_tool_search', arguments: { toolNames: [deniedMcp] } })
    expect(f.lastResult()).not.toContain(marker)
    expect(f.lastResult()).toContain('"tools":[]')
    await f.turn({ name: 'codemode', arguments: { code: `text(ALL_TOOLS); text(await searchTools(${JSON.stringify(marker)})); text({ write: "write" in tools, external: ${JSON.stringify(deniedMcp)} in tools });` } })
    expect(f.lastResult()).not.toContain(marker)
    expect(f.lastResult()).not.toContain(deniedMcp)
    expect(f.lastResult()).toContain('"write":false')
    expect(f.lastResult()).toContain('"external":false')
    expect(f.requests.every(request => request.names.every(name => ['codemode', 'lexora_tool_search'].includes(name)))).toBe(true)
    expect(f.requests.map(request => request.tools).join('\n')).not.toContain(marker)
    await f.turn({ name: 'write', arguments: { path: 'document.txt', content: 'not allowed' } })
    expect(await readFile(f.document, 'utf8')).toBe('original document')
  })

  it('uses stable IDs to allow one deferred tool without leaking its siblings or enabling writes', async () => {
    const f = await fixture({ tools: { mode: 'selected', ids: [stableId('builtin', 'core', 'read'), stableId('mcp', 'scope-connector', 'remote-read')] } })
    await f.turn({ name: 'codemode', arguments: { code: `text(await searchTools("scope")); text(await tools.${allowedMcp}({})); text(await tools.read({ path: "document.txt" })); text({ external: ${JSON.stringify(deniedMcp)} in tools, write: "write" in tools });` } })
    expect(f.lastResult()).toContain('remote read completed')
    expect(f.lastResult()).toContain('original document')
    expect(f.lastResult()).not.toContain(marker)
    expect(f.lastResult()).not.toContain(deniedMcp)
    expect(f.lastResult()).toContain('"external":false')
    expect(f.approved).toEqual([allowedMcp])
    await f.turn({ name: 'lexora_tool_search', arguments: { toolNames: [deniedMcp, allowedMcp] } })
    expect(f.lastResult()).toContain(`"notFound":["${deniedMcp}"]`)
    expect(f.requests.map(request => request.tools).join('\n')).not.toContain(marker)
    expect(await readFile(f.document, 'utf8')).toBe('original document')
  })

  it('cannot restore removed tools through old discovery state or system tool declarations', async () => {
    const first = await fixture()
    await first.turn({ name: 'lexora_tool_search', arguments: { toolNames: [deniedMcp, pluginTool] } })
    await first.shutdown()
    const resumed = await fixture({ tools: { mode: 'none' }, root: first.root, piSessionFile: first.sessionFile })
    await resumed.turn({ name: 'codemode', arguments: { code: `text(ALL_TOOLS); text({ external: ${JSON.stringify(deniedMcp)} in tools, plugin: ${JSON.stringify(pluginTool)} in tools });` } })
    expect(resumed.lastResult()).not.toContain(marker)
    expect(resumed.lastResult()).not.toContain(deniedMcp)
    expect(resumed.requests.every(request => !request.names.includes(deniedMcp) && !request.names.includes(pluginTool))).toBe(true)
    expect(resumed.requests.map(request => request.tools).join('\n')).not.toContain(marker)
  })

  it('keeps role read-only limits after a full-access update and excludes unknown external effects', async () => {
    const f = await fixture({ fileAccessLimit: 'read_only', executionProfile: 'full_access' })
    f.extensions.updatePermissionSettings({ approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    f.extensions.updatePermissionSettings({ approvalPolicy: 'policy', executionProfile: 'full_access' })
    await f.turn({ name: 'codemode', arguments: { code: `text(await tools.read({ path: "document.txt" })); text(ALL_TOOLS); text({ shell: "bash" in tools, host: "lexora_host_shell" in tools, external: ${JSON.stringify(allowedMcp)} in tools, plugin: ${JSON.stringify(pluginTool)} in tools });` } })
    expect(f.lastResult()).toContain('original document')
    expect(f.lastResult()).not.toContain(marker)
    expect(f.lastResult()).not.toContain(allowedMcp)
    expect(f.lastResult()).not.toContain(pluginTool)
    expect(f.lastResult()).toContain('"shell":true')
    expect(f.lastResult()).toContain('"host":false')
    expect(f.requests.every(request => !request.names.some(name => ['write', 'edit', 'lexora_host_shell', 'lexora_authorize_directory'].includes(name)))).toBe(true)
    await f.turn({ name: editTool, arguments: { content: 'must stay blocked' } })
    expect(f.lastResult()).toContain('READ_ONLY_PROFILE')
    expect(await readFile(f.document, 'utf8')).toBe('original document')
    expect(f.approved).toEqual([])
    const ordinary = await fixture({ executionProfile: 'read_only' })
    await ordinary.turn({ name: 'codemode', arguments: { code: `text(await tools.${allowedMcp}({}));` } })
    expect(ordinary.lastResult()).toContain('remote read completed')
    expect(ordinary.approved).toEqual([allowedMcp])
  })

  it('rejects a missing selected capability during composition instead of falling back to all', async () => {
    const missing = stableId('mcp', 'removed-connector', 'missing-tool')
    await expect(fixture({ tools: { mode: 'selected', ids: [missing] } })).rejects.toMatchObject({ code: 'BUDDY_CAPABILITY_UNAVAILABLE', toolIds: [missing] })
  })
})

async function fixture(options: { tools?: BuddySettings['tools'], fileAccessLimit?: BuddySettings['limits']['fileAccess'], executionProfile?: BuddyExecutionProfile, root?: string, piSessionFile?: string } = {}) {
  const root = options.root ?? await realpath(await mkdtemp(join(tmpdir(), 'buddy-tool-scope-')))
  if (!options.root)
    cleanups.push(() => rm(root, { recursive: true, force: true }))
  const document = join(root, 'document.txt')
  if (!options.root)
    await writeFile(document, 'original document')
  const executionProfile = options.executionProfile ?? 'full_access'
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
  const model = runtime.getModels().find(model => model.provider === 'anthropic')!
  await runtime.setRuntimeApiKey(model.provider, 'offline-test-only')
  const approved: string[] = []
  const custom: BuddyCapability = {
    classify: event => event.toolName === editTool
      ? { access: 'write', paths: [{ path: document, mode: 'existing' }] }
      : event.toolName.startsWith('mcp__')
        ? { access: 'network', requireApproval: true }
        : event.toolName === pluginTool ? { access: 'read', paths: [] } : null,
    disclosure: [
      { source: { kind: 'builtin', id: 'scope', title: 'Document fixture' }, exposure: 'direct', keywords: 'document', tools: [{ name: editTool }] },
      { source: { kind: 'mcp', id: 'scope-connector', title: 'Scope connector' }, exposure: 'on_demand', keywords: 'scope', tools: [{ name: allowedMcp, id: 'remote-read' }, { name: deniedMcp, id: 'remote-mutate' }] },
      { source: { kind: 'plugin', id: 'scope-plugin', title: 'Scope plugin' }, exposure: 'on_demand', keywords: marker, tools: [{ name: pluginTool }] },
    ],
    extension: { name: 'lexora-scope-fixture', factory(pi) {
      const remote = [allowedMcp, deniedMcp, pluginTool].map(name => defineTool({
        name,
        label: name,
        description: name === allowedMcp ? 'Read scope data' : marker,
        promptGuidelines: name === allowedMcp ? [] : [marker],
        exposure: 'deferred',
        namespace: { name: name === pluginTool ? 'plugin_scope' : 'mcp_scope', description: 'Scope tools' },
        parameters: Type.Object({}),
        async execute() {
          if (name !== allowedMcp)
            await writeFile(document, `changed by ${name}`)
          return { content: [{ type: 'text', text: name === allowedMcp ? 'remote read completed' : 'mutated document' }], details: {} }
        },
      }))
      for (const tool of remote)
        pi.registerTool(tool)
      pi.on('before_agent_start', () => {
        for (const tool of remote)
          pi.registerTool(tool)
      })
      pi.registerTool(defineTool({
        name: editTool,
        label: 'Update document',
        description: 'Update the fixture document',
        parameters: Type.Object({ content: Type.String() }),
        async execute(_id, input) {
          await writeFile(document, input.content)
          return { content: [{ type: 'text', text: 'document updated' }], details: {} }
        },
      }))
    } },
  }
  const services: BuddySessionExtensionServices = {
    approvalService: { request: async (input) => {
      approved.push(input.toolName)
      return { approvalId: `approval-${approved.length}`, decision: 'approved_once' }
    } },
    attachmentService: {} as BuddySessionExtensionServices['attachmentService'],
    fileResources: {} as BuddySessionExtensionServices['fileResources'],
    mutations: new MutationCoordinator(),
    changeCaptureService: { beginInvocation: async input => ({ invocationId: input.invocationId, runId: input.runId }), finishInvocation: async () => ({ complete: true }), markPartial: async () => {} },
    createCapabilities: async () => [custom],
    directoryGrants: { assertCurrent() {}, grant: async () => { throw new Error('Unexpected directory grant') } },
  }
  const extensions = await createBuddySessionExtensions({ canonicalRoot: root, conversationId: 'scope-conversation', approvalPolicy: 'policy', executionProfile, grants: [{ canonicalRoot: root, root, grantId: 'scope-workspace', kind: 'workspace' }], services, sessionMode: 'interactive', signal: new AbortController().signal, spaceId: null, toolScope: options.tools, fileAccessLimit: options.fileAccessLimit })
  cleanups.push(() => extensions.dispose())
  extensions.setCodemodeEnabled(true)
  const created = await createIsolatedBuddySession({
    canonicalRoot: root,
    cwd: root,
    agentDir: join(root, 'agent'),
    conversationsDirectory: join(root, 'conversations'),
    conversationId: 'scope-conversation',
    branchId: 'scope-branch',
    piSessionFile: options.piSessionFile,
    approvalPolicy: 'policy',
    executionProfile,
    getPermissionSettings: extensions.getPermissionSettings,
    model,
    modelRuntime: runtime,
    resources: { skillReadRoots: [], skillReferences: [], approvedSkills: [], context: { agentsFiles: [], diagnostics: [] }, directoryContext: '', revision: 'empty' },
    inProcessExtensions: extensions.inProcessExtensions,
  })
  const shutdown = () => created.shutdown('quit')
  cleanups.push(shutdown)
  const requests: { names: string[], tools: string }[] = []
  let nextCall: Pick<ToolCall, 'name' | 'arguments'> | undefined
  let turn = 0
  vi.spyOn(runtime, 'streamSimple').mockImplementation((target, context) => {
    const tools = getCurrentTools(context.messages)
    requests.push({ names: tools.map(tool => tool.name), tools: JSON.stringify(tools) })
    const call = nextCall
    nextCall = undefined
    return response(target, call, turn)
  })
  return {
    root,
    document,
    approved,
    extensions,
    requests,
    shutdown,
    sessionFile: created.piSessionFile,
    lastResult: () => created.session.messages.filter(message => message.role === 'toolResult').at(-1)?.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '',
    async turn(call: Pick<ToolCall, 'name' | 'arguments'>) {
      nextCall = call
      extensions.runContext.current = { runId: `scope-run-${++turn}`, signal: new AbortController().signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {} }
      await created.session.prompt('Run the operation')
      extensions.runContext.current = null
    },
  }
}

function response(model: Model<Api>, call: Pick<ToolCall, 'name' | 'arguments'> | undefined, turn: number) {
  const message: AssistantMessage = {
    role: 'assistant',
    api: model.api,
    model: model.id,
    provider: model.provider,
    timestamp: Date.now(),
    stopReason: call ? 'toolUse' : 'stop',
    content: call ? [{ type: 'toolCall', id: `call-${turn}`, ...call }] : [{ type: 'text', text: 'Done' }],
    usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message }))
  return stream
}
