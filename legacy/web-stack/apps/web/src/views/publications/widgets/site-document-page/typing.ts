import type {
  PublicationPageOutlineItem,
  PublicationRenderedDocument,
  PublicationSidebarGroup,
  TiptapJsonContent,
} from '@haohaoxue/lexora-contracts'

export interface PublicationSiteDocumentPageProps {
  body: TiptapJsonContent
  document: PublicationRenderedDocument | null
  activeDocumentId?: string | null
  isLoading?: boolean
  outline: PublicationPageOutlineItem[]
  sidebarGroups: PublicationSidebarGroup[]
  siteId: string
}
