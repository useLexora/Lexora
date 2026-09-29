import type { ListenerErrorHandler } from '../../../shared/events/Emitter'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { ExtensionAgentCatalog, ExtensionAgentDescriptor, ExtensionAgentInvocation } from '../../../shared/extensions/extensionAgent'
import type { ExtensionAgentMethod } from '../../../shared/extensions/extensionAgentCapabilities'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { JsonValue } from '../../../shared/workbench/workbenchState'
import type { BuddyCapability, BuddyCapabilityContext } from '../agent/extensions/BuddyCapability'
import type { ExtensionAgentChange, ExtensionAgentFact, ExtensionCapabilityProjection } from './ExtensionAgentEvents'
import type { ExtensionAgentHandlers, ExtensionInvocationScope } from './extensionAgentHandlers'
import { createHash, randomUUID } from 'node:crypto'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { z } from 'zod'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { extensionAgentCatalogSchema, extensionAgentDescriptorSchema, extensionAgentRequestSchema, extensionAgentRpc } from '../../../shared/extensions/extensionAgent'
import { extensionAgentCapabilities } from '../../../shared/extensions/extensionAgentCapabilities'
import { extensionJsonSchema } from '../../../shared/extensions/extensionApi'
import { extensionIdSchema } from '../../../shared/extensions/extensionManifest'
import { ExtensionInvocationQueue } from './ExtensionInvocationQueue'

interface Invocation {
  scope: ExtensionInvocationScope
  handlers: ExtensionAgentHandlers
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
  createHandlers: (scope: ExtensionInvocationScope) => ExtensionAgentHandlers
  onObserverError?: ListenerErrorHandler
}
type InvocationRequest = { tool: string, input: Record<string, string | number | boolean> } | { action: string, cause: NonNullable<ExtensionInvocationScope['action']>['cause'] }

