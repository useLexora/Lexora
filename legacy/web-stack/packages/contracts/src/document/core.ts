import type { TiptapJsonContent } from '../tiptap/core'
import type {
  DOCUMENT_PANE_STATE,
  DOCUMENT_SAVE_STATE,
} from './constants'
import { z } from 'zod'
import { AuditUserSummarySchema } from '../identity'
import { TiptapJsonContentPayloadSchema, TiptapSchemaVersionSchema } from '../tiptap/core'
import { WorkspaceTypeSchema } from '../workspace'
import { DocumentAccessSchema } from './access'
import {
  DOCUMENT_CHAT_SEARCH_LIMIT,
  DOCUMENT_CHAT_SEARCH_QUERY_MAX_LENGTH,
  DOCUMENT_COLLECTION_VALUES,
  DOCUMENT_DEFAULT_TITLE,
  DOCUMENT_OPERATION_JOB_STATUS_VALUES,
  DOCUMENT_OPERATION_JOB_TYPE_VALUES,
  DOCUMENT_OWNED_COLLECTION_VALUES,
  DOCUMENT_PAGE_WIDTH_MODE_VALUES,
  DOCUMENT_TITLE_MAX_LENGTH,
  DOCUMENT_TREE_COLLECTION_VALUES,
  DOCUMENT_VERSION_SNAPSHOT_SOURCE,
  DOCUMENT_VERSION_SNAPSHOT_SOURCE_VALUES,
  DOCUMENT_VISIBILITY_VALUES,
} from './constants'

export {
  DOCUMENT_CHAT_SEARCH_LIMIT,
  DOCUMENT_CHAT_SEARCH_QUERY_MAX_LENGTH,
  DOCUMENT_COLLECTION,
  DOCUMENT_COLLECTION_LABELS,
  DOCUMENT_COLLECTION_VALUES,
  DOCUMENT_DEFAULT_TITLE,
  DOCUMENT_OPERATION_JOB_STATUS,
  DOCUMENT_OPERATION_JOB_STATUS_VALUES,
  DOCUMENT_OPERATION_JOB_TYPE,
  DOCUMENT_OPERATION_JOB_TYPE_VALUES,
  DOCUMENT_OWNED_COLLECTION_VALUES,
  DOCUMENT_PAGE_WIDTH_MODE,
  DOCUMENT_PAGE_WIDTH_MODE_LABELS,
  DOCUMENT_PAGE_WIDTH_MODE_VALUES,
  DOCUMENT_PANE_STATE,
  DOCUMENT_SAVE_STATE,
  DOCUMENT_TITLE_MAX_LENGTH,
  DOCUMENT_TREE_COLLECTION_VALUES,
  DOCUMENT_VERSION_SNAPSHOT_SOURCE,
  DOCUMENT_VERSION_SNAPSHOT_SOURCE_VALUES,
  DOCUMENT_VISIBILITY,
  DOCUMENT_VISIBILITY_VALUES,
} from './constants'

export const DocumentStatusSchema = z.enum(['ACTIVE', 'LOCKED'])
export const DocumentVisibilitySchema = z.enum(DOCUMENT_VISIBILITY_VALUES)
export const DocumentPageWidthModeSchema = z.enum(DOCUMENT_PAGE_WIDTH_MODE_VALUES)

export const DocumentCollectionIdSchema = z.enum(DOCUMENT_COLLECTION_VALUES)
export const DocumentTreeCollectionIdSchema = z.enum(DOCUMENT_TREE_COLLECTION_VALUES)
export const DocumentOwnedCollectionIdSchema = z.enum(DOCUMENT_OWNED_COLLECTION_VALUES)
export const DocumentOperationJobTypeSchema = z.enum(DOCUMENT_OPERATION_JOB_TYPE_VALUES)
export const DocumentOperationJobStatusSchema = z.enum(DOCUMENT_OPERATION_JOB_STATUS_VALUES)

export const DocumentBaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const DocumentTrashItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  collection: DocumentCollectionIdSchema,
  ancestorTitles: z.string().array(),
  trashedAt: z.string(),
}).strict()

export const DocumentItemSchema = DocumentBaseSchema.extend({
  parentId: z.string().nullable(),
  hasChildren: z.boolean(),
  hasContent: z.boolean(),
  get children() {
    return z.array(DocumentItemSchema)
  },
})

