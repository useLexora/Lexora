import type {
  CreatePublicationPageRequest,
  DocumentSinglePublicationTreeItem,
  PublicationPage,
  PublicationSection,
  PublicationSitePageScope,
  UpdatePublicationPageRequest,
  UpdatePublicationSectionRequest,
} from '@/apis/document-publication'

export type CreatePageDraft = Omit<CreatePublicationPageRequest, 'workspaceId'>
export type UpdatePageDraft = Omit<UpdatePublicationPageRequest, 'workspaceId'>
export type UpdateGroupDraft = Omit<UpdatePublicationSectionRequest, 'workspaceId'>

export interface PublicationSiteGroupPanelProps {
  tree: DocumentSinglePublicationTreeItem[]
  groups: PublicationSection[]
  pages: PublicationPage[]
  loading?: boolean
  mutating?: boolean
}

export interface PublicationSiteGroupPanelEmits {
  createPage: [payload: CreatePageDraft]
  createGroup: [title: string]
  removeGroup: [groupId: string]
  removePage: [pageId: string]
  reorderPages: [orders: PublicationSitePageOrderDraft[]]
  updateGroup: [groupId: string, payload: UpdateGroupDraft, options?: PublicationSiteGroupMutationOptions]
  updatePage: [pageId: string, payload: UpdatePageDraft]
}

export interface PublicationSiteGroupMutationOptions {
  silent?: boolean
}

export interface PublicationSitePageOrderDraft {
  pageId: string
  order: number
}

export interface DocumentSelectNode {
  value: string
  label: string
  disabled: boolean
  children: DocumentSelectNode[]
}

export interface PublicationPageForm {
  sectionId: string
  documentId: string
  scope: PublicationSitePageScope
  order: number
}
