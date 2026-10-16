import type { PublicationSidebarPage } from '@haohaoxue/lexora-contracts'

export interface PublicationSidebarPageNodeProps {
  activeDocumentId: string | null
  page: PublicationSidebarPage
  siteId: string
}
