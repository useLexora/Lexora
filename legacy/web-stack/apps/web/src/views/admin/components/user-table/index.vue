<script setup lang="ts">
import type { CSSProperties } from 'vue'
import type { UserTableFilterMap } from './typing'
import type {
  SystemAdminUserItem,
  SystemAdminUserRoleFilter,
  SystemAdminUserStatus,
} from '@/apis/system-admin'
import { AUTH_METHOD } from '@haohaoxue/lexora-contracts/auth/constants'
import {
  SYSTEM_ADMIN_USER_ROLE_FILTER,
} from '@haohaoxue/lexora-contracts/system-admin'
import { USER_STATUS } from '@haohaoxue/lexora-contracts/user/constants'
import { formatAuthMethod } from '@haohaoxue/lexora-shared/auth'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Empty from '@/components/empty'
import { LoadingTableSkeleton } from '@/components/loading'
import { formatDateTime } from '@/utils/dayjs'
import { useAdminUsers } from '../../composables/useAdminUsers'
import UserDataExpansion from '../user-data-expansion'
import UserIdentityCell from '../user-identity-cell'

const {
  getUserDetail,
  getUserDetailErrorMessage,
  isLoadingUsers,
  isLoadingUserDetail,
  keywordInput,
  loadUserDetail,
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
} = useAdminUsers()
const { t } = useI18n({ useScope: 'global' })

const statusColumnFilters = computed<Array<{ text: string, value: SystemAdminUserStatus }>>(() => [
  {
    text: t('admin.users.active'),
    value: USER_STATUS.ACTIVE,
  },
  {
    text: t('admin.users.disabled'),
    value: USER_STATUS.DISABLED,
  },
])

const roleColumnFilters = computed<Array<{ text: string, value: SystemAdminUserRoleFilter }>>(() => [
  {
    text: t('admin.users.systemAdmin'),
    value: SYSTEM_ADMIN_USER_ROLE_FILTER.SYSTEM_ADMIN,
  },
  {
    text: t('admin.users.regularUser'),
    value: SYSTEM_ADMIN_USER_ROLE_FILTER.REGULAR_USER,
  },
])

const filteredStatusValues = computed(() => userQuery.status ? [userQuery.status] : [])
const filteredRoleValues = computed(() => userQuery.role ? [userQuery.role] : [])
const tableHeaderCellStyle: CSSProperties = {
  fontWeight: 600,
  fontSize: '12px',
  textTransform: 'uppercase',
}

function formatDate(value: string | null) {
  if (!value) {
    return t('admin.users.notAvailable')
  }

  return formatDateTime(value)
}

function getStatusStateClass(status: SystemAdminUserStatus) {
  return status === USER_STATUS.ACTIVE ? 'active' : 'disabled'
}

function getAdminRoleText(isSystemAdmin: boolean) {
  return isSystemAdmin ? t('admin.users.systemAdmin') : ''
}

function formatAuthMethodLabel(method: Parameters<typeof formatAuthMethod>[0]) {
  return method === AUTH_METHOD.PASSWORD ? t('admin.users.passwordAuth') : formatAuthMethod(method)
}

function resolveNextStatus(status: SystemAdminUserStatus): SystemAdminUserStatus {
  return status === USER_STATUS.ACTIVE
    ? USER_STATUS.DISABLED
    : USER_STATUS.ACTIVE
}

function handleFilterChange(filters: UserTableFilterMap) {
  const nextStatus = typeof filters.status?.[0] === 'string'
    ? filters.status[0] as SystemAdminUserStatus
    : null
  const nextRole = typeof filters.role?.[0] === 'string'
    ? filters.role[0] as SystemAdminUserRoleFilter
    : null

  updateFilters({
    status: nextStatus,
    role: nextRole,
  })
}

function handleToggleStatus(user: SystemAdminUserItem) {
  void toggleUserStatus(user, resolveNextStatus(user.status))
}

function handleExpandChange(user: SystemAdminUserItem, expandedUsers: SystemAdminUserItem[]) {
  if (expandedUsers.some(item => item.id === user.id)) {
    void loadUserDetail(user.id)
  }
}
</script>

