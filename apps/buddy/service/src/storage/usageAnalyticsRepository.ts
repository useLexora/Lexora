import type { DatabaseSync } from 'node:sqlite'
import type { LocalUsageAnalytics, LocalUsageModelDay, LocalUsageTopTasks, LocalUsageTrend, UsagePeriod, UsageTopTasksRequest, UsageTrendRequest } from '../../../shared/usage/usageAnalyticsApi'
import { Temporal } from '@js-temporal/polyfill'
import { USAGE_TOP_TASKS_LIMIT } from '../../../shared/usage/usageAnalyticsApi'

export interface UsageAnalyticsRepository {
  analytics: (input: UsagePeriod) => LocalUsageAnalytics
  trend: (input: UsageTrendRequest) => LocalUsageTrend
  topTasks: (input: UsageTopTasksRequest) => LocalUsageTopTasks
}

export function createUsageAnalyticsRepository(database: DatabaseSync): UsageAnalyticsRepository {
  const firstRecorded = database.prepare('SELECT MIN(created_at) AS firstRecordedAt FROM usage_records')
  const daily = database.prepare(`
    WITH days AS (
      SELECT
        json_extract(value, '$.date') AS date,
        json_extract(value, '$.startAt') AS start_at,
        json_extract(value, '$.endAt') AS end_at
      FROM json_each(?)
    )
    SELECT
      days.date, u.provider AS providerId, u.model AS modelId,
      SUM(u.input_tokens) AS inputTokens, SUM(u.output_tokens) AS outputTokens,
      SUM(u.cache_read_tokens) AS cacheReadTokens, SUM(u.cache_write_tokens) AS cacheWriteTokens,
      SUM(u.total_tokens) AS totalTokens, COUNT(*) AS recordCount
    FROM days JOIN usage_records u ON u.created_at >= days.start_at AND u.created_at < days.end_at
    GROUP BY days.date, u.provider, u.model
    ORDER BY days.date, u.provider, u.model
  `)
  const trend = database.prepare(`
    WITH buckets AS (
      SELECT
        json_extract(value, '$.startAt') AS start_at,
        json_extract(value, '$.endAt') AS end_at
      FROM json_each(?)
    )
    SELECT buckets.start_at AS startAt, buckets.end_at AS endAt,
      SUM(u.total_tokens) AS totalTokens, COUNT(u.id) AS recordCount
    FROM buckets LEFT JOIN usage_records u ON u.created_at >= buckets.start_at AND u.created_at < buckets.end_at
    GROUP BY buckets.start_at, buckets.end_at
    ORDER BY buckets.start_at
  `)
  const tasks = database.prepare(`
    SELECT c.id AS conversationId, c.title, s.name AS spaceName,
      SUM(u.total_tokens) AS totalTokens, COUNT(*) AS recordCount
    FROM usage_records u
    LEFT JOIN runs r ON r.id = u.run_id
    LEFT JOIN extension_invocations invocation ON invocation.id = u.invocation_id
    JOIN conversations c ON c.id = COALESCE(r.conversation_id, invocation.conversation_id) AND c.deleted_at IS NULL
    LEFT JOIN spaces s ON s.id = c.space_id AND s.revoked_at IS NULL
    WHERE u.created_at >= $startAt AND u.created_at < $endAt
      AND ($provider IS NULL OR (u.provider = $provider AND u.model = $model))
    GROUP BY c.id
    ORDER BY totalTokens DESC, recordCount DESC, c.id
    LIMIT ${USAGE_TOP_TASKS_LIMIT}
  `)

  return {
    analytics(input) {
      const boundaries = usageDayBoundaries(input)
      return {
        days: daily.all(JSON.stringify(boundaries)) as unknown as LocalUsageModelDay[],
        firstRecordedAt: (firstRecorded.get() as { firstRecordedAt: string | null }).firstRecordedAt,
      }
    },
    trend(input) {
      const boundaries = input.granularity === 'hour' ? usageHourBoundaries(input) : usageDayBoundaries(input)
      return trend.all(JSON.stringify(boundaries)) as unknown as LocalUsageTrend
    },
    topTasks(input) {
      return tasks.all({
        $startAt: dayStart(Temporal.PlainDate.from(input.startDate), input.timeZone),
        $endAt: dayStart(Temporal.PlainDate.from(input.endDate).add({ days: 1 }), input.timeZone),
        $provider: input.model?.providerId ?? null,
        $model: input.model?.modelId ?? null,
      }) as unknown as LocalUsageTopTasks
    },
  }
}

function usageDayBoundaries(input: UsagePeriod) {
  const boundaries: Array<{ date: string, startAt: string, endAt: string }> = []
  const end = Temporal.PlainDate.from(input.endDate)
  for (let date = Temporal.PlainDate.from(input.startDate); Temporal.PlainDate.compare(date, end) <= 0; date = date.add({ days: 1 })) {
    boundaries.push({
      date: date.toString(),
      startAt: dayStart(date, input.timeZone),
      endAt: dayStart(date.add({ days: 1 }), input.timeZone),
    })
  }
  return boundaries
}

function usageHourBoundaries(input: UsagePeriod) {
  const date = Temporal.PlainDate.from(input.startDate)
  const end = date.add({ days: 1 }).toZonedDateTime(input.timeZone).toInstant()
  const boundaries: Array<{ startAt: string, endAt: string }> = []
  for (let start = date.toZonedDateTime(input.timeZone).toInstant(); Temporal.Instant.compare(start, end) < 0; start = start.add({ hours: 1 })) {
    const next = start.add({ hours: 1 })
    boundaries.push({
      startAt: start.toString({ fractionalSecondDigits: 3 }),
      endAt: (Temporal.Instant.compare(next, end) > 0 ? end : next).toString({ fractionalSecondDigits: 3 }),
    })
  }
  return boundaries
}

function dayStart(date: Temporal.PlainDate, timeZone: string) {
  return date.toZonedDateTime(timeZone).toInstant().toString({ fractionalSecondDigits: 3 })
}
