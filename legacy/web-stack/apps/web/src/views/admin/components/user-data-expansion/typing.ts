import type { SystemAdminUserDetail } from '@/apis/system-admin'

export interface UserDataExpansionProps {
  detail: SystemAdminUserDetail | null
  loading: boolean
  errorMessage: string
}
