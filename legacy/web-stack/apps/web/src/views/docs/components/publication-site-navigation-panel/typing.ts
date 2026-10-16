import type {
  PublicationNavItem,
  PublicationNavItemExternalTarget,
  PublicationNavItemInput,
  PublicationNavItemInternalTarget,
  PublicationPage,
  PublicationSection,
  PublicationSiteCustomMediaScope,
} from '@/apis/document-publication'

export interface PublicationSiteNavigationPanelProps {
  sections: PublicationSection[]
  pages: PublicationPage[]
  navItems: PublicationNavItem[]
  saving?: boolean
  uploadingCustomMediaKey?: string
  uploadCustomMedia?: (scope: PublicationSiteCustomMediaScope, mediaId: string, file: File) => Promise<string>
}

export interface PublicationSiteNavigationPanelEmits {
  save: [items: PublicationNavItemInput[]]
}

export interface SiteNavigationItemDraft {
  localId: string
  id?: string
  type: PublicationNavItemInput['type']
  label: string
  icon: string
  parentId: string
  target: PublicationNavItemInternalTarget
  targetId: string
  url: string
  openTarget: PublicationNavItemExternalTarget
  order: number
  status: PublicationNavItemInput['status']
}
