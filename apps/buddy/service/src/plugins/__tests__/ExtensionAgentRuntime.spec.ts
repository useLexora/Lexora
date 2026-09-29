import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ExtensionAgentDescriptor } from '../../../../shared/extensions/extensionAgent'
import type { RuntimeRequestHandler, RuntimeRpcPeerContract } from '../../../../shared/runtime/rpcPeer'
import type { BuddyCapabilityContext } from '../../agent/extensions/BuddyCapability'
import type { ExtensionAgentChange } from '../ExtensionAgentEvents'
import type { ExtensionAgentHandlers } from '../extensionAgentHandlers'
import { randomUUID } from 'node:crypto'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it } from 'vitest'
import { extensionAgentRpc } from '../../../../shared/extensions/extensionAgent'
import { ToolDisclosure } from '../../agent/extensions/discovery/ToolDisclosure'
import { ExtensionAgentRuntime } from '../ExtensionAgentRuntime'

const descriptor: ExtensionAgentDescriptor = { id: 'tests.reader', name: 'Fixture', revision: 'package-revision', configurationRevision: 'config-revision', agent: { actions: [], instructions: 'fixture-private-instructions', tools: [{ id: 'tests.reader.read', title: 'Read', description: 'fixture-private-description', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }] } }
function fixture() {
  const requests = new Map<string, RuntimeRequestHandler>()
  const notifications = new Set<Parameters<RuntimeRpcPeerContract['onNotification']>[0]>()
  const stop = new AbortController()
  const context: BuddyCapabilityContext = { conversationId: 'conversation-1', cwd: '/fixture-private', executionProfile: 'read_only', grants: [], getRunId: () => 'run-1', sessionMode: 'interactive', signal: stop.signal }
  let descriptors: ExtensionAgentDescriptor[] = [descriptor]
  let list = async () => descriptors
  let unavailable = false
  let invoke: (input: unknown, signal?: AbortSignal) => Promise<unknown> = async () => null
  const handlers: ExtensionAgentHandlers = { 'task.messages': async () => [], 'task.get': async () => null, 'task.rename': async () => null, 'models.generateText': async () => null }
  const rpc: RuntimeRpcPeerContract = {
    notify() {},
    close() {},
    onNotification: (listener) => {
      notifications.add(listener)
      return () => {
        notifications.delete(listener)
      }
    },
    onRequest: (method, handler) => {
      requests.set(method, handler)

      return () => {
        requests.delete(method)
      }
    },
    request: async (method, input, _timeout, signal) => {
      if (method === extensionAgentRpc.list) {
        if (unavailable)
          throw new Error('fixture-private-unavailable')
        return list()
      }
      return invoke(input, signal)
    },
  }
  const runtime = new ExtensionAgentRuntime({ rpc, createHandlers: () => handlers })
  const facts: ExtensionAgentChange[] = []
  runtime.onDidChange(event => facts.push(event))
  runtime.bind()
  return { runtime, context, stop, facts, handlers, changed: (value: ExtensionAgentDescriptor[]) => {
    descriptors = value
    const catalog = value.map(({ id, revision, configurationRevision }) => ({ id, revision, configurationRevision }))
    for (const listener of notifications) listener(extensionAgentRpc.changed, catalog)
  }, setDescriptors: (value: ExtensionAgentDescriptor[]) => {
    descriptors = value
  }, list: (value: typeof list) => {
    list = value
  }, unavailable: (value: boolean) => {
    unavailable = value
  }, invoke: (value: typeof invoke) => {
    invoke = value
  }, request: (input: unknown) => Promise.resolve(requests.get(extensionAgentRpc.request)!(input)), tool: async () => {
    const capabilities = await runtime.capabilities(context)
    let tool!: ToolDefinition
    await capabilities[0]!.extension.factory({ registerTool: (value: ToolDefinition) => {
      tool = value
    }, on() {} } as never)
    return () => tool.execute('tool-call-1', {}, undefined, undefined, {} as never)
  } }
}

