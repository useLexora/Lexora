import type {
  ChatTranscriptProjection,
  ChatTranscriptRow,
  ChatTranscriptRowPatch,
} from './chatTranscriptProjection'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import dayjs from 'dayjs'
import { toDayjsLocale, translateBuddy } from '@/i18n/buddyI18n'

export interface ChatTranscriptDayDividerRow {
  createdAt: string
  key: string
  kind: 'day-divider'
}

export type ChatTranscriptDisplayRow = ChatTranscriptDayDividerRow | ChatTranscriptRow

interface CachedChatTranscriptDisplayRows {
  displayIndexByRowIndex: ReadonlyArray<number>
  displayRows: ReadonlyArray<ChatTranscriptDisplayRow>
  rows: ReadonlyArray<ChatTranscriptRow>
}

export function createChatTranscriptDisplayRowProjector() {
  let cached: CachedChatTranscriptDisplayRows | null = null

  return {
    project(projection: ChatTranscriptProjection): ReadonlyArray<ChatTranscriptDisplayRow> {
      const updated = cached && patchChatTranscriptDisplayRows(cached, projection)
      if (updated) {
        cached = updated
        return updated.displayRows
      }
      const displayRows = projectChatTranscriptDisplayRows(projection.rows)
      cached = {
        displayIndexByRowIndex: indexChatTranscriptDisplayRows(displayRows),
        displayRows,
        rows: projection.rows,
      }
      return displayRows
    },
  }
}

export function projectChatTranscriptDisplayRows(
  rows: ReadonlyArray<ChatTranscriptRow>,
): ChatTranscriptDisplayRow[] {
  const displayRows: ChatTranscriptDisplayRow[] = []
  const agentTurnFinalMessageIds = new Set(rows.flatMap(row => (
    row.kind === 'agent-turn' && row.turn.finalMessageId
      ? [row.turn.finalMessageId]
      : []
  )))
  const agentTurnRunIds = new Set(rows.flatMap(row => (
    row.kind === 'agent-turn' ? [row.turn.runId] : []
  )))
  let previousDayKey: string | null = null

  for (const row of rows) {
    const assistantMessageBelongsToAgentTurn = row.kind === 'message'
      && row.message.role === 'assistant'
      && (
        agentTurnFinalMessageIds.has(row.message.id)
        || (row.message.runId !== null && agentTurnRunIds.has(row.message.runId))
      )
    const dayAnchorAt = row.kind === 'agent-turn'
      ? row.turn.startedAt
      : row.kind === 'message' && !assistantMessageBelongsToAgentTurn
        ? row.message.createdAt
        : null
    if (dayAnchorAt) {
      const dayKey = dayjs(dayAnchorAt).format('YYYY-MM-DD')
      if (dayKey !== previousDayKey) {
        displayRows.push({
          createdAt: dayAnchorAt,
          key: `day:${dayKey}`,
          kind: 'day-divider',
        })
        previousDayKey = dayKey
      }
    }
    displayRows.push(row)
  }

  return displayRows
}

function patchChatTranscriptDisplayRows(
  cached: CachedChatTranscriptDisplayRows,
  projection: ChatTranscriptProjection,
): CachedChatTranscriptDisplayRows | null {
  if (
    projection.update.kind !== 'patch'
    || projection.update.previousRows !== cached.rows
    || projection.update.patches.some(patch => !preservesDisplayRowTopology(cached.rows, patch))
  ) {
    return null
  }

  const displayRows = [...cached.displayRows]
  for (const patch of projection.update.patches) {
    const displayIndex = cached.displayIndexByRowIndex[patch.index]
    const row = patch.rows[0]
    if (displayIndex === undefined || !row)
      return null
    displayRows[displayIndex] = row
  }
  return {
    ...cached,
    displayRows,
    rows: projection.rows,
  }
}

function preservesDisplayRowTopology(
  rows: ReadonlyArray<ChatTranscriptRow>,
  patch: ChatTranscriptRowPatch,
): boolean {
  if (patch.deleteCount !== 1 || patch.rows.length !== 1)
    return false
  const previous = rows[patch.index]
  const next = patch.rows[0]
  if (!previous || !next || previous.kind !== next.kind || previous.key !== next.key)
    return false
  if (previous.kind === 'agent-turn' && next.kind === 'agent-turn') {
    return previous.turn.startedAt === next.turn.startedAt
      && previous.turn.finalMessageId === next.turn.finalMessageId
      && previous.turn.runId === next.turn.runId
  }
  if (previous.kind === 'message' && next.kind === 'message') {
    return previous.message.createdAt === next.message.createdAt
      && previous.message.id === next.message.id
      && previous.message.role === next.message.role
      && previous.message.runId === next.message.runId
  }
  return true
}

function indexChatTranscriptDisplayRows(
  displayRows: ReadonlyArray<ChatTranscriptDisplayRow>,
): number[] {
  const displayIndexByRowIndex: number[] = []
  for (let displayIndex = 0; displayIndex < displayRows.length; displayIndex += 1) {
    if (displayRows[displayIndex]?.kind !== 'day-divider')
      displayIndexByRowIndex.push(displayIndex)
  }
  return displayIndexByRowIndex
}

export function formatChatDayDividerLabel(
  value: string,
  locale: BuddyLocale,
  now = Date.now(),
): string {
  const time = localizedDayjs(value, locale)
  const today = dayjs(now)
  if (time.isSame(today, 'day'))
    return translateBuddy(locale, 'desktop.chat.time.today')
  if (time.isSame(today.subtract(1, 'day'), 'day'))
    return translateBuddy(locale, 'desktop.chat.time.yesterday')
  if (time.isSame(today, 'year'))
    return time.format(locale === 'zh-CN' ? 'M月D日 dddd' : 'MMM D, dddd')
  return time.format(locale === 'zh-CN' ? 'YYYY年M月D日 dddd' : 'MMM D, YYYY dddd')
}

export function formatChatMessageTimeLabel(
  value: string,
): string {
  return dayjs(value).format('HH:mm')
}

function localizedDayjs(value: string, locale: BuddyLocale) {
  return dayjs(value).locale(toDayjsLocale(locale))
}
