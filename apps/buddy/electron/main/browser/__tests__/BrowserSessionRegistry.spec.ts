import { describe, expect, it, vi } from 'vitest'
import {
  BrowserSessionRegistry,
  BrowserSessionRegistryError,
} from '../BrowserSessionRegistry'

describe('browserSessionRegistry', () => {
  it('keeps retiring and quarantined pages in the admission budget', async () => {
    const fixture = createFixture(1)
    const first = fixture.ensure('first')
    const cleanup = Promise.withResolvers<void>()
    fixture.teardownBySessionId.get(first.sessionId)!.mockReturnValue(cleanup.promise)
    fixture.registry.remove(first.sessionId)
    expect(fixture.registry.values()).toEqual([])
    expect(() => fixture.ensure('second')).toThrowError(BrowserSessionRegistryError)
    cleanup.resolve()
    await cleanup.promise
    const second = fixture.ensure('second')
    fixture.teardownBySessionId.get(second.sessionId)!.mockReturnValue(Promise.reject(new Error('unconfirmed')))
    fixture.registry.remove(second.sessionId)
    await Promise.resolve()
    expect(() => fixture.ensure('third')).toThrowError(BrowserSessionRegistryError)
  })

  it('does not evict more pages while a previous eviction is still draining', async () => {
    const fixture = createFixture(2)
    const first = fixture.ensure('first')
    const second = fixture.ensure('second')
    const cleanup = Promise.withResolvers<void>()
    fixture.teardownBySessionId.get(first.sessionId)!.mockReturnValue(cleanup.promise)
    expect(() => fixture.ensure('third')).toThrowError(BrowserSessionRegistryError)
    expect(() => fixture.ensure('third')).toThrowError(BrowserSessionRegistryError)
    expect(fixture.registry.values()).toEqual([second])
    cleanup.resolve()
    await cleanup.promise
    expect(fixture.ensure('third').conversationId).toBe('third')
  })

  it('retains standalone tabs without creating a conversation session', () => {
    const fixture = createFixture()
    const first = fixture.registry.ensure(null, fixture.createSession, 'manual-1')
    const second = fixture.registry.ensure(null, fixture.createSession, 'manual-2')
    expect(first.conversationId).toBeNull()
    expect(first.sessionId).not.toBe(second.sessionId)
    expect(fixture.registry.ensure(null, fixture.createSession, 'manual-1')).toBe(first)
    expect(() => fixture.registry.ensure(null, fixture.createSession)).toThrow('tab identity')
    fixture.registry.remove(first.sessionId)
    expect(fixture.registry.values()).toEqual([second])
  })

  it('keeps tabs in the same conversation separate from the agent session', () => {
    const fixture = createFixture()
    const agent = fixture.ensure('conversation')
    const first = fixture.registry.ensure('conversation', fixture.createSession, 'tab-1')
    const second = fixture.registry.ensure('conversation', fixture.createSession, 'tab-2')
    expect(new Set([agent.sessionId, first.sessionId, second.sessionId]).size).toBe(3)
    expect(fixture.registry.getByConversation('conversation')).toBe(agent)
    fixture.registry.remove(first.sessionId)
    expect(fixture.registry.getByConversation('conversation')).toBe(agent)
    expect(fixture.registry.ensure('conversation', fixture.createSession, 'tab-2')).toBe(second)
  })

  it('rejects creation when every session is protected', () => {
    const fixture = createFixture(2)
    const first = fixture.ensure('conversation-1')
    const second = fixture.ensure('conversation-2')
    fixture.registry.setProtected(first.sessionId, 'surface', true)
    fixture.registry.setProtected(second.sessionId, 'runtime', true)

    expect(() => fixture.ensure('conversation-3')).toThrowError(BrowserSessionRegistryError)
    expect(fixture.createSession).toHaveBeenCalledTimes(2)
    expect(fixture.registry.values()).toEqual([first, second])
  })
})

function createFixture(maxSessions = 4) {
  const ids = [
    '6f828cc1-6549-4245-b26e-43b2917c9281',
    'ed312709-baf9-44b3-a292-108055838477',
    'cece2ce7-4a79-478a-9008-c0df264095ba',
  ]
  const teardownBySessionId = new Map<string, ReturnType<typeof vi.fn>>()
  const registry = new BrowserSessionRegistry<Session>({
    createId: () => ids.shift()!,
    maxSessions,
  })
  const createSession = vi.fn((context: { conversationId: string | null, sessionId: string }) => {
    const session: Session = { ...context }
    const teardown = vi.fn()
    teardownBySessionId.set(context.sessionId, teardown)
    return { session, teardown }
  })

  return {
    createSession,
    ensure: (conversationId: string | null) => registry.ensure(conversationId, createSession),
    registry,
    teardownBySessionId,
  }
}

interface Session {
  conversationId: string | null
  sessionId: string
}
