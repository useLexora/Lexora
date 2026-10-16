import type {
  GetSystemAdminUsersQuery,
  SystemAdminUserDetail,
  SystemAdminUserItem,
  SystemAdminUserRoleFilter,
  SystemAdminUserStatus,
} from '@/apis/system-admin'
import { USER_STATUS } from '@haohaoxue/lexora-contracts/user/constants'
import { createSharedComposable } from '@vueuse/core'
import { reactive, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  getSystemAdminUserDetail,
  getSystemAdminUsers,
  updateSystemAdminUserStatus,
} from '@/apis/system-admin'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

export const useAdminUsers = createSharedComposable(() => {
  const { t } = useI18n({ useScope: 'global' })
  let userListRequestId = 0
  const userDetailRequestIds = new Map<string, number>()

  const users = shallowRef<SystemAdminUserItem[]>([])
  const userDetails = shallowRef<Record<string, SystemAdminUserDetail>>({})
  const loadingUserDetailIds = shallowRef<string[]>([])
  const userDetailErrorMessages = shallowRef<Record<string, string>>({})
  const errorMessage = shallowRef('')
  const isLoadingUsers = shallowRef(false)
  const keywordInput = shallowRef('')
  const updatingUserId = shallowRef<string | null>(null)
  const totalUsers = shallowRef(0)
  const userQuery = reactive<GetSystemAdminUsersQuery>({
    pageNo: 1,
    pageSize: 20,
    keyword: undefined,
    status: undefined,
    role: undefined,
  })

  async function loadUsers() {
    const requestId = ++userListRequestId
    isLoadingUsers.value = true

    try {
      const response = await getSystemAdminUsers(userQuery)

      if (requestId !== userListRequestId) {
        return
      }

      const maxPageNo = response.total > 0
        ? Math.ceil(response.total / userQuery.pageSize)
        : 1

      if (response.items.length === 0 && userQuery.pageNo > maxPageNo) {
        userQuery.pageNo = maxPageNo
        await loadUsers()
        return
      }

      users.value = response.items
      totalUsers.value = response.total
    }
    catch (error) {
      if (requestId === userListRequestId) {
        errorMessage.value = getRequestErrorDisplayMessage(error, t('admin.errors.loadUsers'))
      }
      throw error
    }
    finally {
      if (requestId === userListRequestId) {
        isLoadingUsers.value = false
      }
    }
  }

  async function toggleUserStatus(
    user: SystemAdminUserItem,
    nextStatus: SystemAdminUserStatus,
  ) {
    updatingUserId.value = user.id

    try {
      const updated = await updateSystemAdminUserStatus(user.id, {
        status: nextStatus,
      })
      ElMessage.success(nextStatus === USER_STATUS.ACTIVE ? t('admin.users.restored') : t('admin.users.userDisabled'))
      await loadUsers().catch(() => {
        users.value = users.value.map(item =>
          item.id === user.id
            ? {
                ...item,
                status: updated.status,
              }
            : item,
        )
      })
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('admin.errors.updateUserStatus')))
    }
    finally {
      updatingUserId.value = null
    }
  }

  async function loadUserDetail(userId: string) {
    if (userDetails.value[userId] || loadingUserDetailIds.value.includes(userId)) {
      return
    }

    const requestId = (userDetailRequestIds.get(userId) ?? 0) + 1

    userDetailRequestIds.set(userId, requestId)
    setUserDetailLoading(userId, true)
    setUserDetailErrorMessage(userId, '')

    try {
      const detail = await getSystemAdminUserDetail(userId)

      if (userDetailRequestIds.get(userId) !== requestId) {
        return
      }

      userDetails.value = {
        ...userDetails.value,
        [userId]: detail,
      }
    }
    catch (error) {
      if (userDetailRequestIds.get(userId) === requestId) {
        setUserDetailErrorMessage(userId, getRequestErrorDisplayMessage(error, t('admin.errors.loadUserData')))
      }
    }
    finally {
      if (userDetailRequestIds.get(userId) === requestId) {
        setUserDetailLoading(userId, false)
      }
    }
  }

  function updateFilters(filters: {
    status: SystemAdminUserStatus | null
    role: SystemAdminUserRoleFilter | null
  }) {
    userQuery.status = filters.status ?? undefined
    userQuery.role = filters.role ?? undefined
    userQuery.pageNo = 1
    errorMessage.value = ''
    void loadUsers().catch(() => {})
  }

  function updatePageNo(pageNo: number) {
    userQuery.pageNo = pageNo
    errorMessage.value = ''
    void loadUsers().catch(() => {})
  }

  function updatePageSize(pageSize: number) {
    userQuery.pageSize = pageSize
    userQuery.pageNo = 1
    errorMessage.value = ''
    void loadUsers().catch(() => {})
  }

  function updateKeyword(keyword: string) {
    keywordInput.value = keyword
  }

  function submitSearch() {
    const nextKeyword = keywordInput.value.trim()
    userQuery.keyword = nextKeyword || undefined
    userQuery.pageNo = 1
    errorMessage.value = ''
    void loadUsers().catch(() => {})
  }

  function getUserDetail(userId: string) {
    return userDetails.value[userId] ?? null
  }

  function getUserDetailErrorMessage(userId: string) {
    return userDetailErrorMessages.value[userId] ?? ''
  }

  function isLoadingUserDetail(userId: string) {
    return loadingUserDetailIds.value.includes(userId)
  }

  function setUserDetailLoading(userId: string, isLoading: boolean) {
    loadingUserDetailIds.value = isLoading
      ? Array.from(new Set([...loadingUserDetailIds.value, userId]))
      : loadingUserDetailIds.value.filter(id => id !== userId)
  }

  function setUserDetailErrorMessage(userId: string, message: string) {
    userDetailErrorMessages.value = {
      ...userDetailErrorMessages.value,
      [userId]: message,
    }
  }

  return {
    errorMessage,
    getUserDetail,
    getUserDetailErrorMessage,
    isLoadingUsers,
    isLoadingUserDetail,
    keywordInput,
    loadUserDetail,
    loadUsers,
    submitSearch,
    toggleUserStatus,
    totalUsers,
    updateFilters,
    updateKeyword,
    updatePageNo,
    updatePageSize,
    updatingUserId,
    userQuery,
    users,
  }
})