<template>
  <div class="user-table__surface overflow-hidden border border-border-a80 bg-surface">
    <div class="user-table__toolbar flex items-center justify-between gap-3 border-b border-border-a80 px-5 py-4 max-[960px]:flex-wrap max-[960px]:items-stretch">
      <ElInput
        :model-value="keywordInput"
        clearable
        :placeholder="t('admin.users.search')"
        class="min-w-0 max-w-96"
        @update:model-value="updateKeyword"
        @keyup.enter="submitSearch"
      />

      <ElButton type="primary" :loading="isLoadingUsers" @click="submitSearch">
        {{ t('admin.users.searchSubmit') }}
      </ElButton>
    </div>

    <ElTable
      :data="users"
      row-key="id" stripe border
      class="admin-table user-table"
      :header-cell-style="tableHeaderCellStyle"
      @expand-change="handleExpandChange"
      @filter-change="handleFilterChange"
    >
      <template #empty>
        <LoadingTableSkeleton v-if="isLoadingUsers" compact />
        <Empty v-else compact />
      </template>

      <ElTableColumn type="expand" width="52" fixed>
        <template #default="{ row }">
          <UserDataExpansion
            :detail="getUserDetail(row.id)"
            :loading="isLoadingUserDetail(row.id)"
            :error-message="getUserDetailErrorMessage(row.id)"
          />
        </template>
      </ElTableColumn>

      <ElTableColumn :label="t('admin.users.userInfo')" min-width="180" fixed>
        <template #default="{ row }">
          <UserIdentityCell :user="row" />
        </template>
      </ElTableColumn>

      <ElTableColumn
        :label="t('admin.users.status')"
        width="120" fixed
        column-key="status"
        :filters="statusColumnFilters"
        :filter-multiple="false"
        :filtered-value="filteredStatusValues"
      >
        <template #default="{ row }">
          <div class="user-table__status flex items-center gap-1.5">
            <div class="user-table__status-dot h-1.5 w-1.5 rounded-full" :class="getStatusStateClass(row.status)" />
            <span class="user-table__status-label text-xs font-medium" :class="getStatusStateClass(row.status)">
              {{ row.status === USER_STATUS.ACTIVE ? t('admin.users.active') : t('admin.users.disabled') }}
            </span>
          </div>
        </template>
      </ElTableColumn>

      <ElTableColumn :label="t('admin.users.email')" min-width="220">
        <template #default="{ row }">
          <span v-if="row.email" class="text-xs text-secondary">
            {{ row.email }}
          </span>
          <span v-else class="text-xs text-placeholder">
            {{ t('admin.users.notBound') }}
          </span>
        </template>
      </ElTableColumn>

      <ElTableColumn :label="t('admin.users.accountCode')" width="150">
        <template #default="{ row }">
          <span class="font-mono text-xs font-medium text-secondary">
            {{ row.userCode }}
          </span>
        </template>
      </ElTableColumn>

      <ElTableColumn :label="t('admin.users.createdAt')" width="180">
        <template #default="{ row }">
          <span class="text-xs text-secondary">{{ formatDate(row.createdAt) }}</span>
        </template>
      </ElTableColumn>

      <ElTableColumn :label="t('admin.users.updatedAt')" width="180">
        <template #default="{ row }">
          <span class="text-xs text-secondary">{{ formatDate(row.updatedAt) }}</span>
        </template>
      </ElTableColumn>

      <ElTableColumn
        :label="t('admin.users.role')"
        width="180"
        column-key="role"
        :filters="roleColumnFilters"
        :filter-multiple="false"
        :filtered-value="filteredRoleValues"
      >
        <template #default="{ row }">
          <span class="user-table__admin-role text-[13px] font-semibold text-main">
            {{ getAdminRoleText(row.isSystemAdmin) }}
          </span>
        </template>
      </ElTableColumn>

      <ElTableColumn :label="t('admin.users.authMethods')" min-width="120">
        <template #default="{ row }">
          <div class="user-table__auth-methods flex flex-wrap gap-1.5">
            <ElTag
              v-for="method in row.authMethods"
              :key="method"
              size="small"
              effect="plain"
              class="rounded-md"
            >
              {{ formatAuthMethodLabel(method) }}
            </ElTag>
          </div>
        </template>
      </ElTableColumn>

      <ElTableColumn :label="t('admin.common.operation')" width="140" fixed="right">
        <template #default="{ row }">
          <div class="user-table__actions flex min-h-6 items-center gap-2">
            <ElButton
              v-if="!row.isSystemAdmin"
              link
              :type="row.status === USER_STATUS.ACTIVE ? 'danger' : 'success'"
              :disabled="updatingUserId === row.id"
              @click="handleToggleStatus(row)"
            >
              {{ row.status === USER_STATUS.ACTIVE ? t('admin.users.disable') : t('admin.users.activate') }}
            </ElButton>
          </div>
        </template>
      </ElTableColumn>
    </ElTable>

    <div class="user-table__pagination flex justify-end border-t border-border-a80 bg-fill-lighter/55 px-5 py-4 max-[960px]:justify-start max-[960px]:overflow-x-auto">
      <ElPagination
        :current-page="userQuery.pageNo"
        :page-size="userQuery.pageSize ?? 20"
        :page-sizes="[10, 20, 50, 100]"
        :total="totalUsers"
        background
        layout="total, sizes, prev, pager, next"
        @current-change="updatePageNo"
        @size-change="updatePageSize"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
.admin-table {
  --el-table-header-bg-color: var(--brand-fill-lighter);
  --el-table-header-text-color: var(--brand-text-regular);
  --el-table-row-hover-bg-color: var(--brand-fill-lighter);
}

.user-table {
  &__status-dot {
    &.active {
      background: var(--brand-success);
    }

    &.disabled {
      background: var(--brand-error);
    }
  }

  &__status-label {
    &.active {
      color: var(--brand-success);
    }

    &.disabled {
      color: var(--brand-error);
    }
  }
}
</style>
