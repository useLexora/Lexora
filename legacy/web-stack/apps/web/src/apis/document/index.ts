import type {
  BatchDeleteDocumentsRequest,
  BatchDeleteDocumentsResponse,
  CreateDocumentDuplicateOperationResponse,
  CreateDocumentMoveOperationResponse,
  CreateDocumentRequest,
  CreateDocumentResponse,
  CreateDocumentVersionSnapshotRequest,
  CreateDocumentVersionSnapshotResponse,
  DocumentAsset,
  DocumentCurrent,
  DocumentHistory,
  DocumentOperationJob,
  DocumentTrashItem,
  DocumentTreeGroup,
  DocumentVersionSnapshot,
  MoveDocumentTreeOperationRequest,
  PatchDocumentLayoutRequest,
  PatchDocumentMetaRequest,
  ReadableDocumentSearchResult,
  ResolveDocumentAssetsRequest,
  ResolveDocumentAssetsResponse,
  RestoreDocumentVersionSnapshotRequest,
  RestoreDocumentVersionSnapshotResponse,
  SaveDocumentContentRequest,
  SaveDocumentContentResponse,
  SearchReadableDocumentsResponse,
} from './typing'
import { axios } from '@/utils/axios'

export * from './typing'

const DOCUMENT_CONTENT_SAVE_TIMEOUT_MS = 30_000

export function getDocuments(workspaceId: string): Promise<DocumentTreeGroup[]> {
  return axios.request({
    method: 'get',
    url: '/documents',
    params: {
      workspaceId,
    },
  })
}

export async function searchReadableDocumentsForChat(
  workspaceId: string,
  query: string,
): Promise<ReadableDocumentSearchResult[]> {
  const response: SearchReadableDocumentsResponse = await axios.request({
    method: 'get',
    url: '/documents/search',
    params: {
      workspaceId,
      query,
    },
  })

  return response.documents
}

export function createDocument(data: CreateDocumentRequest): Promise<CreateDocumentResponse> {
  return axios.request({
    method: 'post',
    url: '/documents',
    data,
  })
}

export function createDocumentDuplicateOperation(
  id: string,
): Promise<CreateDocumentDuplicateOperationResponse> {
  return axios.request({
    method: 'post',
    url: `/documents/${id}/operation-jobs/duplicate`,
  })
}

export function createDocumentMoveOperation(
  id: string,
  data: MoveDocumentTreeOperationRequest,
): Promise<CreateDocumentMoveOperationResponse> {
  return axios.request({
    method: 'post',
    url: `/documents/${id}/operation-jobs/move`,
    data,
  })
}

export function getDocumentOperationJob(id: string): Promise<DocumentOperationJob> {
  return axios.request({
    method: 'get',
    url: `/document-operation-jobs/${id}`,
  })
}

export function getTrashDocuments(workspaceId: string): Promise<DocumentTrashItem[]> {
  return axios.request({
    method: 'get',
    url: '/documents/trash',
    params: {
      workspaceId,
    },
  })
}

export function getDocumentCurrent(id: string): Promise<DocumentCurrent> {
  return axios.request({
    method: 'get',
    url: `/documents/${id}`,
  })
}

export function saveDocumentContent(
  id: string,
  data: SaveDocumentContentRequest,
): Promise<SaveDocumentContentResponse> {
  return axios.request({
    method: 'put',
    url: `/documents/${id}/content`,
    data,
    timeout: DOCUMENT_CONTENT_SAVE_TIMEOUT_MS,
  })
}

export function createDocumentVersionSnapshot(
  id: string,
  data: CreateDocumentVersionSnapshotRequest,
): Promise<CreateDocumentVersionSnapshotResponse> {
  return axios.request({
    method: 'post',
    url: `/documents/${id}/version-snapshots`,
    data,
  })
}

export function getDocumentVersionSnapshots(id: string): Promise<DocumentVersionSnapshot[]> {
  return axios.request({
    method: 'get',
    url: `/documents/${id}/version-snapshots`,
  })
}

export function getDocumentHistory(id: string): Promise<DocumentHistory> {
  return axios.request({
    method: 'get',
    url: `/documents/${id}/history`,
  })
}

export function restoreDocumentVersionSnapshot(
  id: string,
  data: RestoreDocumentVersionSnapshotRequest,
): Promise<RestoreDocumentVersionSnapshotResponse> {
  return axios.request({
    method: 'post',
    url: `/documents/${id}/restore-version`,
    data,
  })
}

export function patchDocumentMeta(id: string, data: PatchDocumentMetaRequest): Promise<DocumentCurrent> {
  return axios.request({
    method: 'patch',
    url: `/documents/${id}/meta`,
    data,
  })
}

export function patchDocumentLayout(id: string, data: PatchDocumentLayoutRequest): Promise<DocumentCurrent> {
  return axios.request({
    method: 'patch',
    url: `/documents/${id}/layout`,
    data,
  })
}

export function deleteDocument(id: string): Promise<null> {
  return axios.request({
    method: 'delete',
    url: `/documents/${id}`,
  })
}

export function batchDeleteDocuments(data: BatchDeleteDocumentsRequest): Promise<BatchDeleteDocumentsResponse> {
  return axios.request({
    method: 'post',
    url: '/documents/batch-delete',
    data,
  })
}

export function restoreDocumentFromTrash(id: string): Promise<null> {
  return axios.request({
    method: 'post',
    url: `/documents/${id}/restore-from-trash`,
  })
}

export function permanentlyDeleteDocument(id: string): Promise<null> {
  return axios.request({
    method: 'delete',
    url: `/documents/${id}/permanent`,
  })
}

export function uploadDocumentImage(id: string, file: File): Promise<DocumentAsset> {
  const data = new FormData()
  data.append('file', file)

  return axios.request({
    method: 'post',
    url: `/documents/${id}/assets/images`,
    data,
  })
}

export function uploadDocumentFile(id: string, file: File): Promise<DocumentAsset> {
  const data = new FormData()
  data.append('file', file)

  return axios.request({
    method: 'post',
    url: `/documents/${id}/assets/files`,
    data,
  })
}

export function resolveDocumentAssets(
  id: string,
  data: ResolveDocumentAssetsRequest,
): Promise<ResolveDocumentAssetsResponse> {
  return axios.request({
    method: 'post',
    url: `/documents/${id}/assets/resolve`,
    data,
  })
}
