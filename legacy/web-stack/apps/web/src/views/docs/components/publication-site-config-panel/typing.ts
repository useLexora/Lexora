import type {
  DocumentSinglePublicationTreeItem,
  PublicationPage,
  PublicationSection,
  PublicationSite,
  PublicationSiteCustomMediaScope,
  PublicationSiteHomeConfig,
  PublicationSiteMediaKind,
  UpsertPublicationSiteSettingsRequest,
} from '@/apis/document-publication'

export type SiteConfigDraft = Omit<UpsertPublicationSiteSettingsRequest, 'workspaceId'>

export interface PublicationSiteConfigPanelProps {
  site: PublicationSite | null
  tree: DocumentSinglePublicationTreeItem[]
  sections: PublicationSection[]
  pages: PublicationPage[]
  loading?: boolean
  saving?: boolean
  uploadingMediaKind?: PublicationSiteMediaKind | null
  uploadingCustomMediaKey?: string
  uploadCustomMedia?: (scope: PublicationSiteCustomMediaScope, mediaId: string, file: File) => Promise<string>
}

export interface PublicationSiteConfigPanelEmits {
  save: [payload: SiteConfigDraft]
  uploadMedia: [kind: PublicationSiteMediaKind, file: File]
  removeMedia: [kind: PublicationSiteMediaKind]
}

export interface SiteConfigForm {
  title: string
  logoUrl: string
  siteAccessEnabled: boolean
  heroName: string
  heroText: string
  heroTagline: string
  heroImageUrl: string
  actions: SiteHomeActionDraft[]
  features: SiteHomeFeatureDraft[]
  footerMessage: string
  footerCopyright: string
}

export type SiteHomeConfigDraft = PublicationSiteHomeConfig

export interface SiteHomeActionDraft {
  localId: string
  label: string
  targetDocumentId: string
  theme: PublicationSiteHomeConfig['actions'][number]['theme']
}

export interface SiteHomeFeatureDraft {
  localId: string
  title: string
  details: string
  icon: string
}
