<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import PagePanel from '@/layouts/panels/page-panel'
import AuditTable from '../../components/audit-table'
import AdminPageHeader from '../../components/page-header'
import { useAdminAudit } from '../../composables/useAdminAudit'

const {
  isLoading,
  logs,
  query,
  total,
  updateFilters,
  updatePageNo,
  updatePageSize,
} = useAdminAudit()
const { t } = useI18n({ useScope: 'global' })
</script>

<template>
  <PagePanel>
    <template #header>
      <AdminPageHeader :title="t('admin.pages.audit')" />
    </template>

    <div class="admin-audit h-full min-h-0 flex bg-fill-lighter p-4 lg:p-6">
      <AuditTable
        :logs="logs"
        :total="total"
        :page-no="query.pageNo"
        :page-size="query.pageSize"
        :loading="isLoading"
        :target-type="query.targetType ?? null"
        class="min-h-0 flex-1"
        @update-filters="updateFilters"
        @update-page-no="updatePageNo"
        @update-page-size="updatePageSize"
      />
    </div>
  </PagePanel>
</template>
