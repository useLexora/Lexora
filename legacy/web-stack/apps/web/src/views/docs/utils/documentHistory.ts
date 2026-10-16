import type { DocumentVersionSnapshot } from '@haohaoxue/lexora-contracts'
import type { Dayjs } from 'dayjs'
import type {
  ActiveDocumentDetail,
  DocumentHistoryEntry,
  DocumentHistoryGroup,
  DocumentHistorySection,
} from '../typing'
import { DOCUMENT_VERSION_SNAPSHOT_SOURCE } from '@haohaoxue/lexora-contracts/document/constants'
import {
  getDocumentVersionSnapshotTitlePlainText,
  isSameDocumentVersionSnapshotContent,
} from '@haohaoxue/lexora-shared/document'
import { translate } from '@/i18n'
import dayjs from '@/utils/dayjs'

export function getDocumentHistoryEntryDetail(entry: DocumentHistoryEntry): string | null {
  if (entry.summary) {
    return entry.summary
  }

  if (entry.changeCount > 1) {
    return translate('docs.history.editedTimes', { count: entry.changeCount })
  }

  return null
}

export function buildDocumentHistorySections(options: {
  document: ActiveDocumentDetail | null
  snapshots: DocumentVersionSnapshot[]
  now?: Dayjs
}): DocumentHistorySection[] {
  if (!options.document || options.snapshots.length === 0) {
    return []
  }

  const now = options.now ?? dayjs()
  const currentContent = {
    schemaVersion: options.document.schemaVersion,
    title: options.document.title,
    body: options.document.body,
  }
  const snapshotById = new Map(options.snapshots.map(snapshot => [snapshot.id, snapshot]))
  const minuteEntries = collapseSnapshotsByMinute({
    currentContent,
    currentProjectionRevision: options.document.currentProjectionRevision,
    snapshots: options.snapshots,
    snapshotById,
  })

  const todayEntries = minuteEntries.filter(entry => dayjs(entry.snapshot.createdAt).isSame(now, 'day'))
  const yesterdayEntries = minuteEntries.filter(entry => dayjs(entry.snapshot.createdAt).isSame(now.subtract(1, 'day'), 'day'))
  const lastWeekEntries = minuteEntries.filter((entry) => {
    const snapshotTime = dayjs(entry.snapshot.createdAt)
    return snapshotTime.isAfter(now.startOf('day').subtract(7, 'day'))
      && !snapshotTime.isSame(now, 'day')
      && !snapshotTime.isSame(now.subtract(1, 'day'), 'day')
  })
  const olderEntries = minuteEntries.filter((entry) => {
    const snapshotTime = dayjs(entry.snapshot.createdAt)
    return !snapshotTime.isAfter(now.startOf('day').subtract(7, 'day'))
      && !snapshotTime.isSame(now, 'day')
      && !snapshotTime.isSame(now.subtract(1, 'day'), 'day')
  })

  const sections: DocumentHistorySection[] = []

  if (todayEntries.length > 0) {
    const recentUpdateEntries = todayEntries.filter(
      entry => entry.snapshot.source !== DOCUMENT_VERSION_SNAPSHOT_SOURCE.RESTORE,
    )
    const todayRestoreEntries = todayEntries.filter(
      entry => entry.snapshot.source === DOCUMENT_VERSION_SNAPSHOT_SOURCE.RESTORE,
    )
    const groups: DocumentHistoryGroup[] = []

    if (recentUpdateEntries.length > 0) {
      groups.push({
        id: 'today-recent-updates',
        label: translate('docs.history.recentUpdates'),
        entries: recentUpdateEntries,
        collapsible: true,
        defaultExpanded: true,
      })
    }

    for (const entry of todayRestoreEntries) {
      groups.push({
        id: `today-${entry.snapshotId}`,
        label: '',
        entries: [entry],
        collapsible: false,
        defaultExpanded: true,
      })
    }

    sections.push({
      id: 'today',
      label: translate('docs.history.today'),
      groups,
    })
  }

  if (yesterdayEntries.length > 0) {
    sections.push({
      id: 'yesterday',
      label: translate('docs.history.yesterday'),
      groups: groupEntriesByTimeBucket({
        entries: yesterdayEntries,
        mode: 'hour',
      }),
    })
  }

  if (lastWeekEntries.length > 0) {
    sections.push({
      id: 'last-week',
      label: translate('docs.history.lastWeek'),
      groups: groupEntriesByTimeBucket({
        entries: lastWeekEntries,
        mode: 'day',
      }),
    })
  }

  sections.push(...buildMonthSections(olderEntries))

  return sections
}