export const DocumentTreeGroupSchema = z.object({
  id: DocumentTreeCollectionIdSchema,
  nodes: DocumentItemSchema.array(),
})

export const DocumentRevisionSchema = z.number().int().min(0)

export const DocumentTitleContentSchema: z.ZodType<TiptapJsonContent> = z.array(z.object({
  type: z.literal('text'),
  text: z.string().max(DOCUMENT_TITLE_MAX_LENGTH),
}).strict()).max(1)

export const DocumentVersionSnapshotSourceSchema = z.enum(DOCUMENT_VERSION_SNAPSHOT_SOURCE_VALUES)

export const DocumentAssetKindSchema = z.enum(['image', 'file'])

export const DocumentAssetStatusSchema = z.enum(['pending', 'ready', 'deleted'])

export const DocumentRecordSchema = DocumentBaseSchema.omit({
  title: true,
}).extend({
  workspaceId: z.string(),
  createdBy: z.string(),
  visibility: DocumentVisibilitySchema,
  parentId: z.string().nullable(),
  currentProjectionId: z.string().nullable(),
  currentProjectionRevision: DocumentRevisionSchema,
  latestVersionSnapshotId: z.string().nullable(),
  order: z.number().int(),
  status: DocumentStatusSchema,
  pageWidthMode: DocumentPageWidthModeSchema,
  access: DocumentAccessSchema,
}).strict()

export const DocumentCurrentProjectionSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  projectionRevision: DocumentRevisionSchema,
  schemaVersion: TiptapSchemaVersionSchema,
  title: DocumentTitleContentSchema,
  body: TiptapJsonContentPayloadSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict()

export const DocumentVersionSnapshotSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  version: DocumentRevisionSchema,
  basedOnProjectionId: z.string().nullable(),
  basedOnProjectionRevision: DocumentRevisionSchema,
  schemaVersion: TiptapSchemaVersionSchema,
  title: DocumentTitleContentSchema,
  body: TiptapJsonContentPayloadSchema,
  source: DocumentVersionSnapshotSourceSchema,
  restoredFromVersionSnapshotId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  label: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  createdByUser: AuditUserSummarySchema.nullable(),
}).strict()

export const DocumentCurrentSchema = z.object({
  document: DocumentRecordSchema,
  currentProjection: DocumentCurrentProjectionSchema,
}).strict()

export const DocumentHistoryCurrentSchema = z.object({
  projectionRevision: DocumentRevisionSchema,
  updatedAt: z.string(),
  matchedVersionSnapshotId: z.string().nullable(),
  hasUnversionedChanges: z.boolean(),
}).strict()

export const DocumentHistorySchema = z.object({
  current: DocumentHistoryCurrentSchema,
  snapshots: DocumentVersionSnapshotSchema.array(),
}).strict()

export const DocumentOperationJobSchema = z.object({
  id: z.string(),
  type: DocumentOperationJobTypeSchema,
  status: DocumentOperationJobStatusSchema,
  sourceDocumentId: z.string().nullable(),
  targetWorkspaceId: z.string().nullable(),
  targetParentId: z.string().nullable(),
  targetVisibility: DocumentVisibilitySchema.nullable(),
  documentsTotal: z.number().int().nonnegative(),
  documentsDone: z.number().int().nonnegative(),
  assetsTotal: z.number().int().nonnegative(),
  assetsDone: z.number().int().nonnegative(),
  resultDocumentId: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict()

export const DocumentAssetSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  kind: DocumentAssetKindSchema,
  status: DocumentAssetStatusSchema,
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  fileName: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  contentUrl: z.string().nullable(),
  createdAt: z.string(),
}).strict()

export const CreateDocumentSchema = z.object({
  title: z.string().trim().min(1).max(DOCUMENT_TITLE_MAX_LENGTH).default(DOCUMENT_DEFAULT_TITLE),
  workspaceId: z.string().trim().min(1),
  visibility: DocumentVisibilitySchema.optional(),
  parentId: z.string().trim().nullable().optional(),
}).strict()

export const CreateDocumentResponseSchema = z.object({
  id: z.string().trim().min(1),
}).strict()

export const BatchDeleteDocumentsRequestSchema = z.object({
  workspaceId: z.string().trim().min(1),
  documentIds: z.string().trim().min(1).array().min(1),
}).strict()

export const BatchDeleteDocumentsResponseSchema = z.object({
  deletedDocumentIds: z.string().array(),
}).strict()

