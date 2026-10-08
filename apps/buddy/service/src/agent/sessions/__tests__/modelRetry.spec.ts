import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import type { ModelRetryLimit } from '../../../../../shared/runtime/runtimePreferences'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReusableBuddySession } from '../createReusableBuddySession'
import { createIsolatedBuddySession } from './isolatedBuddySession'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

describe('model retry policy', () => {
  it('retries a busy provider within the same run and input', async () => {
    let requests = 0
    const fixture = await createFixture(() => ++requests === 1 ? 'server_busy' : undefined)
    const release = await fixture.activate(1)
    await fixture.reusable.prompt('Retry the busy provider')
    expect(requests).toBe(2)
    expect(fixture.session.messages.at(-1)).toMatchObject({ stopReason: 'stop' })
    expect(fixture.session.sessionManager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(1)
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
    const fixture = await createFixture(() => ++requests <= 5 ? '503 service unavailable' : undefined)
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
    expect(fixture.session.settingsManager.getRetrySettings()).toMatchObject({ enabled: true, maxRetries: 2 })
    fixture.reusable.applyPreferences({ cacheWarming: 'off', codemode: false, modelRetryLimit: 0 })
    fixture.session.settingsManager.applyOverrides({ retry: { baseDelayMs: 1 } })
    await fixture.reusable.prompt('First run')
    expect(requests).toBe(3)
    release()
    release = await fixture.activate()
    expect(fixture.session.settingsManager.getRetrySettings()).toMatchObject({ enabled: false, maxRetries: 0 })
    await fixture.reusable.prompt('Second run')
    expect(requests).toBe(4)
    release()
  })
})

async function createFixture(failure: () => string | undefined, failureContent: AssistantMessage['content'] = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-model-retry-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
  const model = runtime.getModels().find(model => model.provider === 'anthropic')!
  await runtime.setRuntimeApiKey(model.provider, 'offline-fixture')
  vi.spyOn(runtime, 'streamSimple').mockImplementation(target => response(target, failure(), failureContent))
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
    inProcessExtensions: [],
  })
  cleanups.push(() => created.shutdown('quit'))
  const { session } = created
  session.settingsManager.setCompactionEnabled(false)
  const reusable = createReusableBuddySession({
    session,
    shutdown: created.shutdown,
    assertModelAccess: async () => model,
    runContext: { current: null },
    inputReferences: { pending: null },
    materializeInput: async input => input.prompt,
  })
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
  return { session, reusable, activate }
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
