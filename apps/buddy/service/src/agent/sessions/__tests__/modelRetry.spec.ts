import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import type { ModelRetryLimit } from '../../../../../shared/runtime/runtimePreferences'
import type { BuddyExtensionRunContextStore } from '../../extensions/BuddyExtensionRunContext'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModelSwitchExtension } from '../../extensions/modelSwitchExtension'
import { createReusableBuddySession } from '../createReusableBuddySession'
import { createIsolatedBuddySession } from './isolatedBuddySession'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

describe('model retry policy', () => {
  it('keeps an in-flight response on its model and uses the selected model for the next tool step', async () => {
    const fixture = await createFixture(() => undefined, [], true)
    const first = createAssistantMessageEventStream()
    const started = Promise.withResolvers<void>()
    const requests: string[] = []
    vi.spyOn(fixture.runtime, 'streamSimple').mockImplementation((model) => {
      requests.push(model.id)
      if (requests.length > 1)
        return response(model)
      started.resolve()
      return first
    })
    const release = await fixture.activate(2)
    const prompt = fixture.reusable.prompt('Inspect the current directory')
    await started.promise
    fixture.selectNextModel()
    const original = await response(fixture.models[0]!).result()
    first.push({ type: 'done', reason: 'toolUse', message: { ...original, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'inspect', name: 'ls', arguments: { path: '.' } }] } })
    await prompt
    expect(requests).toEqual([fixture.models[0]!.id, fixture.models[1]!.id])
    expect(fixture.session.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(fixture.session.messages.at(-1)).toMatchObject({ model: fixture.models[1]!.id, stopReason: 'stop' })
    release()
  })
  it('switches a waiting retry immediately without resubmitting input or rewriting the failed model', async () => {
    const requests: string[] = []
    const fixture = await createFixture((model) => {
      requests.push(model.id)
      return requests.length === 1 ? '503 service unavailable' : undefined
    }, [], true)
    const release = await fixture.activate(2)
    const waiting = Promise.withResolvers<void>()
    fixture.session.subscribe(event => event.type === 'auto_retry_start' && waiting.resolve())
    fixture.session.settingsManager.applyOverrides({ retry: { baseDelayMs: 60_000 } })
    const prompt = fixture.reusable.prompt('Switch the failing model')
    await waiting.promise
    fixture.selectNextModel()
    await prompt
    expect(requests).toEqual([fixture.models[0]!.id, fixture.models[1]!.id])
    expect(fixture.session.messages.at(-1)).toMatchObject({ model: fixture.models[1]!.id, stopReason: 'stop' })
    const entries = fixture.session.sessionManager.getEntries()
    expect(entries.filter(entry => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(1)
    expect(entries.some(entry => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.model === fixture.models[0]!.id && entry.message.stopReason === 'error')).toBe(true)
    release()
  })

  it('preserves the remaining retry budget and progress after switching models', async () => {
    const requests: string[] = []
    const fixture = await createFixture((model) => {
      requests.push(model.id)
      return '503 service unavailable'
    }, [], true)
    const release = await fixture.activate(2)
    const waiting = Promise.withResolvers<void>()
    const attempts: number[] = []
    fixture.reusable.subscribe((event) => {
      if (event.type === 'auto_retry_start') {
        attempts.push(event.attempt)
        expect(event.maxAttempts).toBe(2)
        waiting.resolve()
      }
    })
    const prompt = fixture.reusable.prompt('Keep the retry budget')
    await waiting.promise
    fixture.selectNextModel()
    await prompt
    expect(requests).toEqual([fixture.models[0]!.id, fixture.models[1]!.id, fixture.models[1]!.id])
    expect(attempts).toEqual([1, 2])
    release()
  })
  it.each([1, 2, 'unlimited'] as const)('restores the %s retry budget for the next tool step after switching models', async (limit) => {
    const fixture = await createFixture(() => undefined, [], true)
    const failures = limit === 'unlimited' ? 2 : limit
    const requests: string[] = []
    vi.spyOn(fixture.runtime, 'streamSimple').mockImplementation((model) => {
      requests.push(model.id)
      if (requests.length === 2) {
        const stream = createAssistantMessageEventStream()
        void response(model).result().then(message => stream.push({ type: 'done', reason: 'toolUse', message: { ...message, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'inspect', name: 'ls', arguments: { path: '.' } }] } }))
        return stream
      }
      return response(model, requests.length <= failures + 2 ? '503 service unavailable' : undefined)
    })
    const release = await fixture.activate(limit)
    const waiting = Promise.withResolvers<void>()
    const attempts: number[] = []
    fixture.reusable.subscribe((event) => {
      if (event.type === 'auto_retry_start') {
        attempts.push(event.attempt)
        waiting.resolve()
      }
    })
    const prompt = fixture.reusable.prompt('Retry each tool step independently')
    await waiting.promise
    fixture.selectNextModel()
    await prompt
    expect(requests).toEqual([fixture.models[0]!.id, ...Array.from({ length: failures + 2 }, () => fixture.models[1]!.id)])
    expect(attempts).toEqual([1, ...Array.from({ length: failures }, (_, index) => index + 1)])
    expect(fixture.session.messages.at(-1)).toMatchObject({ model: fixture.models[1]!.id, stopReason: 'stop' })
    release()
  })

  it.each([
    [[{ type: 'text' as const, text: 'Already delivered output' }]],
    [[{ type: 'toolCall' as const, id: 'side-effect', name: 'write', arguments: { path: 'result', content: 'written' } }]],
  ])('preserves committed output without replaying a failed request', async (content) => {
    let requests = 0
    const fixture = await createFixture(() => {
      requests++
      return '503 service unavailable'
    }, content)
    const release = await fixture.activate('unlimited')
    await fixture.reusable.prompt('Keep partial progress')
    expect(requests).toBe(1)
    expect(fixture.session.messages.at(-1)).toMatchObject({ stopReason: 'error', content })
    release()
  })

  it.each([0, 2, 'unlimited'] as const)('executes the %s budget without duplicating the user input', async (limit) => {
    let requests = 0
    const fixture = await createFixture(() => ++requests <= 5 ? 'server_busy' : undefined)
    const release = await fixture.activate(limit)
    await fixture.reusable.prompt('Retry the model request')
    expect(requests).toBe(limit === 'unlimited' ? 6 : limit + 1)
    expect(fixture.session.messages.at(-1)).toMatchObject({ stopReason: limit === 'unlimited' ? 'stop' : 'error' })
    expect(fixture.session.sessionManager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(1)
    release()
  })

  it.each(['401 invalid api key', '429 insufficient_quota', '403 forbidden', '400 server_error'])('does not retry %s even with an unlimited budget', async (failure) => {
    let requests = 0
    const fixture = await createFixture(() => {
      requests++
      return failure
    })
    const release = await fixture.activate('unlimited')
    await fixture.reusable.prompt('Do not repeat a permanent failure')
    expect(requests).toBe(1)
    expect(fixture.session.messages.at(-1)).toMatchObject({ stopReason: 'error' })
    release()
  })

  it('cancels unlimited backoff without sending another request', async () => {
    let requests = 0
    const fixture = await createFixture(() => {
      requests++
      return '429 rate limit'
    })
    const release = await fixture.activate('unlimited')
    const waiting = Promise.withResolvers<void>()
    fixture.session.subscribe((event) => {
      if (event.type === 'auto_retry_start')
        waiting.resolve()
    })
    fixture.session.settingsManager.applyOverrides({ retry: { baseDelayMs: 60_000 } })
    const prompt = fixture.reusable.prompt('Cancel this retry')
    await waiting.promise
    await fixture.reusable.abort()
    await prompt
    expect(requests).toBe(1)
    expect(fixture.session.isRetrying).toBe(false)
    release()
  })

  it('freezes the running budget through cache warming changes and applies the new limit on reuse', async () => {
    let requests = 0
    const fixture = await createFixture(() => {
      requests++
      return '503 service unavailable'
    })
    let release = await fixture.activate(2)
    fixture.reusable.applyPreferences({ cacheWarming: 'streaming', codemode: false, modelRetryLimit: 0 })
    fixture.reusable.applyPreferences({ cacheWarming: 'off', codemode: false, modelRetryLimit: 0 })
    fixture.session.settingsManager.applyOverrides({ retry: { baseDelayMs: 1 } })
    await fixture.reusable.prompt('First run')
    expect(requests).toBe(3)
    release()
    release = await fixture.activate()
    await fixture.reusable.prompt('Second run')
    expect(requests).toBe(4)
    release()
  })
})

