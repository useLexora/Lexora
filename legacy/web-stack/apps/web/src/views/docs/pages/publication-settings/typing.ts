import type {
  CreatePublicationPageRequest,
  UpdatePublicationPageRequest,
  UpdatePublicationSectionRequest,
  UpsertPublicationSiteSettingsRequest,
} from '@/apis/document-publication'

export type PublicationSettingsTab = 'open-overview' | 'site-config' | 'site-groups' | 'site-navigation'
export type SiteConfigDraft = Omit<UpsertPublicationSiteSettingsRequest, 'workspaceId'>
export type CreatePageDraft = Omit<CreatePublicationPageRequest, 'workspaceId'>
export type UpdatePageDraft = Omit<UpdatePublicationPageRequest, 'workspaceId'>
export type UpdateGroupDraft = Omit<UpdatePublicationSectionRequest, 'workspaceId'>
