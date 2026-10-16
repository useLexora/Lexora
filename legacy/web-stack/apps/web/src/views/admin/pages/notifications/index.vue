<script setup lang="ts">
import { Plus } from '@element-plus/icons-vue'
import { useI18n } from 'vue-i18n'
import PagePanel from '@/layouts/panels/page-panel'
import AdminPageHeader from '../../components/page-header'
import { useAdminNotifications } from '../../composables/useAdminNotifications'
import NotificationsPanel from '../../widgets/notifications-panel'

const {
  closeDrawer,
  deleteNotification,
  deletingNotificationId,
  drawerTitle,
  drawerVisible,
  errorMessage,
  form,
  formRules,
  getStatusLabel,
  handlePageChange,
  handlePageSizeChange,
  handleStatusFilterChange,
  isEditing,
  isLoading,
  isSaving,
  isViewing,
  loadNotifications,
  notifications,
  openCreateDrawer,
  openEditDrawer,
  openViewDrawer,
  publishNotification,
  query,
  saveDraft,
  setFormRef,
  statusOptions,
  titleMaxLength,
  total,
  updateContent,
  updateTitle,
  uploadNotificationImage,
  resolveNotificationImageSrc,
} = useAdminNotifications()
const { t } = useI18n({ useScope: 'global' })
</script>

<template>
  <PagePanel>
    <template #header>
      <div class="admin-notifications__header flex min-w-0 flex-1 items-center justify-between gap-3">
        <AdminPageHeader :title="t('admin.pages.notifications')" />
        <ElButton type="primary" :icon="Plus" @click="openCreateDrawer">
          {{ t('admin.common.create') }}
        </ElButton>
      </div>
    </template>

    <div class="admin-notifications h-full min-h-0 bg-fill-lighter p-4 lg:p-6">
      <ElAlert v-if="errorMessage" :title="errorMessage" type="error" show-icon :closable="false" class="mb-4 rounded-xl" />

      <div class="admin-notifications__toolbar mb-4 flex flex-wrap items-center justify-between gap-3">
        <ElSegmented
          class="admin-notifications__status-filter"
          :model-value="query.status"
          :options="statusOptions"
          @change="handleStatusFilterChange"
        />
        <ElButton plain :loading="isLoading" @click="loadNotifications">
          {{ t('admin.common.refresh') }}
        </ElButton>
      </div>

      <NotificationsPanel
        :notifications="notifications"
        :total="total"
        :page-no="query.pageNo"
        :page-size="query.pageSize"
        :is-loading="isLoading"
        :drawer-title="drawerTitle"
        :drawer-visible="drawerVisible"
        :form="form"
        :form-rules="formRules"
        :title-max-length="titleMaxLength"
        :is-editing="isEditing"
        :is-viewing="isViewing"
        :is-saving="isSaving"
        :deleting-notification-id="deletingNotificationId"
        :set-form-ref="setFormRef"
        :get-status-label="getStatusLabel"
        :upload-image="uploadNotificationImage"
        :resolve-image-src="resolveNotificationImageSrc"
        @view-notification="openViewDrawer"
        @edit-notification="openEditDrawer"
        @delete-notification="deleteNotification"
        @page-change="handlePageChange"
        @page-size-change="handlePageSizeChange"
        @update-title="updateTitle"
        @update-content="updateContent"
        @close-drawer="closeDrawer"
        @save-draft="saveDraft"
        @publish-notification="publishNotification"
      />
    </div>
  </PagePanel>
</template>

<style scoped lang="scss">
.admin-notifications {
  &__status-filter {
    :deep(.el-segmented__item-label) {
      line-height: 1;
    }
  }
}
</style>
