export interface FileLinkMenuAction {
  key: string
  label: string
  disabled?: boolean
  children?: readonly FileLinkMenuAction[]
  run?: () => void | Promise<void>
}

export type FileLinkMenuProvider = (href: string) => Promise<readonly FileLinkMenuAction[]>
