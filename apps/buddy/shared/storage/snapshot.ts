import type { BackupScope } from './backupScope'
import { z } from 'zod'
import { backupDirectoryAllowed, backupPathAllowed, backupSelectionSchema } from './backupScope'

export const SNAPSHOT_CHUNK_BYTES = 4 * 1024 * 1024
export const SNAPSHOT_MANIFEST_BYTES = 64 * 1024 * 1024
export const snapshotPathSchema = z.string().min(1).max(4096).refine(path => !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..' && !Array.from(part).some(character => character.charCodeAt(0) < 32) && !/[:<>"|?*]/.test(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
export const snapshotChunkSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(SNAPSHOT_CHUNK_BYTES) }).strict()
export const snapshotFileSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: snapshotPathSchema, size: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/), chunks: z.array(snapshotChunkSchema), executable: z.boolean() }).strict(),
  z.object({ kind: z.literal('directory'), path: snapshotPathSchema }).strict(),
])
export const snapshotManifestSchema = z.object({
  version: z.literal(3),
  automatic: z.uuid().optional(),
  scopes: backupSelectionSchema,
  credentials: z.boolean(),
  id: z.uuid(),
  dataId: z.uuid(),
  createdAt: z.iso.datetime(),
  sourceRoot: z.string().min(1).max(32768),
  databaseVersion: z.number().int().positive(),
  files: z.array(snapshotFileSchema).max(100000),
  excludedLinks: z.number().int().nonnegative(),
}).strict().superRefine((manifest, context) => {
  const paths = new Map<string, string>()
  for (const entry of manifest.files) {
    const normalized = entry.path.normalize('NFC').toLowerCase()
    if (paths.has(normalized) || !(entry.kind === 'directory' ? backupDirectoryAllowed(entry.path, manifest.scopes) : backupPathAllowed(entry.path, manifest.scopes)))
      context.addIssue({ code: 'custom', message: 'Invalid snapshot path' })
    if (['buddy', 'buddy/agent', 'buddy/conversations', 'buddy/drafts', 'buddy/spaces', 'buddy/skills', 'buddy/agent/skills'].includes(entry.path) && entry.kind !== 'directory')
      context.addIssue({ code: 'custom', message: 'Invalid snapshot directory' })
    if (['config.toml', 'device/sync.json', 'credentials.enc'].includes(entry.path) && entry.kind !== 'file')
      context.addIssue({ code: 'custom', message: 'Invalid snapshot file' })
    paths.set(normalized, entry.kind)
    if (entry.kind === 'file' && entry.chunks.reduce((total, chunk) => total + chunk.size, 0) !== entry.size)
      context.addIssue({ code: 'custom', message: 'Invalid snapshot length' })
  }
  for (const path of paths.keys()) {
    let parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    while (parent) {
      if (paths.get(parent) !== 'directory')
        context.addIssue({ code: 'custom', message: 'Missing snapshot directory' })
      parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : ''
    }
  }
  if (manifest.credentials !== paths.has('credentials.enc'))
    context.addIssue({ code: 'custom', message: 'Invalid credential payload' })
  if (paths.get('buddy/buddy.sqlite3') !== 'file')
    context.addIssue({ code: 'custom', message: 'Missing snapshot database' })
})
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>
export interface SnapshotSummary {
  automatic?: string
  scopes: BackupScope[]
  credentials: boolean
  id: string
  createdAt: string
  files: number
  bytes: number
  excludedLinks: number
}
export interface SnapshotCatalog {
  snapshots: SnapshotSummary[]
  unreadableIds: string[]
  cleanupError?: boolean
}
export function snapshotSummary(manifest: SnapshotManifest): SnapshotSummary {
  return { ...(manifest.automatic ? { automatic: manifest.automatic } : {}), scopes: manifest.scopes, credentials: manifest.credentials, id: manifest.id, createdAt: manifest.createdAt, files: manifest.files.filter(entry => entry.kind === 'file').length, bytes: manifest.files.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0), excludedLinks: manifest.excludedLinks }
}
