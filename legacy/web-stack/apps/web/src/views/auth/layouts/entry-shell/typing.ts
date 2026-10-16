import type { VNode } from 'vue'

export interface AuthEntryShellProps {
  title: string
  description?: string
}

export interface AuthEntryShellSlots {
  default: () => VNode[]
  actions?: () => VNode[]
  footer?: () => VNode[]
}
