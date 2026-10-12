import type { Api, AssistantMessage, Context, Model } from '@earendil-works/pi-ai'
import type { BuddyInputReferenceV1 } from '../../context/BuddyInputReference'
import type { BuddyExtensionRunContextStore } from '../BuddyExtensionRunContext'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuddyInputReference, readBuddyInputReference } from '../../context/BuddyInputReference'
import { createReusableBuddySession } from '../../sessions/createReusableBuddySession'
import { createChatQueueExtension } from '../chatQueueExtension'
import { createInputReferenceExtension } from '../inputReferenceExtension'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

describe('native Pi follow-up extension', () => {
  it('continues one prompt as B steering, A follow-up and C follow-up across real tool cycles', async () => {
    const f = await fixture({ toolCalls: [1, 3] })
    const completion = f.prompt()
    await f.toolStarted.promise
    f.pending.splice(f.pending.indexOf('B'), 1)
    expect(f.reusable.steer?.(() => f.reference('B'))).toBe(true)
    expect(f.reusable.getInputContext?.().messages.map(readBuddyInputReference).filter(Boolean).map(input => input!.messageId)).toEqual(['initial', 'B'])
    f.toolRelease.resolve()
    await completion
    expect(f.contexts.map(context => context.messages.filter(message => message.role === 'user').map((message) => {
      const content = message.content
      return typeof content === 'string' ? content : content.find(block => block.type === 'text')?.text
    }))).toEqual([
      ['initial'],
      ['initial', 'B'],
      ['initial', 'B', 'A'],
      ['initial', 'B', 'A'],
      ['initial', 'B', 'A', 'C'],
    ])
    expect(f.events).toEqual(['user:initial', 'tool', 'user:B', 'agent_end', 'user:A', 'tool', 'agent_end', 'user:C', 'agent_end', 'agent_settled'])
    expect(f.pending).toEqual([])
    const messages = f.session.sessionManager.getBranch().flatMap(entry => entry.type === 'message' ? [entry.message] : [])
    expect(messages.map(readBuddyInputReference).filter(Boolean).map(input => input!.messageId)).toEqual(['initial', 'B', 'A', 'C'])
    expect(f.contexts[2]!.messages.some(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block.type === 'image'))).toBe(true)
    expect(JSON.stringify(messages)).not.toContain('offline-image-bytes')
    expect(f.session.agent.hasQueuedMessages()).toBe(false)
  })

  it('keeps ordinary inputs pending through an execution continuation while applying explicit steering', async () => {
    const f = await fixture({ toolCalls: [1], deferQueuedInputs: true })
    const completion = f.prompt()
    await f.toolStarted.promise
    f.pending.splice(f.pending.indexOf('B'), 1)
    expect(f.reusable.steer?.(() => f.reference('B'))).toBe(true)
    f.toolRelease.resolve()
    await completion
    expect(f.contexts).toHaveLength(2)
    expect(f.contexts[1]!.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([
      [{ type: 'text', text: 'initial' }],
      [{ type: 'text', text: 'B' }],
    ])
    expect(f.pending).toEqual(['A', 'C'])
    expect(f.events).toEqual(['user:initial', 'tool', 'user:B', 'agent_end', 'agent_settled'])
    await f.reusable.finishTurn()
    expect(f.pending).toEqual(['A', 'C'])
  })

  it.each(['error', 'aborted'] as const)('retains every pending input after native %s', async (stopReason) => {
    const f = await fixture({ stopReason })
    await f.prompt()
    expect(f.contexts).toHaveLength(1)
    expect(f.pending).toEqual(['A', 'B', 'C'])
    expect(f.events).toEqual(['user:initial', 'agent_end', 'agent_settled'])
  })

  it('keeps pending follow-ups when stopped while an awaited extension validates the next input', async () => {
    const gate = Promise.withResolvers<void>()
    const validating = Promise.withResolvers<void>()
    const f = await fixture({ validate: async () => {
      validating.resolve()
      await gate.promise
    } })
    const completion = f.prompt()
    await validating.promise
    f.controller.abort()
    const stopped = f.reusable.abort()
    gate.resolve()
    await Promise.all([stopped, completion])
    expect(f.contexts).toHaveLength(1)
    expect(f.pending).toEqual(['A', 'B', 'C'])
    expect(f.session.agent.hasQueuedMessages()).toBe(false)
    expect(f.events.filter(event => event === 'agent_settled')).toHaveLength(1)
  })

  it('clears a submitted but unconsumed native follow-up when stopped at agent_end', async () => {
    const f = await fixture()
    f.session.subscribe((event) => {
      if (event.type === 'agent_end') {
        f.controller.abort()
        void f.reusable.abort()
      }
    })
    await f.prompt()
    expect(f.contexts).toHaveLength(1)
    expect(f.pending).toEqual(['B', 'C'])
    expect(f.session.agent.hasQueuedMessages()).toBe(false)
    expect(f.events).not.toContain('user:A')
  })

  it('leaves a follow-up using a different skill revision uncommitted for the next session', async () => {
    const f = await fixture({ skillMismatch: true })
    await f.prompt()
    expect(f.contexts).toHaveLength(1)
    expect(f.pending).toEqual(['A', 'B', 'C'])
    expect(f.session.messages.map(readBuddyInputReference).filter(Boolean).map(input => input!.messageId)).toEqual(['initial'])
  })
})