describe('extension agent capability and invocation lifetimes', () => {
  it('keeps unchanged plugins available while withdrawing changed and removed definitions', async () => {
    const f = fixture()
    const other = { ...descriptor, id: 'tests.other', agent: { ...descriptor.agent, tools: [{ ...descriptor.agent.tools[0]!, id: 'tests.other.read' }] } }
    f.setDescriptors([descriptor, other])
    const capabilities = await f.runtime.capabilities(f.context)
    const definitions: ToolDefinition[] = []
    for (const capability of capabilities)
      await capability.extension.factory({ registerTool: (tool: ToolDefinition) => definitions.push(tool), on() {} } as never)
    const tools = definitions.map(tool => ({ ...tool, sourceInfo: { source: 'extension' as const, path: '', origin: 'top-level' as const, scope: 'temporary' as const } }))
    const names = definitions.map(tool => tool.name)
    const policies = capabilities.flatMap(capability => capability.disclosure!)
    const disclosure = new ToolDisclosure(tools, names, policies)
    const context = { model: undefined }
    expect(disclosure.active(context)).toEqual([])
    expect(disclosure.search({ toolNames: names }, context).tools).toMatchObject([{ title: 'Read', source: 'plugin:tests.reader' }, { title: 'Read', source: 'plugin:tests.other' }])
    expect(disclosure.active(context)).toEqual([...names].sort())
    const direct = new ToolDisclosure(tools, [], policies, () => 'direct')
    expect(direct.active(context)).toEqual(disclosure.active(context))
    f.changed([{ ...descriptor, configurationRevision: 'config-updated' }, other])
    expect(disclosure.active(context)).toEqual([names[1]])
    expect(direct.active(context)).toEqual([names[1]])
    expect(disclosure.search({ toolNames: names }, context)).toMatchObject({ tools: [{ name: names[1] }], notFound: [names[0]] })
    const current = await f.runtime.capabilities(f.context)
    const refreshed = new ToolDisclosure(tools, [], current.flatMap(capability => capability.disclosure!))
    refreshed.restore([], disclosure.persistedState)
    expect(refreshed.active(context)).toEqual([...names].sort())
    f.changed([other])
    expect(refreshed.active(context)).toEqual([names[1]])
    expect(direct.active(context)).toEqual([names[1]])
    await f.runtime.dispose()
    expect(refreshed.active(context)).toEqual([])
  })

  it('does not restore a stale plugin from an in-flight catalog response or discard unchanged plugins', async () => {
    const f = fixture()
    const other = { ...descriptor, id: 'tests.other', agent: { ...descriptor.agent, tools: [{ ...descriptor.agent.tools[0]!, id: 'tests.other.read' }] } }
    const response = deferred<ExtensionAgentDescriptor[]>()
    f.list(() => response.promise)
    const pending = f.runtime.capabilities(f.context)
    f.changed([{ ...descriptor, revision: 'package-updated' }, other])
    response.resolve([descriptor, other])
    const capabilities = await pending
    expect(capabilities.flatMap(capability => capability.resourceRevisions!.map(resource => resource.id))).toEqual(['tests.other'])
    expect(f.runtime.snapshot.projections[0]).toMatchObject({ status: 'accepted', descriptors: [{ id: 'tests.other' }] })
    await f.runtime.dispose()
  })

  it('holds quota through child draining, admits other plugins, and removes cancelled queued calls before execution', async () => {
    const f = fixture()
    const children = new Map<string, ReturnType<typeof deferred<void>>>()
    const drainingIds = Array.from({ length: 4 }, () => randomUUID())
    const draining = new Set<string>(drainingIds)
    const accepted: string[] = []
    const childResults: Promise<unknown>[] = []
    f.handlers['task.rename'] = async (_input, scope) => {
      const committed = deferred<void>()
      children.set(scope.invocationId, committed)
      await committed.promise
      return { applied: true }
    }
    f.invoke(async (raw) => {
      const { invocationId } = raw as { invocationId: string }
      accepted.push(invocationId)
      if (draining.has(invocationId)) {
        childResults.push(f.request({ invocationId, method: 'task.rename', params: { title: 'Committed' } }).catch(error => error))
        await Promise.resolve()
      }
      return { done: true }
    })
    const invoke = (id: ReturnType<typeof randomUUID>, plugin = descriptor, signal = new AbortController().signal) => f.runtime.invoke(plugin, { tool: 'tests.reader.read', input: {} }, { conversationId: 'conversation-1', runId: 'run-1' }, signal, id)
    const running = drainingIds.map(id => invoke(id))
    try {
      await expect.poll(() => f.runtime.snapshot.activeInvocations.filter(invocation => !invocation.accepting && invocation.pendingRequests === 1).length).toBe(4)
      const cancel = new AbortController()
      const cancelledId = randomUUID()
      const cancelled = invoke(cancelledId, descriptor, cancel.signal).catch(error => error)
      const nextId = randomUUID()
      const next = invoke(nextId)
      const otherId = randomUUID()
      expect(await invoke(otherId, { ...descriptor, id: 'tests.other' })).toEqual({ done: true })
      expect(accepted).toEqual([...drainingIds, otherId])
      cancel.abort()
      expect(await cancelled).toMatchObject({ name: 'AbortError' })
      children.get(drainingIds[0]!)!.resolve()
      expect(await next).toEqual({ done: true })
      expect(accepted).toEqual([...drainingIds, otherId, nextId])
      const finished = f.facts.flatMap(fact => fact.kind === 'invocation' && fact.stage === 'settled' ? [fact.invocationId] : [])
      expect(finished).toContain(drainingIds[0])
    }
    finally {
      for (const child of children.values()) child.resolve()
      await Promise.allSettled([...running, ...childResults])
      await f.runtime.dispose()
    }
  })

  it('cancels queued invocations on disposal without sending them to the host', async () => {
    const f = fixture()
    const accepted: string[] = []
    f.invoke(async (raw, signal) => {
      accepted.push((raw as { invocationId: string }).invocationId)
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
      return null
    })
    const ids = Array.from({ length: 8 }, () => randomUUID())
    const results = Promise.allSettled(ids.map(id => f.runtime.invoke(descriptor, { tool: 'tests.reader.read', input: {} }, { conversationId: 'conversation-1', runId: 'run-1' }, new AbortController().signal, id)))
    await expect.poll(() => accepted.length).toBe(4)
    await f.runtime.dispose()
    expect(await results).toEqual(ids.map(() => expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ name: 'AbortError' }) })))
    expect(accepted).toEqual(ids.slice(0, 4))
    expect(f.runtime.snapshot.activeInvocations).toEqual([])
  })

  it.each(['EXTENSION_AGENT_CANCELLED', 'EXTENSION_AGENT_UNAVAILABLE'])('preserves remote lifecycle revocation %s as cancellation', async (code) => {
    const f = fixture()
    f.invoke(async () => {
      throw Object.assign(new Error('Runtime request failed'), { data: { code } })
    })
    await expect(f.runtime.invoke(descriptor, { tool: 'tests.reader.read', input: {} }, { conversationId: 'conversation-1', runId: 'run-1' }, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.facts.filter(fact => fact.kind === 'invocation' && fact.stage !== 'started')).toMatchObject([{ stage: 'returned', outcome: 'cancelled' }, { stage: 'settled', outcome: 'cancelled' }])
    expect(f.runtime.snapshot.activeInvocations).toEqual([])
    await f.runtime.dispose()
  })

  it('distinguishes an accepted empty catalog from an unavailable source and releases its scope snapshot', async () => {
    const f = fixture()
    f.setDescriptors([])
    expect(await f.runtime.capabilities(f.context)).toEqual([])
    expect(f.runtime.snapshot.projections[0]).toMatchObject({ status: 'accepted', revision: 1, descriptors: [] })
    f.unavailable(true)
    expect(await f.runtime.capabilities(f.context)).toEqual([])
    expect(f.runtime.snapshot.projections[0]).toMatchObject({ status: 'unavailable', revision: 2, descriptors: [] })
    f.unavailable(false)
    await f.runtime.capabilities(f.context)
    expect(f.facts.filter(fact => fact.kind === 'capabilities')).toHaveLength(3)
    f.stop.abort()
    expect(f.runtime.snapshot.projections).toEqual([])
    expect(f.facts.at(-1)?.kind).toBe('capabilities-released')
    await f.runtime.dispose()
  })

  it('retains invocation ownership until accepted child handlers actually finish and fences new requests after return', async () => {
    const f = fixture()
    const childStarted = deferred<void>()
    const childCommitted = deferred<void>()
    let child!: Promise<unknown>
    let invocationId = ''
    f.handlers['task.rename'] = async () => {
      childStarted.resolve()
      await childCommitted.promise
      return { title: 'fixture-private-committed' }
    }
    f.invoke(async (raw) => {
      invocationId = (raw as { invocationId: string }).invocationId
      child = f.request({ invocationId, method: 'task.rename', params: { title: 'fixture-private-title' } }).catch(error => error)
      await childStarted.promise
      return { done: true }
    })
    const execute = await f.tool()
    const executing = execute()
    await childStarted.promise
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.facts).toContainEqual(expect.objectContaining({ kind: 'invocation', stage: 'returned', outcome: 'completed' }))
    expect(f.facts.some(fact => fact.kind === 'invocation' && fact.stage === 'settled')).toBe(false)
    expect(f.runtime.snapshot.activeInvocations).toMatchObject([{ invocationId, accepting: false, pendingRequests: 1 }])
    await expect(f.request({ invocationId, method: 'task.get', params: null })).rejects.toThrow('EXTENSION_AGENT_UNAVAILABLE')
    const stopping = f.runtime.dispose()
    childCommitted.resolve()
    await child
    await executing
    await stopping
    const finished = f.facts.find(fact => fact.kind === 'request' && fact.stage === 'finished')
    expect(finished).toMatchObject({ handler: 'completed', response: 'cancelled' })
    expect(f.facts.at(-1)).toMatchObject({ kind: 'invocation', stage: 'settled', invocationId })
    expect(f.runtime.snapshot.activeInvocations).toEqual([])
    expect(JSON.stringify(f.facts.filter(fact => fact.kind !== 'capabilities'))).not.toContain('fixture-private')
  })
})
