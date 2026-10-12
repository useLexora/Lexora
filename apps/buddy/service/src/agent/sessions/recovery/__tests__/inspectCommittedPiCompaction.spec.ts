import type { AssistantMessage, Usage } from '@earendil-works/pi-ai'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'

import { inspectCommittedPiCompaction } from '../inspectCommittedPiCompaction'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('inspectCommittedPiCompaction', () => {
  it('binds compaction evidence to its actor thread and exact run even after another run completes', async () => {
    const fixture = await createFixture()
    const threadId = 'actor:conversation-1:actor-a'
    const directory = join(fixture.conversationsDirectory, 'conversation-1', 'session', 'threads', createHash('sha256').update(threadId).digest('hex'))
    await mkdir(directory, { recursive: true })
    const manager = SessionManager.create(fixture.root, directory)
    manager.appendCustomEntry('lexora.conversation.root.v1', { conversationId: 'conversation-1', threadId })
    manager.appendCustomEntry('lexora.conversation.checkpoint.v1', { runId: 'compact-a', branchId: 'branch-1', position: 'before' })
    const user = manager.appendMessage({ role: 'user', content: 'Own context', timestamp: Date.now() })
    manager.appendMessage(assistant('Own answer'))
    const first = manager.appendCompaction('PRIVATE_A_SUMMARY', user, 500)
    manager.appendCustomEntry('lexora.conversation.checkpoint.v1', { runId: 'compact-a', branchId: 'branch-1', position: 'after' })
    manager.appendCustomEntry('lexora.conversation.checkpoint.v1', { runId: 'compact-b', branchId: 'branch-1', position: 'before' })
    manager.appendCompaction('LATER_SAME_THREAD_SUMMARY', user, 900)
    manager.appendCustomEntry('lexora.conversation.checkpoint.v1', { runId: 'compact-b', branchId: 'branch-1', position: 'after' })
    const input = { conversationsDirectory: fixture.conversationsDirectory, conversationId: 'conversation-1', branchId: 'branch-1', piSessionFile: manager.getSessionFile()!, startedAt: '2026-08-15T00:00:00.000Z', threadId, runId: 'compact-a' }
    expect(await inspectCommittedPiCompaction(input)).toMatchObject({ compactionEntryId: first, tokensBefore: 500 })
    await expect(inspectCommittedPiCompaction({ ...input, threadId: 'actor:conversation-1:actor-b' })).rejects.toMatchObject({ code: 'SESSION_BINDING_INVALID' })
    await expect(inspectCommittedPiCompaction({ ...input, runId: 'unknown-run' })).resolves.toBeNull()
  })

  it('returns non-summary evidence from a real committed Pi compaction entry', async () => {
    const fixture = await createFixture()
    const firstKeptEntryId = fixture.manager.appendMessage({
      content: 'Keep this recent context',
      role: 'user',
      timestamp: Date.now(),
    })
    fixture.manager.appendMessage(assistant('And this response'))
    const compactionEntryId = fixture.manager.appendCompaction(
      'Private summary must not leave Pi storage',
      firstKeptEntryId,
      1_400,
      undefined,
      false,
      usage(20, 5),
    )

    const evidence = await inspectCommittedPiCompaction({
      conversationsDirectory: fixture.conversationsDirectory,
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      piSessionFile: fixture.sessionFile,
      startedAt: '2026-08-15T00:00:00.000Z',
    })

    expect(evidence).toMatchObject({
      compactionEntryId,
      firstKeptEntryId,
      tokensBefore: 1_400,
      usage: { input: 20, output: 5 },
    })
    expect(evidence?.estimatedTokensAfter).toBeGreaterThan(0)
    expect(JSON.stringify(evidence)).not.toContain('Private summary')
  })

  it('ignores stale and corrupt Pi compaction evidence', async () => {
    const stale = await createFixture()
    const firstKeptEntryId = stale.manager.appendMessage({
      content: 'Recent context',
      role: 'user',
      timestamp: Date.now(),
    })
    stale.manager.appendMessage(assistant('Response'))
    stale.manager.appendCompaction('summary', firstKeptEntryId, 800)

    await expect(inspectCommittedPiCompaction({
      conversationsDirectory: stale.conversationsDirectory,
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      piSessionFile: stale.sessionFile,
      startedAt: '2099-08-15T00:00:00.000Z',
    })).resolves.toBeNull()

    const corrupt = await createFixture()
    await writeFile(corrupt.sessionFile, '{broken jsonl}\n')
    await expect(inspectCommittedPiCompaction({
      conversationsDirectory: corrupt.conversationsDirectory,
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      piSessionFile: corrupt.sessionFile,
      startedAt: '2026-08-15T00:00:00.000Z',
    })).resolves.toBeNull()
  })

  it('reports unavailable Pi compaction evidence storage instead of hiding it', async () => {
    const fixture = await createFixture()
    await mkdir(fixture.sessionFile)

    await expect(inspectCommittedPiCompaction({
      conversationsDirectory: fixture.conversationsDirectory,
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      piSessionFile: fixture.sessionFile,
      startedAt: '2026-08-15T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'SESSION_STORAGE_UNAVAILABLE' })
  })

  it('rejects files outside the exact Buddy conversation branch directory', async () => {
    const fixture = await createFixture()
    const outsideDirectory = join(fixture.root, 'outside')
    await mkdir(outsideDirectory)
    const outside = SessionManager.create(fixture.root, outsideDirectory)
    outside.appendMessage({ content: 'Question', role: 'user', timestamp: Date.now() })
    outside.appendMessage(assistant('Answer'))
    const outsideFile = outside.getSessionFile()
    if (!outsideFile)
      throw new Error('Pi did not create an outside session file')

    await expect(inspectCommittedPiCompaction({
      conversationsDirectory: fixture.conversationsDirectory,
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      piSessionFile: outsideFile,
      startedAt: '2026-08-15T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'SESSION_BINDING_INVALID' })

    const link = join(fixture.sessionDirectory, 'linked.jsonl')
    await symlink(outsideFile, link)
    await expect(inspectCommittedPiCompaction({
      conversationsDirectory: fixture.conversationsDirectory,
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      piSessionFile: link,
      startedAt: '2026-08-15T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'SESSION_BINDING_INVALID' })
  })
})

async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-compaction-evidence-')))
  directories.push(root)
  const conversationsDirectory = join(root, 'conversations')
  const sessionDirectory = join(
    conversationsDirectory,
    'conversation-1',
    'session',
    'branch-1',
  )
  await mkdir(sessionDirectory, { recursive: true })
  const manager = SessionManager.create(root, sessionDirectory)
  const sessionFile = manager.getSessionFile()
  if (!sessionFile)
    throw new Error('Pi did not create a persistent session file')
  return { conversationsDirectory, manager, root, sessionDirectory, sessionFile }
}

function usage(input: number, output: number): Usage {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.01, output: 0.02, total: 0.03 },
    input,
    output,
    totalTokens: input + output,
  }
}

function assistant(content: string): AssistantMessage {
  return {
    api: 'anthropic-messages',
    content: [{ text: content, type: 'text' }],
    model: 'model-1',
    provider: 'provider-1',
    role: 'assistant',
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: usage(10, 3),
  }
}
