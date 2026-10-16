import type { SvgIconCategory } from '@/components/svg-icon/typing'
import type { TurnIntoBlockType } from '@/components/tiptap-editor'
import 'axios'
import '@tiptap/core'
import 'vue-router'

declare module 'axios' {
  interface AxiosRequestConfig {
    withCookieAuth?: boolean
  }

  interface InternalAxiosRequestConfig {
    withCookieAuth?: boolean
    _retry?: boolean
  }
}

declare module 'vue-router' {
  interface RouteMeta {
    /** 公开路由，无需登录即可访问 */
    public?: boolean
    /** 密码强制修改期间仍允许访问 */
    allowWhenPasswordChangeRequired?: boolean
    /** 需要系统管理员权限 */
    requiresSystemAdmin?: boolean
    /** 侧栏导航标题 i18n key */
    navLabelKey?: string
    /** 侧栏导航图标分类 */
    navIconCategory?: SvgIconCategory
    /** 侧栏导航图标 */
    navIcon?: string
    /** 侧栏导航激活图标 */
    navActiveIcon?: string
  }
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    lexoraBlockCommands: {
      turnIntoBlock: (target: TurnIntoBlockType) => ReturnType
      indentBlock: () => ReturnType
      outdentBlock: () => ReturnType
      moveBlockUp: () => ReturnType
      moveBlockDown: () => ReturnType
      moveCurrentBlockTo: (targetBlockId: string, placement: 'before' | 'after') => ReturnType
      insertBlock: () => ReturnType
      deleteBlock: () => ReturnType
      duplicateBlock: () => ReturnType
      splitCurrentBlock: () => ReturnType
      mergeBlockBackward: () => ReturnType
      deleteForward: () => ReturnType
    }
  }
}
