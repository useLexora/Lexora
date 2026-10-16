import type {
  DocumentSinglePublicationScope,
  DocumentSinglePublicationState,
  DocumentSinglePublicationTreeItem,
} from '@/apis/document-publication'

export interface PublicationOpenOverviewPanelProps {
  tree: DocumentSinglePublicationTreeItem[]
  loading?: boolean
  updatingDocumentId?: string | null
}

export interface PublicationOpenOverviewPanelEmits {
  updateState: [documentId: string, state: DocumentSinglePublicationState, scope?: DocumentSinglePublicationScope]
}

export type SinglePublicationStateType = 'success' | 'primary' | 'warning' | 'info'
