import type { AiProviderRow, AiProviderStatusType } from '../../typing'

export interface AiProviderSidebarProps {
  rows: AiProviderRow[]
  selectedRowKey: string | null
  getProviderInitial: (row: AiProviderRow) => string
  getProviderStatusType: (row: AiProviderRow) => AiProviderStatusType
}

export interface AiProviderSidebarEmits {
  selectRow: [rowKey: string]
  openCreateProvider: []
  compatibleCommand: [command: string, row: AiProviderRow]
  rowContextMenu: [row: AiProviderRow]
}