async function fixture(options: {
  toolCalls?: number[]
  stopReason?: 'error' | 'aborted'
  validate?: () => Promise<void>
  skillMismatch?: boolean
  deferQueuedInputs?: boolean
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'buddy-native-queue-'))
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
  await runtime.setRuntimeApiKey('openai', 'offline-test-only')
  const model = runtime.getModel('openai', 'gpt-4o-mini')!
  const controller = new AbortController()
  const runContext: BuddyExtensionRunContextStore = { current: null }
  const inputReferences = { pending: null }
  const pending = ['A', 'B', 'C']
  const events: string[] = []
  const contexts: Context[] = []
  const toolStarted = Promise.withResolvers<void>()
  const toolRelease = Promise.withResolvers<void>()
  const skill = { id: 'skill', name: 'workflow', revision: 'one' }
  const reference = (id: string) => createBuddyInputReference({
    messageId: id,
    prompt: id,
    attachmentIds: id === 'A' ? ['a-image'] : [],
    images: id === 'A' ? [{ attachmentId: 'a-image', mimeType: 'image/png' }] : [],
  })
  let enqueue: (prepare: () => BuddyInputReferenceV1) => boolean = () => false
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })
  const agentDir = join(root, 'agent')
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      createInputReferenceExtension(inputReferences),
      createChatQueueExtension({
        getRunContext: () => runContext.current,
        followUp: async (_runId, signal) => {
          await options.validate?.()
          if (signal.aborted)
            return
          const id = pending[0]
          if (id) {
            enqueue(() => {
              pending.shift()
              return reference(id)
            })
          }
        },
      }),
      { name: 'offline-tool', factory(pi) {
        pi.registerTool({ name: 'probe', label: 'Probe', description: 'Offline gated tool', parameters: Type.Object({}), async execute(_id, _parameters, signal) {
          events.push('tool')
          toolStarted.resolve()
          signal?.addEventListener('abort', () => toolRelease.resolve(), { once: true })
          await toolRelease.promise
          return { content: [{ type: 'text', text: 'done' }], details: {} }
        } })
      } },
    ],
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model, settingsManager, sessionManager: SessionManager.inMemory(root), resourceLoader, tools: ['probe'] })
  await session.bindExtensions({ mode: 'rpc' })
  session.agent.streamFunction = (requestModel, context) => {
    contexts.push(JSON.parse(JSON.stringify(context)))
    const index = contexts.length
    return terminalStream(requestModel, options.toolCalls?.includes(index)
      ? { stopReason: 'toolUse', content: [{ type: 'toolCall', id: `call-${index}`, name: 'probe', arguments: {} }] }
      : { stopReason: options.stopReason ?? 'stop' })
  }
  const reusable = createReusableBuddySession({
    session,
    runContext,
    inputReferences,
    skillReferences: [skill],
    assertModelAccess: async () => model,
    materializeInput: async input => [{ type: 'text', text: input.prompt }, ...input.images.map(image => ({ type: 'image' as const, mimeType: image.mimeType, data: 'offline-image-bytes' }))],
    shutdown: async () => { session.dispose() },
  })
  enqueue = prepare => reusable.followUp!(prepare, options.skillMismatch ? [{ ...skill, revision: 'two' }] : [])
  await reusable.activateTurn({ generation: 0, deferQueuedInputs: options.deferQueuedInputs, runId: 'run-initial', model: model.id, provider: model.provider, contextWindow: null, maxTokens: null, signal: controller.signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {}, onToolExecutionDenied: async () => {} })
  session.subscribe((event) => {
    if (event.type === 'agent_end' || event.type === 'agent_settled')
      events.push(event.type)
    if (event.type === 'message_start' && event.message.role === 'user') {
      const content = event.message.content
      events.push(`user:${readBuddyInputReference(event.message)?.messageId ?? (typeof content === 'string' ? content : content.find(block => block.type === 'text')?.text)}`)
    }
  })
  cleanups.push(async () => {
    controller.abort()
    toolRelease.resolve()
    await reusable.abort()
    session.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { session, reusable, controller, pending, reference, events, contexts, toolStarted, toolRelease, prompt: () => reusable.prompt('initial', { source: 'rpc', inputReference: reference('initial') }) }
}

function terminalStream(model: Model<Api>, overrides: Partial<AssistantMessage>) {
  const message: AssistantMessage = {
    api: model.api,
    model: model.id,
    provider: model.provider,
    role: 'assistant',
    stopReason: 'stop',
    timestamp: Date.now(),
    content: [{ type: 'text', text: 'Offline response' }],
    usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...overrides,
  }
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => {
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
      stream.push({ type: 'error', error: message, reason: message.stopReason })
    else
      stream.push({ type: 'done', message, reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop' })
  })
  return stream
}
