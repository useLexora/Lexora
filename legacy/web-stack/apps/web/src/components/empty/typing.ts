import type { HTMLAttributes } from 'vue'
import type { SvgIconCategoryValue } from '../svg-icon/typing'

export interface EmptyProps {
  title?: string
  description?: string
  icon?: string
  iconCategory?: SvgIconCategoryValue
  iconClass?: HTMLAttributes['class']
  imageSize?: number
  compact?: boolean
}
