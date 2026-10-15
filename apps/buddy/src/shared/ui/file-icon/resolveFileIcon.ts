import { resolveResourceIcon } from './fileIcon'

export function resolveFileIcon(path: string): string {
  return resolveResourceIcon({ path, kind: 'file' }).id
}
