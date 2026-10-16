import type {
  CreatePublicationPageRequest,
  CreatePublicationSectionRequest,
  DocumentSinglePublicationInfo,
  ListDocumentSinglePublicationsResponse,
  PublicationSingleDocumentResponse,
  PublicationSiteCustomMediaResponse,
  PublicationSiteCustomMediaScope,
  PublicationSiteManagementResponse,
  PublicationSiteMediaKind,
  PublicationSiteRenderResponse,
  ReplacePublicationNavItemsRequest,
  ResolveDocumentAssetsRequest,
  ResolveDocumentAssetsResponse,
  UpdateDocumentSinglePublicationSettingRequest,
  UpdatePublicationPageRequest,
  UpdatePublicationSectionRequest,
  UpsertPublicationSiteSettingsRequest,
} from './typing'
import { axios } from '@/utils/axios'

export * from './typing'

export function listDocumentSinglePublications(workspaceId: string): Promise<ListDocumentSinglePublicationsResponse> {
  return axios.request({
    method: 'get',
    url: '/documents/publications/single',
    params: {
      workspaceId,
    },
  })
}

export function getDocumentSinglePublication(documentId: string): Promise<DocumentSinglePublicationInfo> {
  return axios.request({
    method: 'get',
    url: `/documents/${documentId}/single-publication`,
  })
}

export function updateDocumentSinglePublication(
  documentId: string,
  data: UpdateDocumentSinglePublicationSettingRequest,
): Promise<DocumentSinglePublicationInfo> {
  return axios.request({
    method: 'put',
    url: `/documents/${documentId}/single-publication`,
    data,
  })
}

export function getPublicationSiteManagement(workspaceId: string): Promise<PublicationSiteManagementResponse> {
  return axios.request({
    method: 'get',
    url: '/documents/publications/site',
    params: {
      workspaceId,
    },
  })
}

export function updatePublicationSiteSettings(
  data: UpsertPublicationSiteSettingsRequest,
): Promise<PublicationSiteManagementResponse> {
  return axios.request({
    method: 'put',
    url: '/documents/publications/site',
    data,
  })
}

export function updatePublicationSiteMedia(
  workspaceId: string,
  kind: PublicationSiteMediaKind,
  file: File,
): Promise<PublicationSiteManagementResponse> {
  const formData = new FormData()
  formData.set('file', file)

  return axios.request({
    method: 'put',
    url: `/documents/publications/site/media/${kind}`,
    params: {
      workspaceId,
    },
    data: formData,
  })
}

export function updatePublicationSiteCustomMedia(
  workspaceId: string,
  scope: PublicationSiteCustomMediaScope,
  mediaId: string,
  file: File,
): Promise<PublicationSiteCustomMediaResponse> {
  const formData = new FormData()
  formData.set('file', file)

  return axios.request({
    method: 'put',
    url: `/documents/publications/site/custom-media/${scope}/${mediaId}`,
    params: {
      workspaceId,
    },
    data: formData,
  })
}

export function removePublicationSiteMedia(
  workspaceId: string,
  kind: PublicationSiteMediaKind,
): Promise<PublicationSiteManagementResponse> {
  return axios.request({
    method: 'delete',
    url: `/documents/publications/site/media/${kind}`,
    params: {
      workspaceId,
    },
  })
}

export function createPublicationSection(
  data: CreatePublicationSectionRequest,
): Promise<PublicationSiteManagementResponse> {
  return axios.request({
    method: 'post',
    url: '/documents/publications/site/sections',
    data,
  })
}

export function updatePublicationSection(
  sectionId: string,
  data: UpdatePublicationSectionRequest,
): Promise<PublicationSiteManagementResponse> {
  return axios.request({
    method: 'put',
    url: `/documents/publications/site/sections/${sectionId}`,
    data,
  })
}

export function removePublicationSection(
  sectionId: string,
  workspaceId: string,
): Promise<PublicationSiteManagementResponse> {
  return axios.request({
    method: 'delete',
    url: `/documents/publications/site/sections/${sectionId}`,
    params: {
      workspaceId,
    },
  })
}

export function createPublicationPage(
  data: CreatePublicationPageRequest,
): Promise<PublicationSiteManagementResponse> {
  return axios.request({
    method: 'post',
    url: '/documents/publications/site/pages',
    data,
  })
}

export function updatePublicationPage(
  pageId: string,
  data: UpdatePublicationPageRequest,
): Promise<PublicationSiteManagementResponse> {
  return axios.request({
    method: 'put',
    url: `/documents/publications/site/pages/${pageId}`,
    data,
  })
}

export function removePublicationPage(
  pageId: string,
  workspaceId: string,
): Promise<PublicationSiteManagementResponse> {
  return axios.request({
    method: 'delete',
    url: `/documents/publications/site/pages/${pageId}`,
    params: {
      workspaceId,
    },
  })
}

export function replacePublicationNavItems(
  data: ReplacePublicationNavItemsRequest,
): Promise<PublicationSiteManagementResponse> {
  return axios.request({
    method: 'put',
    url: '/documents/publications/site/nav-items',
    data,
  })
}

export function getSinglePublicDocument(documentId: string): Promise<PublicationSingleDocumentResponse> {
  return axios.request({
    method: 'get',
    url: `/p/${documentId}`,
  })
}

export function resolveSinglePublicationAssets(
  documentId: string,
  data: ResolveDocumentAssetsRequest,
): Promise<ResolveDocumentAssetsResponse> {
  return axios.request({
    method: 'post',
    url: `/p/${documentId}/assets/resolve`,
    data,
  })
}

export function getPublicationSiteRender(
  siteId: string,
  documentId?: string | null,
): Promise<PublicationSiteRenderResponse> {
  return axios.request({
    method: 'get',
    url: documentId ? `/s/${siteId}/${documentId}` : `/s/${siteId}`,
  })
}

export function resolveDocumentPublicationAssets(
  publicationId: string,
  documentId: string,
  data: ResolveDocumentAssetsRequest,
): Promise<ResolveDocumentAssetsResponse> {
  return axios.request({
    method: 'post',
    url: `/publications/${publicationId}/documents/${documentId}/assets/resolve`,
    data,
  })
}
