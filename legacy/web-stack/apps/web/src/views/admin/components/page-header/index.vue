<script setup lang="ts">
import type { AdminPageHeaderProps } from './typing'
import { useI18n } from 'vue-i18n'
import { ADMIN_ROUTE_NAME } from '@/router/constants'

defineProps<AdminPageHeaderProps>()
const { t } = useI18n({ useScope: 'global' })
</script>

<template>
  <ElBreadcrumb separator="/" class="admin-page-header min-w-0">
    <ElBreadcrumbItem :to="{ name: ADMIN_ROUTE_NAME }">
      {{ t('admin.common.systemAdmin') }}
    </ElBreadcrumbItem>
    <ElBreadcrumbItem>
      {{ title }}
    </ElBreadcrumbItem>
  </ElBreadcrumb>
</template>

<style scoped lang="scss">
.admin-page-header {
  :deep(.el-breadcrumb__inner) {
    color: var(--brand-text-secondary);
    font-weight: 500;
  }

  :deep(.el-breadcrumb__inner a) {
    color: var(--brand-text-secondary);
    font-weight: 500;
    transition: color 0.2s ease;

    &:hover {
      color: var(--brand-text-primary);
    }
  }

  :deep(.el-breadcrumb__item:last-child .el-breadcrumb__inner) {
    color: var(--brand-text-primary);
    font-weight: 600;
  }
}
</style>
