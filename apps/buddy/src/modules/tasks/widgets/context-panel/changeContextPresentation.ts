import type { LocalFileChangeDetail } from '@buddy-shared/changes/changeApi'

import type { ExplorerNode } from '@/shared/ui/explorer/treeCollection'
import type { FileIconName } from '@/shared/ui/file-icon'
import { diffLines } from 'diff'
import { resolveFileIcon } from '@/shared/ui/file-icon'

export type FileChangeType = LocalFileChangeDetail['changeType']

export interface LineChangeCounts {
  added: number
  deleted: number
}

export interface ChangeFilePresentation extends LocalFileChangeDetail {
  lineCounts: LineChangeCounts | null
  sourceOrder: number | null
}

export function presentChangeFiles(files: readonly LocalFileChangeDetail[], previous: readonly ChangeFilePresentation[]): ChangeFilePresentation[] {
  const previousFiles = new Map(previous.map(file => [file.id, file]))
  const sources = [...new Set(files.flatMap(file => file.source ? [`${file.source.runId}:${file.source.segmentId}`] : []))]
  const order = new Map(sources.map((source, index) => [source, index + 1]))
  return files.map((file) => {
    const cached = previousFiles.get(file.id)
    const lineCounts = file.preview !== 'text'
      ? null
      : cached?.preview === 'text' && cached.beforeText === file.beforeText && cached.afterText === file.afterText
        ? cached.lineCounts
        : countChangedLines(file.beforeText ?? '', file.afterText ?? '')
    const sourceOrder = sources.length > 1 && file.source ? order.get(`${file.source.runId}:${file.source.segmentId}`) ?? null : null
    return { ...file, lineCounts, sourceOrder }
  })
}

export interface ChangeFileTreeNode extends ExplorerNode {
  changeType?: FileChangeType
  fileId?: string
  fileIcon?: FileIconName
  kind: 'directory' | 'file'
  lineCounts?: LineChangeCounts
}

interface DirectoryNode {
  directories: Map<string, DirectoryNode>
  files: ChangeFilePresentation[]
  name: string
  path: string
}

export function countChangedLines(before: string, after: string): LineChangeCounts {
  let added = 0
  let deleted = 0
  for (const change of diffLines(before, after)) {
    if (change.added)
      added += change.count ?? 0
    else if (change.removed)
      deleted += change.count ?? 0
  }
  return { added, deleted }
}

export function fileNameFromPath(path: string): string {
  return path.split('/').at(-1) ?? path
}

export const fileIconNameFromPath = resolveFileIcon

export function buildChangeFileTree(
  files: ReadonlyArray<ChangeFilePresentation>,
): ChangeFileTreeNode[] {
  const root: DirectoryNode = {
    directories: new Map(),
    files: [],
    name: '',
    path: '',
  }
  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean)
    const fileName = segments.pop()
    if (!fileName)
      continue
    let directory = root
    for (const segment of segments) {
      const directoryPath = directory.path ? `${directory.path}/${segment}` : segment
      const child = directory.directories.get(segment) ?? {
        directories: new Map(),
        files: [],
        name: segment,
        path: directoryPath,
      }
      directory.directories.set(segment, child)
      directory = child
    }
    directory.files.push(file)
  }
  return buildDirectoryChildren(root)
}

function buildDirectoryChildren(directory: DirectoryNode): ChangeFileTreeNode[] {
  const directories = [...directory.directories.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(child => ({
      children: buildDirectoryChildren(child),
      key: `directory:${child.path}`,
      kind: 'directory' as const,
      label: child.name,
    }))
  const files = [...directory.files]
    .sort((left, right) => fileNameFromPath(left.path).localeCompare(fileNameFromPath(right.path)))
    .map(file => ({
      changeType: file.changeType,
      fileId: file.id,
      fileIcon: fileIconNameFromPath(file.path),
      key: file.id,
      kind: 'file' as const,
      label: file.sourceOrder ? `${fileNameFromPath(file.path)} · ${file.source?.actorName ?? ''} #${file.sourceOrder}` : fileNameFromPath(file.path),
      lineCounts: file.lineCounts ?? undefined,
    }))
  return [...directories, ...files]
}