export const CreateDocumentVersionSnapshotSchema = z.object({
  basedOnProjectionRevision: DocumentRevisionSchema,
  source: DocumentVersionSnapshotSourceSchema.default(DOCUMENT_VERSION_SNAPSHOT_SOURCE.USER),
  idempotencyKey: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).max(120).optional(),
}).strict()

export const CreateDocumentVersionSnapshotResponseSchema = z.object({
  snapshot: DocumentVersionSnapshotSchema,
  latestVersionSnapshotId: z.string(),
}).strict()

export const ResolveDocumentAssetsSchema = z.object({
  assetIds: z.string().array(),
}).strict()

export const ResolveDocumentAssetsResponseSchema = z.object({
  assets: DocumentAssetSchema.array(),
  unresolvedAssetIds: z.string().array(),
}).strict()

export const RestoreDocumentVersionSnapshotSchema = z.object({
  baseProjectionRevision: DocumentRevisionSchema,
  versionSnapshotId: z.string().trim().min(1),
}).strict()

export const RestoreDocumentVersionSnapshotResponseSchema = z.object({
  current: DocumentCurrentSchema,
  snapshot: DocumentVersionSnapshotSchema,
}).strict()

export const CreateDocumentDuplicateOperationResponseSchema = z.object({
  job: DocumentOperationJobSchema,
}).strict()

export const MoveDocumentTreeOperationSchema = z.object({
  targetWorkspaceId: z.string().trim().min(1),
  targetParentId: z.string().trim().nullable(),
  targetCollectionId: DocumentOwnedCollectionIdSchema,
}).strict()

export const CreateDocumentMoveOperationResponseSchema = z.object({
  job: DocumentOperationJobSchema,
}).strict()

export const PatchDocumentMetaSchema = z.object({
  parentId: z.string().trim().nullable().optional(),
  visibility: DocumentVisibilitySchema.optional(),
}).strict().refine(
  input => input.parentId !== undefined || input.visibility !== undefined,
  {
    message: '至少更新一个元数据字段',
  },
)

export const SaveDocumentContentSchema = z.object({
  baseProjectionRevision: DocumentRevisionSchema,
  idempotencyKey: z.string().uuid(),
  schemaVersion: TiptapSchemaVersionSchema,
  title: DocumentTitleContentSchema,
  body: TiptapJsonContentPayloadSchema,
}).strict()

export const SaveDocumentContentResponseSchema = DocumentCurrentSchema

export const PatchDocumentLayoutSchema = z.object({
  pageWidthMode: DocumentPageWidthModeSchema,
}).strict()

export const SearchReadableDocumentsQuerySchema = z.object({
  workspaceId: z.string().trim().min(1),
  query: z.string().trim().max(DOCUMENT_CHAT_SEARCH_QUERY_MAX_LENGTH).default(''),
  limit: z.coerce.number().int().min(1).max(DOCUMENT_CHAT_SEARCH_LIMIT).default(DOCUMENT_CHAT_SEARCH_LIMIT),
}).strict()

export const ReadableDocumentSearchResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  workspaceId: z.string(),
  workspaceType: WorkspaceTypeSchema,
}).strict()

export const SearchReadableDocumentsResponseSchema = z.object({
  documents: z.array(ReadableDocumentSearchResultSchema),
}).strict()

