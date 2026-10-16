import type {
  GetSystemAdminAuditLogsQuery,
  SystemAdminAuditLogItem,
  SystemAdminAuditTargetType,
} from '@/apis/system-admin'
import { onMounted, reactive, shallowRef } from 'vue'
import { getSystemAdminAuditLogs } from '@/apis/system-admin'

export function useAdminAudit() {
  const logs = shallowRef<SystemAdminAuditLogItem[]>([])
  const total = shallowRef(0)
  const isLoading = shallowRef(false)
  const query = reactive<GetSystemAdminAuditLogsQuery>({
    pageNo: 1,
    pageSize: 20,
    targetType: undefined,
  })

  async function loadLogs() {
    isLoading.value = true

    try {
      const response = await getSystemAdminAuditLogs(query)
      logs.value = response.items
      total.value = response.total
    }
    finally {
      isLoading.value = false
    }
  }

  onMounted(loadLogs)

  function updateFilters(filters: {
    targetType: SystemAdminAuditTargetType | null
  }) {
    query.targetType = filters.targetType ?? undefined
    query.pageNo = 1
    void loadLogs()
  }

  function updatePageNo(pageNo: number) {
    query.pageNo = pageNo
    void loadLogs()
  }

  function updatePageSize(pageSize: number) {
    query.pageSize = pageSize
    query.pageNo = 1
    void loadLogs()
  }

  return {
    logs,
    total,
    isLoading,
    loadLogs,
    query,
    updateFilters,
    updatePageNo,
    updatePageSize,
  }
}
