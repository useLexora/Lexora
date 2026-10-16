import type { HTMLAttributes } from 'vue'
import type { SvgIconCategoryValue } from '../svg-icon/typing'

export interface LoadingProps {
  title?: string
  description?: string
  icon?: string
  iconCategory?: SvgIconCategoryValue
  iconClass?: HTMLAttributes['class']
  compact?: boolean
}