function collapseSnapshotsByMinute(options: {
  currentContent: Pick<DocumentVersionSnapshot, 'schemaVersion' | 'title' | 'body'>
  currentProjectionRevision: number
  snapshots: DocumentVersionSnapshot[]
  snapshotById: Map<string, DocumentVersionSnapshot>
}): DocumentHistoryEntry[] {
  const minuteGroups: DocumentVersionSnapshot[][] = []

  for (const snapshot of options.snapshots) {
    const minuteKey = dayjs(snapshot.createdAt).startOf('minute').valueOf()
    const lastGroup = minuteGroups.at(-1)

    if (lastGroup && dayjs(lastGroup[0].createdAt).startOf('minute').valueOf() === minuteKey) {
      lastGroup.push(snapshot)
      continue
    }

    minuteGroups.push([snapshot])
  }

  return minuteGroups.map((group, index) => {
    const snapshot = group[0]
    const previousSnapshot = minuteGroups[index + 1]?.[0] ?? null

    return {
      snapshotId: snapshot.id,
      snapshot,
      timeLabel: formatHistoryTime(snapshot.createdAt),
      summary: resolveHistoryEntrySummary(snapshot, previousSnapshot, options.snapshotById),
      userDisplayName: snapshot.createdByUser?.displayName ?? translate('docs.history.unknownUser'),
      changeCount: group.length,
      isCurrentSnapshot: snapshot.basedOnProjectionRevision === options.currentProjectionRevision,
      isCurrentContent: isSameDocumentVersionSnapshotContent(options.currentContent, snapshot),
    }
  })
}

function resolveHistoryEntrySummary(
  snapshot: DocumentVersionSnapshot,
  previousSnapshot: DocumentVersionSnapshot | null,
  snapshotById: Map<string, DocumentVersionSnapshot>,
) {
  if (snapshot.source === DOCUMENT_VERSION_SNAPSHOT_SOURCE.RESTORE && snapshot.restoredFromVersionSnapshotId) {
    const restoredFromSnapshot = snapshotById.get(snapshot.restoredFromVersionSnapshotId)

    if (!restoredFromSnapshot) {
      return translate('docs.history.restored')
    }

    return translate('docs.history.restoredFrom', {
      time: formatHistoryTime(restoredFromSnapshot.createdAt),
    })
  }

  if (!previousSnapshot) {
    return null
  }

  const nextTitle = getDocumentVersionSnapshotTitlePlainText(snapshot)
  const previousTitle = getDocumentVersionSnapshotTitlePlainText(previousSnapshot)

  if (nextTitle && nextTitle !== previousTitle) {
    return translate('docs.history.renamedTo', { title: nextTitle })
  }

  return null
}

function groupEntriesByTimeBucket(options: {
  entries: DocumentHistoryEntry[]
  mode: 'hour' | 'day'
}): DocumentHistoryGroup[] {
  const groups = new Map<string, DocumentHistoryEntry[]>()

  for (const entry of options.entries) {
    const bucketKey = options.mode === 'hour'
      ? dayjs(entry.snapshot.createdAt).startOf('hour').toISOString()
      : dayjs(entry.snapshot.createdAt).startOf('day').toISOString()
    const currentEntries = groups.get(bucketKey) ?? []
    currentEntries.push(entry)
    groups.set(bucketKey, currentEntries)
  }

  return Array.from(groups.entries()).map(([bucketKey, entries]) => ({
    id: bucketKey,
    label: options.mode === 'hour'
      ? formatHourBucketLabel(bucketKey)
      : formatDayBucketLabel(bucketKey),
    entries,
    collapsible: true,
    defaultExpanded: false,
  }))
}

function buildMonthSections(entries: DocumentHistoryEntry[]): DocumentHistorySection[] {
  const sections = new Map<string, DocumentHistoryEntry[]>()

  for (const entry of entries) {
    const sectionKey = dayjs(entry.snapshot.createdAt).startOf('month').toISOString()
    const currentEntries = sections.get(sectionKey) ?? []
    currentEntries.push(entry)
    sections.set(sectionKey, currentEntries)
  }

  return Array.from(sections.entries()).map(([sectionKey, sectionEntries]) => ({
    id: sectionKey,
    label: dayjs(sectionKey).format(translate('docs.history.monthFormat')),
    groups: groupEntriesByTimeBucket({
      entries: sectionEntries,
      mode: 'day',
    }),
  }))
}

function formatHistoryTime(value: string) {
  return dayjs(value).format(translate('docs.history.dateTimeFormat'))
}

function formatHourBucketLabel(value: string) {
  return dayjs(value).format(translate('docs.history.hourFormat'))
}

function formatDayBucketLabel(value: string) {
  return dayjs(value).format(translate('docs.history.dateFormat'))
}
