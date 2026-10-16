import type { AuthProviderName } from '@haohaoxue/lexora-contracts'
import { AUTH_PROVIDER } from '@haohaoxue/lexora-contracts/auth/constants'
import { SvgIconCategory } from '@/components/svg-icon/typing'

/**
 * 认证平台展示信息。
 */
export interface AuthProviderUiMeta {
  title: string
  icon: string
  iconCategory: SvgIconCategory.BRAND
}

export const AUTH_PROVIDER_UI_META: Record<AuthProviderName, AuthProviderUiMeta> = {
  [AUTH_PROVIDER.GOOGLE]: {
    title: 'Google',
    icon: 'brand-google',
    iconCategory: SvgIconCategory.BRAND,
  },
  [AUTH_PROVIDER.GITHUB]: {
    title: 'GitHub',
    icon: 'brand-github',
    iconCategory: SvgIconCategory.BRAND,
  },
  [AUTH_PROVIDER.LINUX_DO]: {
    title: 'LinuxDo',
    icon: 'brand-linux-do',
    iconCategory: SvgIconCategory.BRAND,
  },
}
