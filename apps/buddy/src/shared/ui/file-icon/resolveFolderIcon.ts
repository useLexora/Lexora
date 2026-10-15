import { resolveResourceIcon } from './fileIcon'

export function resolveFolderIcon(path = '', expanded = false, appearance: 'light' | 'dark' = 'dark'): string {
  return resolveResourceIcon({ path, kind: 'directory', expanded }, appearance).id
}