export type DocumentStatus = z.infer<typeof DocumentStatusSchema>
export type DocumentVisibility = z.infer<typeof DocumentVisibilitySchema>
export type DocumentPageWidthMode = z.infer<typeof DocumentPageWidthModeSchema>
export type DocumentAssetKind = z.infer<typeof DocumentAssetKindSchema>
export type DocumentAssetStatus = z.infer<typeof DocumentAssetStatusSchema>
export type DocumentCollectionId = z.infer<typeof DocumentCollectionIdSchema>
export type DocumentTreeCollectionId = z.infer<typeof DocumentTreeCollectionIdSchema>
export type OwnedDocumentCollectionId = z.infer<typeof DocumentOwnedCollectionIdSchema>
export type DocumentOperationJobType = z.infer<typeof DocumentOperationJobTypeSchema>
export type DocumentOperationJobStatus = z.infer<typeof DocumentOperationJobStatusSchema>
export type DocumentPaneState = (typeof DOCUMENT_PANE_STATE)[keyof typeof DOCUMENT_PANE_STATE]
export type DocumentSaveState = (typeof DOCUMENT_SAVE_STATE)[keyof typeof DOCUMENT_SAVE_STATE]
export type DocumentBase = z.infer<typeof DocumentBaseSchema>
export type DocumentTrashItem = z.infer<typeof DocumentTrashItemSchema>
export type DocumentItem = z.infer<typeof DocumentItemSchema>
export type DocumentTreeGroup = z.infer<typeof DocumentTreeGroupSchema>
export type DocumentRevision = z.infer<typeof DocumentRevisionSchema>
export type DocumentVersionSnapshotSource = z.infer<typeof DocumentVersionSnapshotSourceSchema>
export type DocumentRecord = z.infer<typeof DocumentRecordSchema>
export type DocumentCurrentProjection = z.infer<typeof DocumentCurrentProjectionSchema>
export type DocumentVersionSnapshot = z.infer<typeof DocumentVersionSnapshotSchema>
export type DocumentCurrent = z.infer<typeof DocumentCurrentSchema>
export type DocumentHistoryCurrent = z.infer<typeof DocumentHistoryCurrentSchema>
export type DocumentHistory = z.infer<typeof DocumentHistorySchema>
export type DocumentOperationJob = z.infer<typeof DocumentOperationJobSchema>
export type DocumentAsset = z.infer<typeof DocumentAssetSchema>
export type DocumentBlockHeadingLevel = 1 | 2 | 3 | 4 | 5

/**
 * 文档块索引条目。
 */
export interface DocumentBlockIndexEntry {
  /** 块 ID */
  blockId: string
  /** 父块 ID */
  parentBlockId: string | null
  /** 嵌套深度 */
  depth: number
  /** 节点类型 */
  nodeType: string
  /** 纯文本投影 */
  plainText: string
  /** 标题层级 */
  headingLevel: DocumentBlockHeadingLevel | null
}

/**
 * 文档大纲条目。
 */
export interface DocumentOutlineItem {
  /** 块 ID */
  blockId: string
  /** 标题文本 */
  plainText: string
  /** 标题层级 */
  headingLevel: DocumentBlockHeadingLevel
}

export type CreateDocumentRequest = z.infer<typeof CreateDocumentSchema>
export type CreateDocumentResponse = z.infer<typeof CreateDocumentResponseSchema>
export type BatchDeleteDocumentsRequest = z.infer<typeof BatchDeleteDocumentsRequestSchema>
export type BatchDeleteDocumentsResponse = z.infer<typeof BatchDeleteDocumentsResponseSchema>
export type CreateDocumentVersionSnapshotRequest = z.infer<typeof CreateDocumentVersionSnapshotSchema>
export type CreateDocumentVersionSnapshotResponse = z.infer<typeof CreateDocumentVersionSnapshotResponseSchema>
export type RestoreDocumentVersionSnapshotRequest = z.infer<typeof RestoreDocumentVersionSnapshotSchema>
export type RestoreDocumentVersionSnapshotResponse = z.infer<typeof RestoreDocumentVersionSnapshotResponseSchema>
export type CreateDocumentDuplicateOperationResponse = z.infer<typeof CreateDocumentDuplicateOperationResponseSchema>
export type MoveDocumentTreeOperationRequest = z.infer<typeof MoveDocumentTreeOperationSchema>
export type CreateDocumentMoveOperationResponse = z.infer<typeof CreateDocumentMoveOperationResponseSchema>
export type PatchDocumentMetaRequest = z.infer<typeof PatchDocumentMetaSchema>
export type SaveDocumentContentRequest = z.infer<typeof SaveDocumentContentSchema>
export type SaveDocumentContentResponse = z.infer<typeof SaveDocumentContentResponseSchema>
export type PatchDocumentLayoutRequest = z.infer<typeof PatchDocumentLayoutSchema>
export type SearchReadableDocumentsQuery = z.infer<typeof SearchReadableDocumentsQuerySchema>
export type ReadableDocumentSearchResult = z.infer<typeof ReadableDocumentSearchResultSchema>
export type SearchReadableDocumentsResponse = z.infer<typeof SearchReadableDocumentsResponseSchema>
export type ResolveDocumentAssetsRequest = z.infer<typeof ResolveDocumentAssetsSchema>
export type ResolveDocumentAssetsResponse = z.infer<typeof ResolveDocumentAssetsResponseSchema>
