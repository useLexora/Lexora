import type { DocumentVersionSnapshot } from '@haohaoxue/lexora-contracts'
import type {
  ActiveDocumentDetail,
} from '../typing'

export function buildHistoryPreviewDocument(options: {
  document: ActiveDocumentDetail | null
  snapshot: DocumentVersionSnapshot | null
}) {
  if (!options.document) {
    return null
  }

  if (!options.snapshot) {
    return options.document
  }

  return {
    ...options.document,
    latestVersionSnapshotId: options.snapshot.id,
    schemaVersion: options.snapshot.schemaVersion,
    updatedAt: options.snapshot.createdAt,
    title: options.snapshot.title,
    body: options.snapshot.body,
  } satisfies ActiveDocumentDetail
}

export function resolveDefaultHistorySnapshotId(options: {
  document: ActiveDocumentDetail | null
  snapshots: DocumentVersionSnapshot[]
  currentSelectedSnapshotId: string | null
}) {
  if (options.snapshots.some(snapshot => snapshot.id === options.currentSelectedSnapshotId)) {
    return options.currentSelectedSnapshotId
  }

  if (!options.document) {
    return null
  }

  const document = options.document
  const currentSnapshot = options.snapshots.find(snapshot =>
    snapshot.id === document.latestVersionSnapshotId
    && snapshot.basedOnProjectionRevision === document.currentProjectionRevision,
  )

  return currentSnapshot?.id ?? null
}
