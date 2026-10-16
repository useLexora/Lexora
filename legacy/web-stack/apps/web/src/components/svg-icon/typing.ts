export enum SvgIconCategory {
  AI = 'ai',
  BRAND = 'brand',
  NAV = 'nav',
  TIPTAP = 'tiptap',
  UI = 'ui',
}

export type SvgIconCategoryValue = `${SvgIconCategory}`

export interface SvgIconProps {
  /**
   * 分类
   * @description 对应 public 下的 icon-<category>.svg
   * @default 'ui'
   */
  category?: SvgIconCategory | SvgIconCategoryValue
  /**
   * 图标
   * @description sprite 内的 symbol 名称
   */
  icon: string
  /**
   * 颜色
   * @default 'currentColor'
   */
  color?: string
  /**
   * 尺寸
   * @description 当为数组时 [宽, 高]
   * @default '1em'
   */
  size?: string | string[]
}
