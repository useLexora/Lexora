import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { usageAnalyticsSchema, usagePeriodSchema, usageTopTasksRequestSchema, usageTrendRequestSchema, usageTrendSchema } from '../../../../shared/usage/usageAnalyticsApi'
import { openBuddyDatabase } from '../database'
import { BUDDY_RUN_EVENT_CHECKPOINT_TRIGGER_NAMES } from '../migrations/v24RunEventCheckpoints'
import { createUsageAnalyticsRepository } from '../usageAnalyticsRepository'

const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))

function fixture(databasePath = ':memory:') {
  const database = openBuddyDatabase({ databasePath })
  databases.push(database)
  let sequence = 0
  const instant = '2026-01-01T00:00:00.000Z'
  function run(id: string, deleted = false) {
    database.prepare('INSERT INTO conversations (id, title, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)').run(id, `Task ${id}`, instant, instant, deleted ? instant : null)
    database.prepare('INSERT INTO conversation_branches (id, conversation_id, created_at) VALUES (?, ?, ?)').run(id, id, instant)
    database.prepare(`INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at) VALUES (?, ?, ?, 'message', 'provider', 'model', 'chat', 'completed', ?)`).run(id, id, id, instant)
  }
  function usage(runId: string, createdAt = instant, provider = 'provider', model = 'model', tokens = 22, purpose = 'turn') {
    const id = `usage-${++sequence}`
    database.prepare(`INSERT INTO usage_records (
      id, run_id, source_entry_id, provider, model, purpose, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
      input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?)`)
      .run(id, runId, id, provider, model, purpose, tokens === 22 ? 10 : tokens, tokens === 22 ? 5 : 0, tokens === 22 ? 3 : 0, tokens === 22 ? 4 : 0, tokens === 22 ? 2 : null, tokens, createdAt)
  }
  return { database, repository: createUsageAnalyticsRepository(database), run, usage }
}

const period = { startDate: '2026-01-01', endDate: '2026-12-31', timeZone: 'UTC' }

