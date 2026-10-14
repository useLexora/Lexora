import type { StorageHistory } from '../../shared/storage/storageApi'
import { dirname, join } from 'node:path'
import { filePaths } from '../filesystem/filePaths'

export interface StorageProtection {
  sensitiveRoots: string[]
  sandboxRoots: string[]
}

export function profileStorageProtection(input: {
  activeRoot: string
  defaultRoot: string
  bootstrapRoot: string
  leaseDirectory: string
  history: StorageHistory[]
  legacyRoots: string[]
}): StorageProtection {
  const active = filePaths.sensitiveKey(input.activeRoot)
  const retained = [...new Set([input.defaultRoot, ...input.history.flatMap(item => [item.source, item.target, ...(item.retainedTarget ? [item.retainedTarget] : [])])])]
    .filter(root => filePaths.sensitiveKey(root) !== active)
  const protectedRoots = [...new Set([dirname(input.bootstrapRoot), input.leaseDirectory, ...input.legacyRoots, ...retained.flatMap(retainedProtection)])]
  return {
    sensitiveRoots: [...protectedRoots, ...['buddy/secrets', 'device', 'storage.json'].map(path => join(input.activeRoot, path))],
    sandboxRoots: [...protectedRoots, input.activeRoot],
  }
}

function retainedProtection(root: string): string[] {
  return ['buddy/secrets', 'device', '.runtime', 'storage.json', '.storage-retired.json'].map(path => join(root, path))
}
