import type { ConversationTimelineChangeNotice } from '../../../shared/conversation/conversationApi'
import type { TaskActionEvent } from '../../../shared/conversation/taskEvents'
import type { ListenerErrorHandler } from '../../../shared/events/Emitter'
import type { ExtensionActionCause, ExtensionAgentDescriptor } from '../../../shared/extensions/extensionAgent'
import type { ExtensionInvocationRepository } from '../storage/extensionInvocationRepository'
import type { ExtensionAgentRuntime } from './ExtensionAgentRuntime'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../shared/events/Emitter'
import { extensionActionResultSchema } from '../../../shared/extensions/extensionAgent'

interface Options {
  runtime: Pick<ExtensionAgentRuntime, 'descriptors' | 'invoke'>
  repository: ExtensionInvocationRepository
  capture: (conversationId: string, cause: ExtensionActionCause) => { branchId: string, sourceMessageId: string | null } | null
  onObserverError?: ListenerErrorHandler
}

export class ExtensionActionService {
  readonly #options: Options
  readonly #stop = new AbortController()
  readonly #pending = new Map<Promise<unknown>, { conversationId: string, controller: AbortController }>()
  readonly #actions = new Map<string, { controller: AbortController, settled: Promise<void> }>()
  readonly #failed: Emitter<Readonly<{ conversationId: string, errorCode: string }>>
  readonly #changed: Emitter<ConversationTimelineChangeNotice>
  readonly #sourceId = randomUUID()
  #revision = 0
  readonly onDidFail
  readonly onDidChange

  constructor(options: Options) {
    this.#options = options
    this.#failed = new Emitter(options.onObserverError ?? (() => {}))
    this.onDidFail = this.#failed.event
    this.#changed = new Emitter(options.onObserverError ?? (() => {}))
    this.onDidChange = this.#changed.event
    options.repository.recover()
  }

  async list(signal = this.#stop.signal) {
    return (await this.#options.runtime.descriptors(signal)).flatMap(plugin => plugin.agent.actions
      .filter(action => action.triggers.includes('user'))
      .map(action => ({ extensionId: plugin.id, actionId: action.id, title: action.title })))
  }

  dispatch(event: TaskActionEvent): void {
    const conversationId = event.data.conversationId
    if (event.type === 'task:input:committed')
      this.cancel(conversationId)
    void this.#track(conversationId, async (signal) => {
      const plugins = await this.#options.runtime.descriptors(signal)
      signal.throwIfAborted()
      const results = await Promise.allSettled(plugins.flatMap(plugin => plugin.agent.actions.filter(action => action.triggers.includes(event.type)).map(action =>
        this.#invoke(plugin, action.id, conversationId, event, signal))))
      signal.throwIfAborted()
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected')
        throw failed.reason
    }).catch((error) => {
      if (error instanceof Error && error.name === 'AbortError')
        return
      this.#failed.fire({ conversationId, errorCode: error instanceof Error ? error.message.match(/EXTENSION_[A-Z_]+/)?.[0] ?? 'EXTENSION_ACTION_FAILED' : 'EXTENSION_ACTION_FAILED' })
    })
  }

  invoke(input: { conversationId: string, extensionId: string, actionId: string }, signal?: AbortSignal) {
    return this.#track(input.conversationId, async (signal) => {
      const plugin = (await this.#options.runtime.descriptors(signal)).find(plugin => plugin.id === input.extensionId && plugin.agent.actions.some(action => action.id === input.actionId && action.triggers.includes('user')))
      if (!plugin)
        throw new Error('EXTENSION_ACTION_UNAVAILABLE')
      return this.#invoke(plugin, input.actionId, input.conversationId, { type: 'user' }, signal)
    }, signal)
  }

  cancel(conversationId?: string): void {
    for (const pending of this.#pending.values()) {
      if (!conversationId || pending.conversationId === conversationId)
        pending.controller.abort()
    }
  }

  async dispose(): Promise<void> {
    this.#stop.abort()
    await Promise.allSettled([...this.#pending.keys()])
    this.#failed.dispose()
    this.#changed.dispose()
  }

  #track<T>(conversationId: string, execute: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#pending.size >= 64)
      return Promise.reject(new Error('EXTENSION_REQUEST_LIMIT'))
    const controller = new AbortController()
    const abort = AbortSignal.any([this.#stop.signal, controller.signal, ...signal ? [signal] : []])
    const pending = Promise.resolve().then(() => {
      abort.throwIfAborted()
      return execute(abort)
    }).finally(() => this.#pending.delete(pending))
    this.#pending.set(pending, { conversationId, controller })
    return pending
  }

  async #invoke(plugin: ExtensionAgentDescriptor, actionId: string, conversationId: string, cause: ExtensionActionCause, signal: AbortSignal) {
    const key = JSON.stringify([conversationId, plugin.id, actionId])
    while (this.#actions.has(key)) {
      const previous = this.#actions.get(key)!
      if (cause.type === 'user')
        previous.controller.abort()
      await previous.settled
      signal.throwIfAborted()
    }
    signal.throwIfAborted()
    const context = this.#options.capture(conversationId, cause)
    if (!context)
      return { status: 'skipped' as const }
    const controller = new AbortController()
    const abort = AbortSignal.any([controller.signal, signal])
    let settle!: () => void
    const state = { controller, settled: new Promise<void>(resolve => settle = resolve) }
    this.#actions.set(key, state)
    const invocationId = randomUUID()
    let status: 'completed' | 'skipped' | 'failed' | 'cancelled' = 'failed'
    let message: string | null = null
    const changed = () => this.#changed.fire({ sourceId: this.#sourceId, revision: ++this.#revision, conversationId, branchId: context.branchId })
    try {
      this.#options.repository.start({ id: invocationId, extensionId: plugin.id, extensionName: plugin.name, title: plugin.agent.actions.find(action => action.id === actionId)!.title, actionId, conversationId, ...context, trigger: cause.type, startedAt: new Date().toISOString() })
      changed()
      const result = extensionActionResultSchema.parse(await this.#options.runtime.invoke(plugin, { action: actionId, cause }, { conversationId, runId: null, action: { id: actionId, cause } }, abort, invocationId))
      status = result.status
      message = result.message ?? null
      return result
    }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        status = 'cancelled'
      throw error
    }
    finally {
      if (abort.aborted)
        status = 'cancelled'
      try {
        this.#options.repository.finish(invocationId, status, message)
        changed()
      }
      finally {
        this.#actions.delete(key)
        settle()
      }
    }
  }
}