export class ExtensionAgentRuntime {
  readonly #options: ExtensionAgentRuntimeOptions
  readonly #invocations = new Map<string, Invocation>()
  readonly #queue = new ExtensionInvocationQueue()
  readonly #projections = new Map<AbortSignal, ProjectionState>()
  readonly #changes: Emitter<ExtensionAgentChange>
  readonly onDidChange
  readonly #stop = new AbortController()
  #revision = 0
  #catalog = new Map<string, ExtensionAgentCatalog[number]>()
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
    const request = this.#options.rpc.onRequest(extensionAgentRpc.request, (input, signal) => this.#request(input, signal))
    const changed = this.#options.rpc.onNotification((method, params) => {
      if (method === extensionAgentRpc.changed)
        this.#setCatalog(extensionAgentCatalogSchema.parse(params))
    })
    return () => {
      request()
      changed()
    }
  }

  async descriptors(signal: AbortSignal): Promise<ExtensionAgentDescriptor[]> {
    signal.throwIfAborted()
    return z.array(extensionAgentDescriptorSchema.extend({ id: extensionIdSchema })).parse(await this.#options.rpc.request(extensionAgentRpc.list, {}, 10000, AbortSignal.any([signal, this.#stop.signal])))
  }

  async invoke(descriptor: ExtensionAgentDescriptor, request: InvocationRequest, scope: Omit<ExtensionInvocationScope, 'extensionId' | 'invocationId' | 'signal'>, signal: AbortSignal, invocationId = randomUUID()): Promise<JsonValue> {
    const controller = new AbortController()
    const abort = AbortSignal.any([signal, this.#stop.signal, controller.signal])
    abort.throwIfAborted()
    let settle!: () => void
    const invocationScope = { ...scope, extensionId: descriptor.id, invocationId, signal: abort }
    const invocation: Invocation = { scope: invocationScope, handlers: this.#options.createHandlers(invocationScope), requests: new Map(), pending: new Set(), accepting: true, settled: new Promise<void>(resolve => settle = resolve), settle: () => settle() }
    const release = await this.#queue.acquire(descriptor.id, invocationId, abort)
    try {
      abort.throwIfAborted()
      return await this.#execute(descriptor, request, invocation, controller)
    }
    finally {
      release()
    }
  }

  async #execute(descriptor: ExtensionAgentDescriptor, request: InvocationRequest, invocation: Invocation, controller: AbortController): Promise<JsonValue> {
    const scope = invocation.scope
    const { invocationId, signal: abort } = scope
    const timeout = setTimeout(() => controller.abort(new DOMException('Extension invocation timed out', 'TimeoutError')), 120000)
    this.#invocations.set(invocationId, invocation)
    const identity = { invocationId, extensionId: descriptor.id, conversationId: scope.conversationId, runId: scope.runId, ...(scope.action ? { actionId: scope.action.id, trigger: scope.action.cause.type } : {}) }
    const startedAt = performance.now()
    let outcome: 'completed' | 'failed' | 'cancelled' = 'completed'
    this.#publish({ kind: 'invocation', stage: 'started', ...identity })
    try {
      const input: ExtensionAgentInvocation = { extensionId: descriptor.id, revision: descriptor.revision, configurationRevision: descriptor.configurationRevision, invocationId, context: { taskId: scope.conversationId, runId: scope.runId }, ...request }
      const result = extensionJsonSchema.parse(await this.#options.rpc.request(extensionAgentRpc.invoke, input, 125000, abort))
      abort.throwIfAborted()
      return result
    }
    catch (error) {
      const revoked = z.object({ data: z.object({ code: z.enum(['EXTENSION_AGENT_CANCELLED', 'EXTENSION_AGENT_UNAVAILABLE']) }) }).safeParse(error).success
      outcome = abort.aborted || revoked ? 'cancelled' : 'failed'
      if (revoked)
        throw new DOMException('Extension invocation revoked', 'AbortError')
      throw error
    }
    finally {
      clearTimeout(timeout)
      invocation.accepting = false
      this.#publish({ kind: 'invocation', stage: 'returned', outcome, durationMs: Math.round(performance.now() - startedAt), ...identity })
      controller.abort()
      await Promise.allSettled([...invocation.pending])
      this.#invocations.delete(invocationId)
      this.#publish({ kind: 'invocation', stage: 'settled', outcome, durationMs: Math.round(performance.now() - startedAt), ...identity })
      invocation.settle()
    }
  }

  async capabilities(context: BuddyCapabilityContext): Promise<BuddyCapability[]> {
    context.signal.throwIfAborted()
    this.#stop.signal.throwIfAborted()
    const projection = this.#projection(context)
    const request = ++projection.request
    const catalog = this.#catalog
    try {
      const descriptors = await this.descriptors(context.signal)
      context.signal.throwIfAborted()
      this.#stop.signal.throwIfAborted()
      if (catalog === this.#catalog)
        this.#setCatalog(descriptors)
      const current = descriptors.filter(descriptor => this.#isCurrent(descriptor))
      this.#acceptProjection(projection, request, 'accepted', current)
      return current.filter(descriptor => descriptor.agent.tools.length).map(descriptor => this.#capability(context, descriptor))
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

  #setCatalog(catalog: ExtensionAgentCatalog): void {
    this.#catalog = new Map(catalog.map(({ id, revision, configurationRevision }) => [id, { id, revision, configurationRevision }]))
  }

  #isCurrent(descriptor: ExtensionAgentCatalog[number]): boolean {
    const current = this.#catalog.get(descriptor.id)
    return current?.revision === descriptor.revision && current.configurationRevision === descriptor.configurationRevision
  }

  #capability(context: BuddyCapabilityContext, inputDescriptor: ExtensionAgentDescriptor): BuddyCapability {
    const descriptor: EventSnapshot<ExtensionAgentDescriptor> = copyEventSnapshot(inputDescriptor)
    const prefix = `plugin_${createHash('sha256').update(descriptor.id).digest('hex').slice(0, 12)}`
    const names = new Map(descriptor.agent.tools.map(tool => [tool.id, `lexora_plugin_${createHash('sha256').update(tool.id).digest('hex').slice(0, 16)}`]))
    const instructions = descriptor.agent.instructions.replace(/\{\{([^}]+)\}\}/g, (_match, id: string) => names.get(id) ?? id)
    const tools = descriptor.agent.tools.map(tool => ({ ...tool, name: names.get(tool.id)!, schema: Type.Object(Object.fromEntries(Object.entries(tool.parameters.properties).map(([key, property]) => {
      const options = { description: property.description }
      const value = property.type === 'string' ? Type.String({ ...options, maxLength: 32768 }) : property.type === 'boolean' ? Type.Boolean(options) : Type.Number(options)
      return [key, tool.parameters.required.includes(key) ? value : Type.Optional(value)]
    })), { additionalProperties: false }) }))
    return {
      resourceRevisions: [{ source: 'plugin', id: descriptor.id, revision: JSON.stringify([descriptor.revision, descriptor.configurationRevision]) }],
      disclosure: [{
        source: { kind: 'plugin', id: descriptor.id, title: descriptor.name },
        exposure: 'on_demand',
        keywords: 'plugin extension 插件 扩展',
        tools: tools.map(tool => ({ name: tool.name, id: tool.id, title: tool.title })),
        available: () => !context.signal.aborted && !this.#stop.signal.aborted && this.#isCurrent(descriptor),
      }],
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
                if (!runId || !Check(tool.schema, input))
                  throw new Error('EXTENSION_AGENT_UNAVAILABLE')
                try {
                  const result = await this.invoke(inputDescriptor, { tool: tool.id, input }, { conversationId: context.conversationId, runId }, signal ?? new AbortController().signal)
                  return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { ok: true, result } }
                }
                catch (error) {
                  const code = error instanceof Error ? error.message.match(/EXTENSION_[A-Z_]+/)?.[0] : null
                  return { content: [{ type: 'text', text: code ?? 'EXTENSION_AGENT_FAILED' }], details: { ok: false, result: null }, isError: true }
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
    const context = { ...invocation.scope, signal }
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
      const result = await invocation.handlers[input.method](input.params, { ...context, callNumber })
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
