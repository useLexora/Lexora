import type { DocumentTreeGroup } from '@haohaoxue/lexora-contracts'
import { formatDocumentCollectionLabel } from '@haohaoxue/lexora-shared/document'
import { computed } from 'vue'
import { useDocsSurfaceState } from './useDocsSurfaceState'

export interface UseDocumentSectionPanelOptions {
  group: () => DocumentTreeGroup
}

export function useDocumentSectionPanel(options: UseDocumentSectionPanelOptions) {
  const { collapsedGroupIdSet, toggleGroupCollapse } = useDocsSurfaceState()
  const group = computed(options.group)

  const displayLabel = computed(() => formatDocumentCollectionLabel(group.value.id))
  const isCollapsed = computed(() => collapsedGroupIdSet.value.has(group.value.id))
  const chevronIconName = computed(() => isCollapsed.value ? 'chevron-right' : 'chevron-down')

  function toggleSection() {
    toggleGroupCollapse(group.value.id)
  }

  return {
    chevronIconName,
    displayLabel,
    isCollapsed,
    toggleSection,
  }
}