describe('usage analytics', () => {
  it('aggregates every recorded call beyond the recent-500 window without adding reasoning again', () => {
    const f = fixture()
    f.run('task')
    for (let index = 0; index < 601; index++)
      f.usage('task', '2026-01-01T00:00:00.000Z', 'provider', 'model', 22, ['turn', 'tool', 'compaction'][index % 3])
    const report = usageAnalyticsSchema.parse(f.repository.analytics(period))
    expect(report.days).toEqual([{
      date: '2026-01-01',
      providerId: 'provider',
      modelId: 'model',
      inputTokens: 6010,
      outputTokens: 3005,
      cacheReadTokens: 1803,
      cacheWriteTokens: 2404,
      totalTokens: 13222,
      recordCount: 601,
    }])
    expect(report.firstRecordedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(f.repository.topTasks({ ...period, model: null })).toMatchObject([{ totalTokens: 13222, recordCount: 601 }])
    const trend = usageTrendSchema.parse(f.repository.trend({ ...period, granularity: 'day' }))
    expect(trend).toHaveLength(365)
    expect(trend[0]).toMatchObject({ totalTokens: 13222, recordCount: 601 })
    expect(trend.slice(1).every(bucket => bucket.totalTokens === null && bucket.recordCount === 0)).toBe(true)
  })

  it('uses local dates with inclusive start and exclusive next-day boundaries', () => {
    const f = fixture()
    f.run('task')
    for (const date of ['2025-12-31T15:59:59.999Z', '2025-12-31T16:00:00.000Z', '2026-01-01T15:59:59.999Z', '2026-01-01T16:00:00.000Z'])
      f.usage('task', date)
    const range = { startDate: '2026-01-01', endDate: '2026-01-01', timeZone: 'Asia/Shanghai' }
    expect(f.repository.analytics(range).days).toMatchObject([{ date: '2026-01-01', recordCount: 2, totalTokens: 44 }])
    expect(f.repository.topTasks({ ...range, model: null })).toMatchObject([{ recordCount: 2, totalTokens: 44 }])
  })

  it.each([
    ['2026-03-08', '2026-03-08T08:00:00.000Z', '2026-03-09T06:59:59.999Z', '2026-03-09T07:00:00.000Z'],
    ['2026-11-01', '2026-11-01T07:00:00.000Z', '2026-11-02T07:59:59.999Z', '2026-11-02T08:00:00.000Z'],
  ])('groups the DST day %s without assuming 24 hours', (date, start, last, end) => {
    const f = fixture()
    f.run('task')
    for (const instant of [start, last, end])
      f.usage('task', instant)
    const range = { startDate: date, endDate: date, timeZone: 'America/Los_Angeles' }
    expect(f.repository.analytics(range).days).toMatchObject([{ date, recordCount: 2 }])
    expect(f.repository.topTasks({ ...range, model: null })).toMatchObject([{ recordCount: 2 }])
  })

  it('keeps missing days distinct from zero-token reports and preserves provider/model identity', () => {
    const f = fixture()
    f.run('task')
    expect(f.repository.analytics(period)).toEqual({ days: [], firstRecordedAt: null })
    f.usage('task', '2026-01-01T00:00:00.000Z', 'a', 'same', 0)
    f.usage('task', '2026-01-01T00:00:00.000Z', 'b', 'same', 50)
    expect(f.repository.analytics(period).days).toMatchObject([
      { date: '2026-01-01', providerId: 'a', modelId: 'same', recordCount: 1, totalTokens: 0 },
      { date: '2026-01-01', providerId: 'b', modelId: 'same', recordCount: 1, totalTokens: 50 },
    ])
    expect(f.repository.topTasks({ ...period, model: { providerId: 'a', modelId: 'same' } })).toMatchObject([{ recordCount: 1, totalTokens: 0 }])
  })

  it('retains deleted consumption in totals but does not return deleted task identities', () => {
    const f = fixture()
    f.run('deleted', true)
    f.usage('deleted', '2026-01-01T00:00:00.000Z', 'provider', 'model', 99999)
    for (let index = 1; index <= 12; index++) {
      f.run(`task-${index}`)
      f.usage(`task-${index}`, '2026-01-01T00:00:00.000Z', 'provider', 'model', index)
    }
    expect(f.repository.analytics(period).days[0]).toMatchObject({ totalTokens: 100077, recordCount: 13 })
    const tasks = f.repository.topTasks({ ...period, model: null })
    expect(tasks.map(task => task.conversationId)).toEqual(Array.from({ length: 5 }, (_, index) => `task-${12 - index}`))
    expect(JSON.stringify(tasks)).not.toContain('deleted')
  })

  it('upgrades an existing usage ledger without losing its records', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-usage-upgrade-'))
    try {
      const path = join(directory, 'buddy.sqlite3')
      const f = fixture(path)
      f.run('retained')
      f.usage('retained')
      const before = f.repository.analytics(period)
      f.database.exec(`
        ${BUDDY_RUN_EVENT_CHECKPOINT_TRIGGER_NAMES.map(name => `DROP TRIGGER ${name};`).join('\n        ')}
        DROP TABLE run_event_checkpoints;
        DROP TABLE extension_invocations;
        DROP TABLE connector_tool_catalogs;
        DROP INDEX idx_mcp_tool_namespace;
        ALTER TABLE mcp_servers DROP COLUMN tool_namespace;
        ALTER TABLE mcp_servers DROP COLUMN tool_exposure;
        DROP TABLE skill_file_cleanup;
        DROP TABLE skill_space_exclusions;
        DROP TABLE skill_installations;
        DROP INDEX idx_messages_run;
        DROP INDEX idx_usage_created_at;
        DROP TABLE builtin_provider_configs;
        ALTER TABLE provider_states DROP COLUMN request_headers_json;
        ALTER TABLE provider_model_states DROP COLUMN thinking_level_map_json;
        ALTER TABLE provider_model_states DROP COLUMN sampling_params_json;
        ALTER TABLE provider_model_states DROP COLUMN compat_json;
        ALTER TABLE provider_model_states DROP COLUMN catalog_provider_id;
        ALTER TABLE provider_model_states DROP COLUMN source_fingerprint;
        ALTER TABLE provider_model_states DROP COLUMN catalog_model_id;
        ALTER TABLE provider_model_states DROP COLUMN catalog_selection_json;
        ALTER TABLE provider_model_states DROP COLUMN capability_overrides_json;
        ALTER TABLE attachments DROP COLUMN name_source;
        ALTER TABLE composer_resources DROP COLUMN name_source;
        ALTER TABLE attachments DROP COLUMN source_path;
        ALTER TABLE composer_resources DROP COLUMN source_path;
        PRAGMA user_version = 13;
        ALTER TABLE conversations DROP COLUMN title_source;
        ALTER TABLE conversations DROP COLUMN title_revision;
      `)
      f.database.close()
      databases.splice(databases.indexOf(f.database), 1)
      const upgraded = openBuddyDatabase({ databasePath: path })
      try {
        expect(createUsageAnalyticsRepository(upgraded).analytics(period)).toEqual(before)
        expect(upgraded.prepare('SELECT name FROM sqlite_master WHERE type = \'index\' AND name = \'idx_usage_created_at\'').get()).toBeTruthy()
        expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      }
      finally {
        upgraded.close()
      }
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('usage trend queries', () => {
  it('uses local hourly boundaries, distinguishing zero reports from missing hours and excluding the next day', () => {
    const f = fixture()
    f.run('task')
    const range = { startDate: '2026-01-01', endDate: '2026-01-01', timeZone: 'Asia/Kathmandu', granularity: 'hour' as const }
    for (const instant of ['2025-12-31T18:14:59.999Z', '2025-12-31T18:15:00.000Z', '2025-12-31T19:14:59.999Z', '2026-01-01T18:15:00.000Z'])
      f.usage('task', instant)
    f.usage('task', '2025-12-31T19:15:00.000Z', 'provider', 'model', 0)
    const trend = usageTrendSchema.parse(f.repository.trend(range))
    expect(trend).toHaveLength(24)
    expect(trend[0]).toEqual({ startAt: '2025-12-31T18:15:00.000Z', endAt: '2025-12-31T19:15:00.000Z', totalTokens: 44, recordCount: 2 })
    expect(trend[1]).toMatchObject({ totalTokens: 0, recordCount: 1 })
    expect(trend.slice(2).every(bucket => bucket.totalTokens === null && bucket.recordCount === 0)).toBe(true)
    expect(trend.at(-1)!.endAt).toBe('2026-01-01T18:15:00.000Z')
    expect(f.repository.trend({ ...range, granularity: 'day' })).toMatchObject([{ totalTokens: 44, recordCount: 3 }])
  })

  it.each([
    ['2026-03-08', 23, '2026-03-08T08:00:00.000Z', '2026-03-09T07:00:00.000Z'],
    ['2026-11-01', 25, '2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z'],
  ])('covers the real %s day with %i hours', (date, hours, startAt, endAt) => {
    const f = fixture()
    const trend = f.repository.trend({ startDate: date, endDate: date, timeZone: 'America/Los_Angeles', granularity: 'hour' })
    expect(trend).toHaveLength(hours)
    expect(trend[0]!.startAt).toBe(startAt)
    expect(trend.at(-1)!.endAt).toBe(endAt)
    expect(new Set(trend.map(bucket => bucket.startAt)).size).toBe(hours)
    expect(trend.slice(1).every((bucket, index) => bucket.startAt === trend[index]!.endAt)).toBe(true)
  })

  it('does not merge the repeated local hour on DST fallback', () => {
    const f = fixture()
    f.run('task')
    f.usage('task', '2026-11-01T08:30:00.000Z', 'provider', 'model', 10)
    f.usage('task', '2026-11-01T09:30:00.000Z', 'provider', 'model', 20)
    const trend = f.repository.trend({ startDate: '2026-11-01', endDate: '2026-11-01', timeZone: 'America/Los_Angeles', granularity: 'hour' })
    expect(trend.filter(bucket => bucket.recordCount)).toEqual([
      { startAt: '2026-11-01T08:00:00.000Z', endAt: '2026-11-01T09:00:00.000Z', totalTokens: 10, recordCount: 1 },
      { startAt: '2026-11-01T09:00:00.000Z', endAt: '2026-11-01T10:00:00.000Z', totalTokens: 20, recordCount: 1 },
    ])
  })

  it('clips a fractional DST hour at the next local midnight', () => {
    const f = fixture()
    const trend = f.repository.trend({ startDate: '2026-04-05', endDate: '2026-04-05', timeZone: 'Australia/Lord_Howe', granularity: 'hour' })
    const last = trend.at(-1)!
    expect(trend).toHaveLength(25)
    expect(Date.parse(last.endAt) - Date.parse(last.startAt)).toBe(30 * 60_000)
    expect(last.endAt).toBe('2026-04-05T13:30:00.000Z')
  })
})

describe('usage request boundaries', () => {
  it('accepts a complete leap year and rejects invalid or unbounded requests', () => {
    expect(usagePeriodSchema.safeParse({ ...period, startDate: '2024-01-01', endDate: '2024-12-31' }).success).toBe(true)
    for (const patch of [
      { startDate: '2025-12-30' },
      { startDate: '2027-01-01' },
      { startDate: '2026-02-30' },
      { timeZone: 'Not/AZone' },
      { path: '/private' },
    ])
      expect(usagePeriodSchema.safeParse({ ...period, ...patch }).success).toBe(false)
    expect(usageTopTasksRequestSchema.safeParse({ ...period, model: { modelId: 'same' } }).success).toBe(false)
    expect(usageTrendRequestSchema.safeParse({ ...period, granularity: 'day' }).success).toBe(true)
    expect(usageTrendRequestSchema.safeParse({ ...period, granularity: 'hour' }).success).toBe(false)
    expect(usageTrendRequestSchema.safeParse({ ...period, endDate: period.startDate, granularity: 'hour' }).success).toBe(true)
    expect(usageTrendRequestSchema.safeParse({ ...period, granularity: 'month' }).success).toBe(false)
  })
})
