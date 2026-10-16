import type { ComputedRef, ShallowRef } from 'vue'
import type {
  DocumentHistoryEntry,
  DocumentHistoryGroup,
  DocumentHistorySection,
} from '../typing'
import {
  computed,
  shallowRef,
  watch,
} from 'vue'
import { translate } from '@/i18n'
import dayjs from '@/utils/dayjs'
import {
  buildDocumentHistorySections,
  getDocumentHistoryEntryDetail,
} from '../utils/documentHistory'
import { useActiveDocument } from './useActiveDocument'
import { useDocsHistoryState } from './useDocsHistoryState'

interface UseDocumentHistoryGroupStateOptions {
  historySections: ComputedRef<DocumentHistorySection[]>
  selectedSnapshotId: ShallowRef<string | null>
}

export function useDocumentHistoryPanel() {
  const { currentDocument, snapshots } = useActiveDocument()
  const {
    selectedHistorySnapshotId,
    selectCurrentHistoryContent,
    selectHistorySnapshot,
  } = useDocsHistoryState()

  const hasDocument = computed(() => Boolean(currentDocument.value))
  const currentEntryTimeLabel = computed(() =>
    currentDocument.value
      ? translate('docs.history.updatedAt', {
          time: dayjs(currentDocument.value.updatedAt).format(translate('docs.history.dateTimeFormat')),
        })
      : null,
  )
  const historySections = computed(() => buildDocumentHistorySections({
    document: currentDocument.value,
    snapshots: snapshots.value,
  }))
  const groups = useDocumentHistoryGroupState({
    historySections,
    selectedSnapshotId: selectedHistorySnapshotId,
  })

  function selectEntry(snapshotId: string) {
    selectHistorySnapshot(snapshotId)
    groups.expandGroupBySnapshotId(snapshotId)
  }

  function isEntrySelected(entry: DocumentHistoryEntry) {
    return selectedHistorySnapshotId.value === entry.snapshotId
  }

  function isCurrentEntrySelected() {
    return selectedHistorySnapshotId.value === null
  }

  return {
    hasDocument,
    currentEntryTimeLabel,
    historySections,
    isCurrentEntrySelected,
    isEntrySelected,
    isGroupExpanded: groups.isGroupExpanded,
    resolveEntryDetail,
    selectCurrentEntry: selectCurrentHistoryContent,
    selectEntry,
    toggleGroup: groups.toggleGroup,
  }
}

function useDocumentHistoryGroupState({
  historySections,
  selectedSnapshotId,
}: UseDocumentHistoryGroupStateOptions) {
  const expandedGroupState = shallowRef<Record<string, boolean>>({})

  watch(
    [historySections, selectedSnapshotId],
    ([nextSections, nextSelectedSnapshotId]) => {
      const nextExpandedState = buildExpandedGroupState(nextSections, expandedGroupState.value)

      if (nextSelectedSnapshotId) {
        const targetGroup = findHistoryGroupBySnapshotId(nextSections, nextSelectedSnapshotId)

        if (targetGroup?.collapsible) {
          nextExpandedState[targetGroup.id] = true
        }
      }

      expandedGroupState.value = nextExpandedState
    },
    { immediate: true },
  )

  function toggleGroup(groupId: string) {
    expandedGroupState.value = {
      ...expandedGroupState.value,
      [groupId]: !(expandedGroupState.value[groupId] ?? false),
    }
  }

  function expandGroupBySnapshotId(snapshotId: string) {
    const targetGroup = findHistoryGroupBySnapshotId(historySections.value, snapshotId)

    if (!targetGroup?.collapsible) {
      return
    }

    expandedGroupState.value = {
      ...expandedGroupState.value,
      [targetGroup.id]: true,
    }
  }

  function isGroupExpanded(group: DocumentHistoryGroup) {
    return !group.collapsible || (expandedGroupState.value[group.id] ?? group.defaultExpanded)
  }

  return {
    expandGroupBySnapshotId,
    isGroupExpanded,
    toggleGroup,
  }
}

function resolveEntryDetail(entry: DocumentHistoryEntry) {
  return getDocumentHistoryEntryDetail(entry)
}

function buildExpandedGroupState(
  sections: DocumentHistorySection[],
  currentExpandedGroupState: Record<string, boolean>,
) {
  const nextExpandedState: Record<string, boolean> = {}

  for (const section of sections) {
    for (const group of section.groups) {
      if (!group.collapsible) {
        continue
      }

      nextExpandedState[group.id] = currentExpandedGroupState[group.id] ?? group.defaultExpanded
    }
  }

  return nextExpandedState
}

function findHistoryGroupBySnapshotId(sections: DocumentHistorySection[], snapshotId: string) {
  return sections
    .flatMap(section => section.groups)
    .find(group => group.entries.some(entry => entry.snapshotId === snapshotId))
}
