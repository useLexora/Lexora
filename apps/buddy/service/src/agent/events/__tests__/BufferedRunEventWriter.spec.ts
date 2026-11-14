import type { AppendBuddyRunEventInput } from '../../../events/BuddyRunEvent'
import type { BuddyProjectedEvent } from '../projectPiEvent'
import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunEventQueries } from '../../../events/RunEventQueries'
import { SqliteRunEventLog } from '../../../events/SqliteRunEventLog'
import { seedSqliteRun } from '../../../storage/__tests__/sqliteRunFixture'
import { openBuddyMigrationCandidate } from '../../../storage/database'
import { guardStorageDatabase } from '../../../storage/StorageIsolation'

import { BufferedRunEventWriter } from '../BufferedRunEventWriter'

const cleanups: Array<() => Promise<void>> = []
const now = '2026-09-30T00:00:00.000Z'

afterEach(async () => {
  for (const cleanup of cleanups.splice(0))
    await cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fixture() {
  const database = openBuddyMigrationCandidate({ databasePath: ':memory:' })
  const isolation = guardStorageDatabase(database)
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  seedSqliteRun(database, 'run-1')
  const log = new SqliteRunEventLog({ database })
  const writer = new BufferedRunEventWriter(log, 'run-1', () => now)
  const queries = new RunEventQueries(database)
  cleanups.push(async () => {
    await writer.drain().catch(() => {})
    await log.close()
    database.close()
  })
  return { database, isolation, log, writer, read: () => queries.read('run-1') }
}

function textDelta(delta = 'x', messageId = 'answer'): BuddyProjectedEvent {
  return { type: 'message.delta', payload: { messageId, delta } }
}

describe('bufferedRunEventWriter', () => {
  it('counts UTF-8 bytes across the batch and writes an indivisible oversized event immediately', async () => {
    vi.useFakeTimers()
    const f = fixture()
    for (let index = 0; index < 4; index++)
      f.writer.append(textDelta('你'.repeat(6000)))
    expect(f.read()).toMatchObject([{ sequence: 1, payload: { delta: '你'.repeat(18000) } }])
    expect(Buffer.byteLength(JSON.stringify(f.read()[0]))).toBeLessThan(64 * 1024)
    f.writer.append(textDelta('🙂'.repeat(20000)))
    expect(f.read()).toMatchObject([
      { sequence: 1, payload: { delta: '你'.repeat(18000) } },
      { sequence: 2, payload: { delta: '你'.repeat(6000) } },
      { sequence: 3, payload: { delta: '🙂'.repeat(20000) } },
    ])
    await f.writer.drain()
  })

  it('commits message completion after pending deltas without waiting for a timer', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.writer.append(textDelta('answer'))
    f.writer.append({ type: 'message.completed', payload: {
      messageId: 'answer',
      role: 'assistant',
      content: { text: 'answer' },
      stopReason: 'completed',
    } })
    expect(f.read().map(event => event.type)).toEqual(['message.delta', 'message.completed'])
    expect(f.database.prepare('SELECT content_json FROM messages WHERE id = \'answer\'').get()).toEqual({ content_json: '{"text":"answer"}' })
  })

  it('rejects drain after storage isolation without publishing buffered content', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const committed: unknown[] = []
    f.log.onDidCommit(event => committed.push(event))
    f.writer.append(textDelta('uncommitted'))
    f.isolation.isolate(new Error('Fixture storage failure'))
    await expect(f.writer.drain()).rejects.toThrow('database failed')
    await vi.advanceTimersByTimeAsync(50)
    expect(committed).toEqual([])
    expect(f.log.state).toBe('failed')
  })

  it('coalesces adjacent terminal output deltas before durable append', async () => {
    const appended: AppendBuddyRunEventInput[][] = []
    const appendBatch = vi.fn(async (events: readonly AppendBuddyRunEventInput[]) => {
      appended.push([...events])
      return []
    })
    const writer = new BufferedRunEventWriter(
      { appendBatch },
      'run-1',
      () => '2026-09-03T00:00:00.000Z',
    )

    writer.append(toolOutputDelta(0, 'first'))
    writer.append(toolOutputDelta(5, '\nsecond'))
    await writer.drain()

    expect(appended).toEqual([[
      {
        createdAt: '2026-09-03T00:00:00.000Z',
        payload: {
          presentationDelta: {
            card: 'terminal',
            outputDelta: 'first\nsecond',
            outputStart: 0,
            truncated: false,
          },
          toolCallId: 'tool-1',
          toolName: 'bash',
        },
        runId: 'run-1',
        type: 'tool.updated',
      },
    ]])
  })
})

function toolOutputDelta(outputStart: number, outputDelta: string) {
  return {
    payload: {
      presentationDelta: {
        card: 'terminal' as const,
        outputDelta,
        outputStart,
        truncated: false,
      },
      toolCallId: 'tool-1',
      toolName: 'bash',
    },
    type: 'tool.updated' as const,
  }
}
