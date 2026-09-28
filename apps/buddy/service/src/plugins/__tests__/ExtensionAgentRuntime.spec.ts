import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ExtensionAgentDescriptor } from '../../../../shared/extensions/extensionAgent'
import type { RuntimeRequestHandler, RuntimeRpcPeerContract } from '../../../../shared/runtime/rpcPeer'
import type { BuddyCapabilityContext } from '../../agent/extensions/BuddyCapability'
import type { ExtensionAgentChange } from '../ExtensionAgentEvents'
import type { ExtensionAgentHandlers } from '../extensionAgentHandlers'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it } from 'vitest'
import { extensionAgentRpc } from '../../../../shared/extensions/extensionAgent'
import { ExtensionAgentRuntime } from '../ExtensionAgentRuntime'

const descriptor: ExtensionAgentDescriptor = { id: 'tests.reader', name: 'Fixture', revision: 'package-revision', configurationRevision: 'config-revision', agent: { instructions: 'fixture-private-instructions', tools: [{ id: 'tests.reader.read', title: 'Read', description: 'fixture-private-description', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }] } }
function fixture() {
  const requests = new Map<string, RuntimeRequestHandler>()
  const stop = new AbortController()
  const context: BuddyCapabilityContext = { conversationId: 'conversation-1', cwd: '/fixture-private', executionProfile: 'read_only', grants: [], getRunId: () => 'run-1', sessionMode: 'interactive', signal: stop.signal }
  let descriptors: ExtensionAgentDescriptor[] = [descriptor]
  let unavailable = false
  let invoke: (input: unknown, signal?: AbortSignal) => Promise<unknown> = async () => null
  const handlers: ExtensionAgentHandlers = { 'task.get': async () => null, 'task.rename': async () => null, 'models.generateText': async () => null }
  const rpc: RuntimeRpcPeerContract = {
    notify() {},
    close() {},
    onNotification: () => () => {},
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
        return descriptors
      }
      return invoke(input, signal)
    },
  }
  const runtime = new ExtensionAgentRuntime({ rpc, handlers, context: scope => ({ ...scope, model: { providerId: 'provider-1', modelId: 'model-1' } }) })
  const facts: ExtensionAgentChange[] = []
  runtime.onDidChange(event => facts.push(event))
  runtime.bind()
  return { runtime, context, stop, facts, handlers, setDescriptors: (value: ExtensionAgentDescriptor[]) => {
    descriptors = value
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
