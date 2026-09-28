import type { ListenerErrorHandler } from '../../../shared/events/Emitter'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { ExtensionAgentDescriptor } from '../../../shared/extensions/extensionAgent'
import type { ExtensionAgentMethod } from '../../../shared/extensions/extensionAgentCapabilities'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { JsonValue } from '../../../shared/workbench/workbenchState'
import type { BuddyCapability, BuddyCapabilityContext } from '../agent/extensions/BuddyCapability'
import type { ExtensionAgentChange, ExtensionAgentFact, ExtensionCapabilityProjection } from './ExtensionAgentEvents'
import type { ExtensionAgentHandlers, ExtensionCapabilityContext, ExtensionInvocationScope } from './extensionAgentHandlers'
import { createHash, randomUUID } from 'node:crypto'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { z } from 'zod'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { extensionAgentDescriptorSchema, extensionAgentRequestSchema, extensionAgentRpc } from '../../../shared/extensions/extensionAgent'
import { extensionAgentCapabilities } from '../../../shared/extensions/extensionAgentCapabilities'
import { extensionJsonSchema } from '../../../shared/extensions/extensionApi'
import { extensionIdSchema } from '../../../shared/extensions/extensionManifest'

interface Invocation {
  scope: ExtensionInvocationScope
  requests: Map<ExtensionAgentMethod, { calls: number, active: number }>
  pending: Set<Promise<JsonValue>>
  accepting: boolean
  settled: Promise<void>
  settle: () => void
}
interface ProjectionState {
  snapshot: ExtensionCapabilityProjection
  request: number
  release: () => void
}
interface ExtensionAgentRuntimeOptions {
  rpc: RuntimeRpcPeerContract
  handlers: ExtensionAgentHandlers
  context: (scope: ExtensionInvocationScope) => Omit<ExtensionCapabilityContext, 'callNumber'>
  onObserverError?: ListenerErrorHandler
}

export class ExtensionAgentRuntime {
  readonly #options: ExtensionAgentRuntimeOptions
  readonly #invocations = new Map<string, Invocation>()
  readonly #projections = new Map<AbortSignal, ProjectionState>()
  readonly #changes: Emitter<ExtensionAgentChange>
  readonly onDidChange
  readonly #stop = new AbortController()
  #revision = 0
  #disposing: Promise<void> | undefined

  constructor(options: ExtensionAgentRuntimeOptions) {
    this.#options = options
    this.#changes = new Emitter(options.onObserverError ?? (() => console.error('EXTENSION_AGENT_OBSERVER_FAILED')))
    this.onDidChange = this.#changes.event
  }

