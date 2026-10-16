import type { DocumentItem, DocumentTreeCollectionId } from '@haohaoxue/lexora-contracts'

export interface DocumentItemProps {
  item: DocumentItem
  collectionId: DocumentTreeCollectionId
  selectionMode?: boolean
  checked?: boolean
  expanded?: boolean
}