async function createFixture(failure: (model: Model<Api>) => string | undefined, failureContent: AssistantMessage['content'] = [], liveSelection = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-model-retry-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
  const models = runtime.getModels().filter(model => model.provider === 'anthropic').slice(0, 2)
  const model = models[0]!
  let selected = model
  const runContext: BuddyExtensionRunContextStore = { current: null }
  await runtime.setRuntimeApiKey(model.provider, 'offline-fixture')
  vi.spyOn(runtime, 'streamSimple').mockImplementation(target => response(target, failure(target), failureContent))
  const created = await createIsolatedBuddySession({
    agentDir: join(root, 'agent'),
    canonicalRoot: root,
    cwd: root,
    conversationsDirectory: join(root, 'conversations'),
    conversationId: 'retry-conversation',
    branchId: 'retry-branch',
    approvalPolicy: 'policy',
    executionProfile: 'read_only',
    model,
    modelRuntime: runtime,
    thinkingLevel: 'off',
    resources: { skillReadRoots: [], skillReferences: [], approvedSkills: [], context: { agentsFiles: [], diagnostics: [] }, directoryContext: '', revision: 'empty' },
    inProcessExtensions: [createModelSwitchExtension(runContext)],
  })
  const { session } = created
  session.settingsManager.setCompactionEnabled(false)
  const reusable = createReusableBuddySession({
    session,
    shutdown: created.shutdown,
    assertModelAccess: async (_provider, id) => models.find(model => model.id === id)!,
    getModelSelection: liveSelection ? async () => ({ provider: selected.provider, model: selected.id, contextWindow: selected.contextWindow, maxTokens: selected.maxTokens, thinkingLevel: 'off' }) : undefined,
    runContext,
    inputReferences: { pending: null },
    materializeInput: async input => input.prompt,
  })
  cleanups.push(() => reusable.shutdown('quit'))
  let run = 0
  async function activate(limit?: ModelRetryLimit) {
    if (limit !== undefined)
      reusable.applyPreferences({ cacheWarming: 'off', codemode: false, modelRetryLimit: limit })
    const release = await reusable.activateTurn({
      runId: `retry-run-${++run}`,
      provider: model.provider,
      model: model.id,
      contextWindow: null,
      maxTokens: null,
      signal: new AbortController().signal,
      flushProjectedEvents: async () => {},
      onToolExecutionAuthorized: async () => {},
      onToolExecutionDenied: async () => {},
    })
    session.settingsManager.applyOverrides({ retry: { baseDelayMs: 1 } })
    return release
  }
  return {
    session,
    reusable,
    activate,
    models,
    runtime,
    selectNextModel: () => {
      selected = models[1]!
      reusable.refreshModelSelection?.()
    },
  }
}

function response(model: Model<Api>, failure?: string, failureContent: AssistantMessage['content'] = []) {
  const message: AssistantMessage = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    role: 'assistant',
    timestamp: Date.now(),
    content: failure ? failureContent : [{ type: 'text', text: 'Recovered' }],
    stopReason: failure ? 'error' : 'stop',
    errorMessage: failure,
    usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => stream.push(failure ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: 'stop', message }))
  return stream
}
