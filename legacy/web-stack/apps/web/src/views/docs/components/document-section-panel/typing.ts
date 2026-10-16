import type { DocumentTreeGroup } from '@haohaoxue/lexora-contracts'

export interface DocumentSectionPanelProps {
  group: DocumentTreeGroup
  fillHeight?: boolean
  selectionMode?: boolean
}

export interface DocumentSectionPanelEmits {
  checkedChange: [documentIds: string[]]
  open: [documentId: string]
}

export interface DocumentSectionPanelSlots {
  headerAction?: (props: { group: DocumentTreeGroup }) => unknown
}
