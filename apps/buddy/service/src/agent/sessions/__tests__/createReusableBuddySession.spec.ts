import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { BuddyExtensionRunContextStore } from '../../extensions/BuddyExtensionRunContext'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBuddyInputReference } from '../../context/BuddyInputReference'

import { createReusableBuddySession } from '../createReusableBuddySession'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('createReusableBuddySession', () => {
  it('freezes identity per run while reusing a session across profile changes', async () => {
    const session = createAgentSessionDouble(SessionManager.inMemory(), async () => {})
    const runContext: BuddyExtensionRunContextStore = { current: null }
    const reusable = createReusableBuddySession({
      assertModelAccess: async () => ({ id: 'model-1', provider: 'anthropic' }) as never,
      ...inputReferenceBoundary(),
      runContext,
      session,
      shutdown: async () => {},
    })
    const actorIdentity = { id: 'actor', kind: 'actor' as const, name: 'Original name', description: 'Original background' }
    const turn = { generation: 0, ...toolLifecycle(), contextWindow: 128_000, maxTokens: 16_384, model: 'model-1', provider: 'anthropic', signal: new AbortController().signal, actorIdentity }
    const release = await reusable.activateTurn({ ...turn, runId: 'first' })
    actorIdentity.name = 'New name'
    actorIdentity.description = 'New background'
    expect(runContext.current?.actorIdentity).toEqual({ id: 'actor', kind: 'actor', name: 'Original name', description: 'Original background' })
    release()
    const releaseNext = await reusable.activateTurn({ ...turn, runId: 'second' })
    expect(runContext.current).toMatchObject({ runId: 'second', actorIdentity })
    releaseNext()
    expect(runContext.current).toBeNull()
    await reusable.shutdown('quit')
  })

  it('accepts steering only against the active skill snapshot before committing the input', () => {
    const session = createAgentSessionDouble(SessionManager.inMemory(), async () => {})
    Object.defineProperty(session, 'isStreaming', { value: true })
    Object.assign(session.agent, { state: { isStreaming: true } })
    const messages: unknown[] = []
    session.agent.steer = (message) => {
      messages.push(message)
    }
    const reference = { id: 'skill-writer', name: 'writer', revision: 'one' }
    const reusable = createReusableBuddySession({
      assertModelAccess: async () => ({}) as never,
      ...inputReferenceBoundary(),
      skillReferences: [reference],
      session,
      runContext: { current: { runId: 'run', signal: new AbortController().signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {} } },
      shutdown: async () => {},
    })
    let committed = 0
    const prepare = () => {
      committed += 1
      return createBuddyInputReference({ messageId: 'input-one', prompt: 'Use the selected workflow', images: [] })
    }
    expect(() => reusable.steer?.(prepare, [{ ...reference, revision: 'two' }])).toThrow('SKILL_CHANGED')
    expect(committed).toBe(0)
    expect(messages).toEqual([])
    expect(reusable.steer?.(prepare, [reference])).toBe(true)
    expect(committed).toBe(1)
    expect(messages).toHaveLength(1)
  })

  it.each(['prompt', 'compact'] as const)(
    'maps Pi session write errors from %s to the stable storage code',
    async (operation) => {
      const fixture = await createSessionWriteFailureFixture()
      const session = createAgentSessionDouble(fixture.manager, async () => {
        fixture.manager.appendMessage({
          content: 'Continue',
          role: 'user',
          timestamp: Date.now(),
        })
      })
      const reusable = createReusableBuddySession({
        assertModelAccess: async () => ({}) as never,
        ...inputReferenceBoundary(),
        runContext: { current: null },
        session,
        shutdown: async () => {},
      })

      const result = operation === 'prompt'
        ? reusable.prompt('Continue')
        : reusable.compact()
      await expect(result).rejects.toMatchObject({ code: 'SESSION_STORAGE_UNAVAILABLE' })
    },
  )

  it('maps Pi session writes during turn activation to the stable storage code', async () => {
    const fixture = await createSessionWriteFailureFixture()
    const session = createAgentSessionDouble(fixture.manager, async () => {})
    session.setModel = async () => {
      fixture.manager.appendMessage({
        content: 'Model changed',
        role: 'user',
        timestamp: Date.now(),
      })
    }
    const runContext = { current: null }
    const reusable = createReusableBuddySession({
      assertModelAccess: async () => ({ id: 'model-1', provider: 'anthropic' }) as never,
      ...inputReferenceBoundary(),
      runContext,
      session,
      shutdown: async () => {},
    })

    await expect(reusable.activateTurn({ generation: 0, ...toolLifecycle(), contextWindow: 128_000, maxTokens: 16_384, model: 'model-1', provider: 'anthropic', runId: 'run-1', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'SESSION_STORAGE_UNAVAILABLE' })
    expect(runContext.current).toBeNull()
  })

  it('does not relabel filesystem errors outside the active Pi session path', async () => {
    const fixture = await createSessionWriteFailureFixture()
    const spaceError = Object.assign(new Error('Space file is unavailable'), {
      code: 'EACCES',
      path: join(fixture.root, 'workspace.md'),
      syscall: 'open',
    })
    const session = createAgentSessionDouble(fixture.manager, async () => {
      throw spaceError
    })
    const reusable = createReusableBuddySession({
      assertModelAccess: async () => ({}) as never,
      ...inputReferenceBoundary(),
      runContext: { current: null },
      session,
      shutdown: async () => {},
    })

    await expect(reusable.prompt('Continue')).rejects.toBe(spaceError)
  })
})

function inputReferenceBoundary() {
  return {
    inputReferences: { pending: null },
    materializeInput: async (input: { prompt: string }) => ([
      { text: input.prompt, type: 'text' as const },
    ]),
  }
}

function createAgentSessionDouble(
  manager: SessionManager,
  operation: () => Promise<void>,
): AgentSession {
  return {
    abort: vi.fn(async () => {}),
    abortCompaction: vi.fn(),
    agent: { clearSteeringQueue: vi.fn(), clearFollowUpQueue: vi.fn(), streamFunction: vi.fn() },
    compact: operation,
    dispose: vi.fn(),
    model: undefined,
    prompt: operation,
    sessionManager: manager,
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    setCacheWarmingMode: vi.fn(),
    settingsManager: {
      applyOverrides: vi.fn(),
      getCacheWarmingMode: () => 'off',
      getCompactionSettings: () => ({ enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 }),
    },
    subscribe: vi.fn(() => () => {}),
    waitForIdle: vi.fn(),
  } as unknown as AgentSession
}

async function createSessionWriteFailureFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-session-write-')))
  directories.push(root)
  const sessionDirectory = join(root, 'sessions')
  await mkdir(sessionDirectory)
  const pending = SessionManager.create(root, sessionDirectory)
  const sessionFile = pending.getSessionFile()
  if (!sessionFile)
    throw new Error('Pi did not allocate a persistent session file')
  await writeFile(sessionFile, `${JSON.stringify({
    cwd: root,
    id: 'session-write-test',
    timestamp: '2026-08-17T00:00:00.000Z',
    type: 'session',
    version: 3,
  })}\n`)
  const manager = SessionManager.open(sessionFile, sessionDirectory, root)
  await rm(sessionFile)
  await mkdir(sessionFile)
  return { manager, root }
}

function toolLifecycle() {
  return {
    flushProjectedEvents: async () => {},
    onToolExecutionAuthorized: async () => {},
    onToolExecutionDenied: async () => {},
  }
}
