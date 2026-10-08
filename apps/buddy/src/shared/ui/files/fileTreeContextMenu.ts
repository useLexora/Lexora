export interface FileTreeMenuTarget {
  event: MouseEvent | KeyboardEvent
  path: string
  name: string
  kind: 'file' | 'directory'
  writable: boolean
  unavailable: boolean
}
