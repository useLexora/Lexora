import type { Dayjs } from 'dayjs'
import type { ChatSessionSummary } from '@/apis/chat'
import { translate } from '@/i18n'
import dayjs from '@/utils/dayjs'

export const DOCS_CHAT_HISTORY_LIMIT = 20

export interface DocsChatHistoryGroup {
  id: 'today' | 'yesterday' | 'last-7-days' | 'last-30-days' | 'older'
  label: string
  sessions: ChatSessionSummary[]
}

export function limitDocsChatHistorySessions(sessions: ChatSessionSummary[]): ChatSessionSummary[] {
  return sessions.slice(0, DOCS_CHAT_HISTORY_LIMIT)
}

export function buildDocsChatHistoryGroups(
  sessions: ChatSessionSummary[],
  options: {
    now?: Dayjs | string
  } = {},
): DocsChatHistoryGroup[] {
  const now = dayjs(options.now)
  const todayStart = now.startOf('day')
  const yesterdayStart = todayStart.subtract(1, 'day')
  const last7DaysStart = todayStart.subtract(7, 'day')
  const last30DaysStart = todayStart.subtract(30, 'day')
  const groups: DocsChatHistoryGroup[] = [
    {
      id: 'today',
      label: translate('docs.history.today'),
      sessions: [],
    },
    {
      id: 'yesterday',
      label: translate('docs.history.yesterday'),
      sessions: [],
    },
    {
      id: 'last-7-days',
      label: translate('docs.chat.last7Days'),
      sessions: [],
    },
    {
      id: 'last-30-days',
      label: translate('docs.chat.last30Days'),
      sessions: [],
    },
    {
      id: 'older',
      label: translate('docs.chat.older'),
      sessions: [],
    },
  ]

  for (const session of limitDocsChatHistorySessions(sessions)) {
    const updatedAt = dayjs(session.updatedAt)

    if (updatedAt.isSame(todayStart, 'day')) {
      groups[0]?.sessions.push(session)
      continue
    }

    if (updatedAt.isSame(yesterdayStart, 'day')) {
      groups[1]?.sessions.push(session)
      continue
    }

    if (updatedAt.isAfter(last7DaysStart)) {
      groups[2]?.sessions.push(session)
      continue
    }

    if (updatedAt.isAfter(last30DaysStart)) {
      groups[3]?.sessions.push(session)
      continue
    }

    groups[4]?.sessions.push(session)
  }

  return groups.filter(group => group.sessions.length > 0)
}
