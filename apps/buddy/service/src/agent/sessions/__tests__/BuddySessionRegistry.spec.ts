import { describe, expect, it, vi } from 'vitest'

import { BuddySessionRegistry } from '../BuddySessionRegistry'

describe('buddySessionRegistry', () => {
  it('acknowledges recovery only for the current immutable binding incarnation', async () => {
    const registry = new BuddySessionRegistry<TestSession>()
    const sessionIdentity = identity('branch-1')
    const recovered = await registry.getOrCreate(sessionIdentity, null, async () => ({ piSessionFile: '/sessions/one', session: new TestSession(), recoveredFromProductHistory: true, recoveryDegradation: { missingAttachmentIds: ['missing-attachment'], recoveredImageCount: 0 } }))
    expect(registry.snapshot()[0]?.recoveryPending).toBe(true)
    expect(registry.acknowledgeRecovery(sessionIdentity, recovered)).toBe(true)
    expect(recovered.recoveredFromProductHistory).toBe(true)
    expect(registry.snapshot()[0]?.recoveryPending).toBe(false)
    const current = await registry.getOrCreate(sessionIdentity, '/sessions/one', async () => {
      throw new Error('must reuse')
    })
    expect(current.recoveredFromProductHistory).toBeUndefined()
    expect(registry.acknowledgeRecovery(sessionIdentity, recovered)).toBe(false)
    await registry.invalidateAll()
    const replacement = await registry.getOrCreate(sessionIdentity, null, async () => ({ piSessionFile: '/sessions/two', session: new TestSession(), recoveredFromProductHistory: true }))
    expect(registry.acknowledgeRecovery(sessionIdentity, recovered)).toBe(false)
    expect(registry.snapshot()[0]?.recoveryPending).toBe(true)
    expect(registry.acknowledgeRecovery(sessionIdentity, replacement)).toBe(true)
    await registry.dispose()
  })

  it('keeps pending factory cleanup observable through late failure and repeated invalidation', async () => {
    const registry = new BuddySessionRegistry<TestSession>()
    const factory = Promise.withResolvers<{ piSessionFile: string, session: TestSession }>()
    const creation = registry.getOrCreate(identity('branch-1'), null, () => factory.promise)
    const rejected = expect(creation).rejects.toMatchObject({ name: 'AbortError' })
    const changes: string[] = []
    registry.onDidChange(event => changes.push(event.type))
    expect(await registry.invalidateConversationWithResult('conversation-1')).toEqual({ matched: 1, pending: 1, degraded: 0 })
    expect(registry.snapshot()[0]?.cleanup).toBe('pending')
    const session = new FailingShutdownSession()
    factory.resolve({ piSessionFile: '/sessions/late', session })
    await rejected
    await vi.waitFor(() => expect(registry.snapshot()[0]?.cleanup).toBe('failed'))
    expect(changes).toEqual(['removed', 'cleanup-failed'])
    expect(await registry.invalidateConversationWithResult('conversation-1')).toEqual({ matched: 1, pending: 0, degraded: 1 })
    await expect(registry.dispose()).rejects.toThrow('Session shutdown failed')
  })

  it('captures identity and current model without exposing aliases or publishing a failed startup as ready', async () => {
    let reported = 0
    const registry = new BuddySessionRegistry<TestSession>({ onListenerError: () => {
      reported++
    } })
    const sourceIdentity = identity('branch-1')
    const model = { providerId: 'provider-one', modelId: 'model-one' }
    const session = Object.assign(new TestSession(), { getModelUsage: () => model })
    registry.onDidChange(() => {
      throw new Error('private listener error')
    })
    await registry.getOrCreate(sourceIdentity, null, async () => ({ piSessionFile: '/sessions/one', session }))
    sourceIdentity.spaceId = null
    sourceIdentity.resourceRevision = 'mutated'
    const first = registry.snapshot()[0]!
    expect(first.identity.resourceRevision).toBe('resources-1')
    expect(Reflect.set(first.identity, 'canonicalRoot', '/elsewhere')).toBe(false)
    expect(Reflect.set(first.model!, 'modelId', 'overwritten')).toBe(false)
    model.modelId = 'model-two'
    expect(first.model?.modelId).toBe('model-one')
    expect(registry.snapshot()[0]?.model?.modelId).toBe('model-two')
    await registry.invalidateAll()
    const changes: string[] = []
    registry.onDidChange(event => changes.push(event.type))
    await expect(registry.getOrCreate(identity('branch-1'), null, async () => {
      throw new Error('factory failed')
    })).rejects.toThrow('factory failed')
    expect(changes).toEqual(['registered', 'startup-failed'])
    expect(registry.snapshot()).toEqual([])
    expect(reported).toBeGreaterThan(0)
    await registry.dispose()
  })

  it('reports failed deferred invalidation only after release without replacing the operation result', async () => {
    const registry = new BuddySessionRegistry<TestSession>()
    const runIdentity = identity('branch-1')
    const cleanup = Promise.withResolvers<void>()
    const session = new TestSession()
    session.shutdown = () => cleanup.promise
    await registry.getOrCreate(runIdentity, null, async () => ({ piSessionFile: '/sessions/one.jsonl', session }))
    const released: string[] = []
    const result = registry.withConversationRun(runIdentity, 'run-1', undefined, async () => {
      await registry.invalidateConversation(runIdentity.conversationId)
      return 'completed result'
    }, (receipt) => {
      expect(registry.getActiveRun(runIdentity)).toBeUndefined()
      released.push(receipt.cleanup)
    })
    await vi.waitFor(() => expect(registry.getReady(runIdentity.conversationId, runIdentity.branchId)).toBeNull())
    expect(released).toEqual([])
    cleanup.reject(new Error('Shutdown unavailable'))
    expect(await result).toBe('completed result')
    expect(released).toEqual(['degraded'])
    await registry.dispose()
  })

  it('invalidates interactive contributions without replacing automation sessions', async () => {
    const registry = new BuddySessionRegistry<TestSession>()
    const interactive = new TestSession()
    const automation = new TestSession()
    const automationIdentity = { ...identity('branch-2'), conversationId: 'automation-task', sessionMode: 'automation_background' as const }
    await registry.getOrCreate(identity('branch-1'), null, async () => ({ piSessionFile: '/sessions/interactive.jsonl', session: interactive }))
    const bound = await registry.getOrCreate(automationIdentity, null, async () => ({ piSessionFile: '/sessions/automation.jsonl', session: automation }))
    expect(await registry.invalidateMode('interactive')).toBe(1)
    expect(interactive.shutdownReasons).toEqual(['invalidate'])
    expect(automation.shutdownReasons).toEqual([])
    expect(await registry.getOrCreate(automationIdentity, '/sessions/automation.jsonl', async () => {
      throw new Error('Must retain the automation session')
    })).toBe(bound)
    await registry.invalidateAll()
  })
  it('creates one Pi session binding for the same Buddy branch', async () => {
    const registry = new BuddySessionRegistry<TestSession>()
    let creates = 0
    const identity = {
      branchId: 'branch-1',
      canonicalRoot: '/workspace/space',
      conversationId: 'conversation-1',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write' as const,
      grantRevision: 'grants-1',
      resourceRevision: 'resources-1',
      scratchRoot: '/workspace/scratch',
      sessionMode: 'interactive' as const,
      spaceId: null,
    }

    const [first, second] = await Promise.all([
      registry.getOrCreate(identity, null, async () => {
        creates += 1
        return { piSessionFile: '/sessions/one.jsonl', session: new TestSession() }
      }),
      registry.getOrCreate(identity, null, async () => {
        creates += 1
        return { piSessionFile: '/sessions/two.jsonl', session: new TestSession() }
      }),
    ])

    expect(creates).toBe(1)
    expect(first).toBe(second)
    expect(first.piSessionFile).toBe('/sessions/one.jsonl')
  })

  it('replaces resources when the previous session shutdown fails', async () => {
    const registry = new BuddySessionRegistry<TestSession>()
    const firstSession = new FailingShutdownSession()
    const secondSession = new TestSession()
    const firstIdentity = identity('branch-1')
    await registry.getOrCreate(firstIdentity, null, async () => ({
      piSessionFile: '/sessions/one.jsonl',
      session: firstSession,
    }))

    const replacement = await registry.getOrCreate({
      ...firstIdentity,
      resourceRevision: 'resources-2',
    }, '/sessions/one.jsonl', async () => ({
      piSessionFile: '/sessions/one.jsonl',
      session: secondSession,
    }))

    expect(replacement.session).toBe(secondSession)
    expect(firstSession.shutdownReasons).toEqual(['resource-change'])
  })

  it('serializes every branch of one conversation while other conversations proceed', async () => {
    const registry = new BuddySessionRegistry<TestSession>()
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = registry.withConversationRun(identity('branch-1'), 'run-1', undefined, async () => {
      order.push('first:start')
      await firstGate
      order.push('first:end')
    })
    const second = registry.withConversationRun(identity('branch-2'), 'run-2', undefined, async () => {
      order.push('second')
    })
    const otherBranch = registry.withConversationRun({ ...identity('branch-1'), conversationId: 'conversation-2' }, 'run-3', undefined, async () => {
      order.push('other')
    })
    await vi.waitUntil(() => order.includes('first:start') && order.includes('other'))
    expect(order).not.toContain('second')

    releaseFirst()
    await Promise.all([first, second, otherBranch])
    expect(order).toEqual(['first:start', 'other', 'first:end', 'second'])
  })

  it('does not rebind an existing Buddy branch to another directory', async () => {
    const registry = new BuddySessionRegistry<TestSession>()
    await registry.getOrCreate(identity('branch-1'), null, async () => ({
      piSessionFile: '/sessions/one.jsonl',
      session: new TestSession(),
    }))

    await expect(registry.getOrCreate({
      ...identity('branch-1'),
      canonicalRoot: '/workspace/other',
    }, '/sessions/one.jsonl', async () => ({
      piSessionFile: '/sessions/two.jsonl',
      session: new TestSession(),
    }))).rejects.toMatchObject({ code: 'SESSION_BINDING_MISMATCH' })
  })

  it('defers invalidation until the active branch run settles', async () => {
    const registry = new BuddySessionRegistry<TestSession>()
    const session = new TestSession()
    const bound = identity('branch-1')
    await registry.getOrCreate(bound, null, async () => ({
      piSessionFile: '/sessions/one.jsonl',
      session,
    }))
    let invalidate!: () => void
    const gate = new Promise<void>((resolve) => {
      invalidate = resolve
    })
    const run = registry.withConversationRun(bound, 'run-1', undefined, async () => {
      await gate
    })
    await vi.waitUntil(() => registry.getActiveRun(bound)?.runId === 'run-1')

    expect(await registry.invalidateAll()).toBe(1)
    expect(session.shutdownReasons).toEqual([])
    invalidate()
    await run
    expect(session.shutdownReasons).toEqual(['invalidate'])
  })

  it('invalidates every selected session when one shutdown fails', async () => {
    const registry = new BuddySessionRegistry<TestSession>()
    const first = new FailingShutdownSession()
    const second = new TestSession()
    await registry.getOrCreate(identity('branch-1'), null, async () => ({
      piSessionFile: '/sessions/one.jsonl',
      session: first,
    }))
    await registry.getOrCreate({ ...identity('branch-2'), conversationId: 'conversation-2' }, null, async () => ({
      piSessionFile: '/sessions/two.jsonl',
      session: second,
    }))

    await expect(registry.invalidateAll()).resolves.toBe(2)
    expect(first.shutdownReasons).toEqual(['invalidate'])
    expect(second.shutdownReasons).toEqual(['invalidate'])
  })

  it('invalidates a pending session without waiting and shuts down a late factory result', async () => {
    const registry = new BuddySessionRegistry<TestSession>()
    const session = new TestSession()
    let resolveFactory!: (binding: {
      piSessionFile: string
      session: TestSession
    }) => void
    const creation = registry.getOrCreate(identity('branch-1'), null, () => new Promise((resolve) => {
      resolveFactory = resolve
    }))
    const creationOutcomePromise = toOutcome(creation)

    const invalidation = registry.invalidateAll()
    const invalidationOutcome = await observeThroughNextTurn(invalidation)
    resolveFactory({ piSessionFile: '/sessions/one.jsonl', session })
    const creationOutcome = await creationOutcomePromise
    await Promise.allSettled([invalidation])
    await vi.waitUntil(() => session.shutdownReasons.length === 1)

    expect(invalidationOutcome).toEqual({ status: 'fulfilled', value: 1 })
    expect(creationOutcome.status).toBe('rejected')
    expect(session.shutdownReasons).toEqual(['invalidate'])
  })

  it('waits for a late factory result to close before reporting disposal complete', async () => {
    const registry = new BuddySessionRegistry<TestSession>()
    const session = new TestSession()
    let resolveFactory!: (binding: {
      piSessionFile: string
      session: TestSession
    }) => void
    const creation = registry.getOrCreate(identity('branch-1'), null, () => new Promise((resolve) => {
      resolveFactory = resolve
    }))
    const creationOutcomePromise = toOutcome(creation)

    const disposal = registry.dispose()
    const disposalOutcome = await observeThroughNextTurn(disposal)
    resolveFactory({ piSessionFile: '/sessions/one.jsonl', session })
    const creationOutcome = await creationOutcomePromise
    await Promise.allSettled([disposal])
    await vi.waitUntil(() => session.shutdownReasons.length === 1)

    expect(disposalOutcome).toEqual({ status: 'pending' })
    expect(creationOutcome.status).toBe('rejected')
    expect(session.shutdownReasons).toEqual(['quit'])
  })

  it('does not let a stale factory failure delete its replacement session', async () => {
    const registry = new BuddySessionRegistry<TestSession>()
    let rejectFactory!: (error: Error) => void
    const staleCreation = registry.getOrCreate(identity('branch-1'), null, () => new Promise((_resolve, reject) => {
      rejectFactory = reject
    }))
    const staleCreationOutcome = toOutcome(staleCreation)
    const invalidation = registry.invalidateAll()
    const replacementSession = new TestSession()
    let replacementCreates = 0
    const replacement = await registry.getOrCreate(identity('branch-1'), null, async () => {
      replacementCreates += 1
      return {
        piSessionFile: '/sessions/replacement.jsonl',
        session: replacementSession,
      }
    })

    rejectFactory(new Error('stale factory failed'))
    await Promise.all([staleCreationOutcome, invalidation])
    const reused = await registry.getOrCreate(
      identity('branch-1'),
      '/sessions/replacement.jsonl',
      async () => {
        replacementCreates += 1
        return {
          piSessionFile: '/sessions/unexpected.jsonl',
          session: new TestSession(),
        }
      },
    )

    expect(reused).toBe(replacement)
    expect(replacementCreates).toBe(1)
  })

  it('evicts the least recently used idle session when the desktop cache is full', async () => {
    const registry = new BuddySessionRegistry<TestSession>({ maxSessions: 2 })
    const first = new TestSession()
    const second = new FailingShutdownSession()
    const third = new TestSession()
    await registry.getOrCreate(identity('branch-1'), null, async () => ({
      piSessionFile: '/sessions/one.jsonl',
      session: first,
    }))
    await registry.getOrCreate({ ...identity('branch-2'), conversationId: 'conversation-2' }, null, async () => ({
      piSessionFile: '/sessions/two.jsonl',
      session: second,
    }))
    await registry.getOrCreate(identity('branch-1'), '/sessions/one.jsonl', async () => {
      throw new Error('must reuse the first session')
    })
    await registry.getOrCreate({ ...identity('branch-3'), conversationId: 'conversation-3' }, null, async () => ({
      piSessionFile: '/sessions/three.jsonl',
      session: third,
    }))

    expect(first.shutdownReasons).toEqual([])
    expect(second.shutdownReasons).toEqual(['evict'])
    expect(third.shutdownReasons).toEqual([])
    const reused = await registry.getOrCreate({ ...identity('branch-3'), conversationId: 'conversation-3' }, '/sessions/three.jsonl', async () => {
      throw new Error('must reuse the new session after failed eviction cleanup')
    })
    expect(reused.session).toBe(third)
  })

  it('preserves the binding mismatch when cached session shutdown fails', async () => {
    const registry = new BuddySessionRegistry<TestSession>()
    const cachedSession = new FailingShutdownSession()
    await registry.getOrCreate(identity('branch-1'), null, async () => ({
      piSessionFile: '/sessions/one.jsonl',
      session: cachedSession,
    }))

    await expect(registry.getOrCreate(
      identity('branch-1'),
      '/sessions/two.jsonl',
      async () => ({
        piSessionFile: '/sessions/two.jsonl',
        session: new TestSession(),
      }),
    )).rejects.toMatchObject({ code: 'SESSION_BINDING_MISMATCH' })
    expect(cachedSession.shutdownReasons).toEqual(['invalidate'])
  })

  it('accepts the new persisted binding after product-history recovery replaces a Pi file', async () => {
    const registry = new BuddySessionRegistry<TestSession>()
    let creates = 0
    const recovered = await registry.getOrCreate(
      identity('branch-1'),
      '/sessions/corrupt.jsonl',
      async () => {
        creates += 1
        return {
          piSessionFile: '/sessions/recovered.jsonl',
          session: new TestSession(),
        }
      },
    )
    const reused = await registry.getOrCreate(
      identity('branch-1'),
      '/sessions/recovered.jsonl',
      async () => {
        creates += 1
        return {
          piSessionFile: '/sessions/unexpected.jsonl',
          session: new TestSession(),
        }
      },
    )

    expect(reused).toBe(recovered)
    expect(creates).toBe(1)
  })
})

