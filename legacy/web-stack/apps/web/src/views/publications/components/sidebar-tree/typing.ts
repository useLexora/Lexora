import type { PublicationSidebarGroup } from '@haohaoxue/lexora-contracts'

export interface PublicationSidebarTreeProps {
  activeDocumentId: string | null
  groups: PublicationSidebarGroup[]
  siteId: string
}
