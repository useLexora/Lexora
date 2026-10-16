import type { PublicationSiteMeta } from '@haohaoxue/lexora-contracts'
import type { ResolvedPublicationNavItem } from '../../utils/publicationRendering'

export interface PublicationTopNavProps {
  home?: boolean
  navItems: ResolvedPublicationNavItem[]
  site: PublicationSiteMeta
}