class TestSession {
  readonly shutdownReasons: string[] = []

  async shutdown(reason: string): Promise<void> {
    await Promise.resolve()
    this.shutdownReasons.push(reason)
  }
}

class FailingShutdownSession extends TestSession {
  override async shutdown(reason: string): Promise<void> {
    await super.shutdown(reason)
    throw new Error('session shutdown hook failed')
  }
}

function identity(branchId: string) {
  return {
    branchId,
    canonicalRoot: '/workspace/space',
    conversationId: 'conversation-1',
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write' as const,
    grantRevision: 'grants-1',
    resourceRevision: 'resources-1',
    scratchRoot: '/workspace/scratch',
    sessionMode: 'interactive' as const,
    spaceId: null,
  }
}

type PromiseOutcome<T>
  = | { status: 'fulfilled', value: T }
    | { reason: unknown, status: 'rejected' }

function toOutcome<T>(promise: Promise<T>): Promise<PromiseOutcome<T>> {
  return promise.then(
    value => ({ status: 'fulfilled', value }),
    reason => ({ reason, status: 'rejected' }),
  )
}

async function observeThroughNextTurn<T>(
  promise: Promise<T>,
): Promise<PromiseOutcome<T> | { status: 'pending' }> {
  let outcome: PromiseOutcome<T> | { status: 'pending' } = { status: 'pending' }
  void toOutcome(promise).then((result) => {
    outcome = result
  })
  await new Promise(resolve => setImmediate(resolve))
  return outcome
}
