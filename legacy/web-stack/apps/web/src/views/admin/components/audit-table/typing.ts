import type {
  SystemAdminAuditLogItem,
  SystemAdminAuditTargetType,
} from '@/apis/system-admin'

export type { SystemAdminAuditTargetType }

export interface AdminAuditTableProps {
  logs: SystemAdminAuditLogItem[]
  total: number
  pageNo: number
  pageSize: number
  loading: boolean
  targetType: SystemAdminAuditTargetType | null
}

export interface AdminAuditTableEmits {
  updateFilters: [filters: {
    targetType: SystemAdminAuditTargetType | null
  }]
  updatePageNo: [pageNo: number]
  updatePageSize: [pageSize: number]
}

export type AdminAuditTableFilterMap = Partial<Record<'targetType', Array<string | number | boolean>>>