  get snapshot() {
    return copyEventSnapshot({ revision: this.#revision, projections: [...this.#projections.values()].map(state => state.snapshot), activeInvocations: [...this.#invocations.values()].map(invocation => ({ invocationId: invocation.scope.invocationId, extensionId: invocation.scope.extensionId, runId: invocation.scope.runId, conversationId: invocation.scope.conversationId, accepting: invocation.accepting, pendingRequests: invocation.pending.size })) })
  }

  bind(): () => void {
    return this.#options.rpc.onRequest(extensionAgentRpc.request, (input, signal) => this.#request(input, signal))
  }

  async capabilities(context: BuddyCapabilityContext): Promise<BuddyCapability[]> {
    context.signal.throwIfAborted()
    this.#stop.signal.throwIfAborted()
    const projection = this.#projection(context)
    const request = ++projection.request
    try {
      const descriptors = z.array(extensionAgentDescriptorSchema.extend({ id: extensionIdSchema })).parse(await this.#options.rpc.request(extensionAgentRpc.list, {}, 10000, AbortSignal.any([context.signal, this.#stop.signal])))
      context.signal.throwIfAborted()
      this.#stop.signal.throwIfAborted()
      this.#acceptProjection(projection, request, 'accepted', descriptors)
      return descriptors.map(descriptor => this.#capability(context, descriptor))
    }
    catch {
      context.signal.throwIfAborted()
      this.#stop.signal.throwIfAborted()
      this.#acceptProjection(projection, request, 'unavailable', [])
      return []
    }
  }

  dispose(): Promise<void> {
    if (this.#disposing)
      return this.#disposing
    this.#disposing = Promise.resolve().then(async () => {
      for (const projection of this.#projections.values()) projection.release()
      await Promise.allSettled([...this.#invocations.values()].map(invocation => invocation.settled))
      this.#changes.dispose()
    })
    this.#stop.abort()
    return this.#disposing
  }

  #capability(context: BuddyCapabilityContext, input: ExtensionAgentDescriptor): BuddyCapability {
    const descriptor: EventSnapshot<ExtensionAgentDescriptor> = copyEventSnapshot(input)
    const prefix = `plugin_${createHash('sha256').update(descriptor.id).digest('hex').slice(0, 12)}`
    const names = new Map(descriptor.agent.tools.map(tool => [tool.id, `lexora_plugin_${createHash('sha256').update(tool.id).digest('hex').slice(0, 16)}`]))
    const instructions = descriptor.agent.instructions.replace(/\{\{([^}]+)\}\}/g, (_match, id: string) => names.get(id) ?? id)
    const tools = descriptor.agent.tools.map(tool => ({ ...tool, name: names.get(tool.id)!, schema: Type.Object(Object.fromEntries(Object.entries(tool.parameters.properties).map(([key, property]) => {
      const options = { description: property.description }
      const value = property.type === 'string' ? Type.String({ ...options, maxLength: 32768 }) : property.type === 'boolean' ? Type.Boolean(options) : Type.Number(options)
      return [key, tool.parameters.required.includes(key) ? value : Type.Optional(value)]
    })), { additionalProperties: false }) }))
    return {
      classify: event => tools.some(tool => tool.name === event.toolName) ? { access: 'read', paths: [] } : null,
      extension: {
        name: `lexora-${prefix}`,
        factory: (pi) => {
          for (const tool of tools) {
            pi.registerTool(defineTool({
              name: tool.name,
              label: `${descriptor.name} · ${tool.title}`,
              description: tool.description,
              promptGuidelines: instructions ? [instructions] : [],
              parameters: tool.schema,
              execute: async (_toolCallId, input, signal) => {
                const runId = context.getRunId()
                if (this.#stop.signal.aborted || context.signal.aborted || !runId || !Check(tool.schema, input))
                  throw new Error('EXTENSION_AGENT_UNAVAILABLE')
                const controller = new AbortController()
                const abort = AbortSignal.any([context.signal, this.#stop.signal, controller.signal, ...signal ? [signal] : [], AbortSignal.timeout(120000)])
                const invocationId = randomUUID()
                let settle!: () => void
                const invocation: Invocation = { scope: { conversationId: context.conversationId, runId, extensionId: descriptor.id, invocationId, signal: abort }, requests: new Map(), pending: new Set(), accepting: true, settled: new Promise<void>(resolve => settle = resolve), settle: () => settle() }
                this.#invocations.set(invocationId, invocation)
                const identity = { invocationId, extensionId: descriptor.id, conversationId: context.conversationId, runId }
                const startedAt = performance.now()
                let outcome: 'completed' | 'failed' | 'cancelled' = 'completed'
                this.#publish({ kind: 'invocation', stage: 'started', ...identity })
                try {
                  abort.throwIfAborted()
                  const result = extensionJsonSchema.parse(await this.#options.rpc.request(extensionAgentRpc.invoke, { extensionId: descriptor.id, revision: descriptor.revision, configurationRevision: descriptor.configurationRevision, invocationId, tool: tool.id, input }, 125000, abort))
                  abort.throwIfAborted()
                  return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { ok: true, result } }
                }
                catch (error) {
                  outcome = abort.aborted ? 'cancelled' : 'failed'
                  const code = error instanceof Error ? error.message.match(/EXTENSION_[A-Z_]+/)?.[0] : null
                  return { content: [{ type: 'text', text: code ?? 'EXTENSION_AGENT_FAILED' }], details: { ok: false, result: null }, isError: true }
                }
                finally {
                  invocation.accepting = false
                  this.#publish({ kind: 'invocation', stage: 'returned', outcome, durationMs: Math.round(performance.now() - startedAt), ...identity })
                  controller.abort()
                  await Promise.allSettled([...invocation.pending])
                  this.#invocations.delete(invocationId)
                  this.#publish({ kind: 'invocation', stage: 'settled', outcome, durationMs: Math.round(performance.now() - startedAt), ...identity })
                  invocation.settle()
                }
              },
            }))
          }
          pi.on('tool_result', (event) => {
            if (tools.some(tool => tool.name === event.toolName) && event.details && typeof event.details === 'object' && 'ok' in event.details && event.details.ok === false)
              return { isError: true }
          })
        },
      },
    }
  }

  async #request(raw: unknown, requestSignal?: AbortSignal): Promise<JsonValue> {
    const input = extensionAgentRequestSchema.parse(raw)
    const invocation = this.#invocations.get(input.invocationId)
    if (!invocation?.accepting || this.#stop.signal.aborted)
      throw new Error('EXTENSION_AGENT_UNAVAILABLE')
    const signal = requestSignal ? AbortSignal.any([invocation.scope.signal, requestSignal]) : invocation.scope.signal
    signal.throwIfAborted()
    const contract = extensionAgentCapabilities[input.method]
    const context = this.#options.context({ ...invocation.scope, signal })
    const requests = invocation.requests.get(input.method) ?? { calls: 0, active: 0 }
    if (contract.limits && (requests.calls >= contract.limits.calls || requests.active >= contract.limits.concurrent))
      throw new Error(contract.limits.error)
    requests.calls++
    requests.active++
    invocation.requests.set(input.method, requests)
    const callNumber = requests.calls
    const identity = { invocationId: invocation.scope.invocationId, extensionId: invocation.scope.extensionId, conversationId: invocation.scope.conversationId, runId: invocation.scope.runId, requestId: randomUUID(), method: input.method }
    const startedAt = performance.now()
    let handler: 'completed' | 'failed' = 'failed'
    const pending = Promise.resolve().then(async () => {
      signal.throwIfAborted()
      const result = await this.#options.handlers[input.method](input.params, { ...context, callNumber })
      handler = 'completed'
      signal.throwIfAborted()
      return result
    }).finally(() => {
      requests.active--
      invocation.pending.delete(pending)
      this.#publish({ kind: 'request', stage: 'finished', ...identity, handler, response: signal.aborted ? 'cancelled' : handler === 'completed' ? 'returned' : 'failed', durationMs: Math.round(performance.now() - startedAt) })
    })
    invocation.pending.add(pending)
    this.#publish({ kind: 'request', stage: 'accepted', ...identity })
    return pending
  }

  #projection(context: BuddyCapabilityContext): ProjectionState {
    const existing = this.#projections.get(context.signal)
    if (existing)
      return existing
    const id = randomUUID()
    const release = () => {
      context.signal.removeEventListener('abort', release)
      this.#projections.delete(context.signal)
      this.#publish({ kind: 'capabilities-released', projectionId: id, conversationId: context.conversationId })
    }
    const projection: ProjectionState = { snapshot: { id, conversationId: context.conversationId, revision: 0, status: 'unavailable', descriptors: [] }, request: 0, release }
    this.#projections.set(context.signal, projection)
    context.signal.addEventListener('abort', release, { once: true })
    return projection
  }

  #acceptProjection(projection: ProjectionState, request: number, status: ExtensionCapabilityProjection['status'], descriptors: ExtensionAgentDescriptor[]): void {
    if (projection.request !== request)
      return
    if (projection.snapshot.revision && projection.snapshot.status === status && JSON.stringify(projection.snapshot.descriptors) === JSON.stringify(descriptors))
      return
    projection.snapshot = copyEventSnapshot({ ...projection.snapshot, revision: projection.snapshot.revision + 1, status, descriptors })
    this.#publish({ kind: 'capabilities', projection: projection.snapshot })
  }

  #publish(fact: ExtensionAgentFact): void {
    this.#changes.fire(copyEventSnapshot({ ...fact, revision: ++this.#revision }))
  }
}
