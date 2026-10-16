<script setup lang="ts">
import type { TiptapJsonContent } from '@haohaoxue/lexora-contracts'
import type { FormInstance, FormRules } from 'element-plus'
import type { AdminNotificationForm } from '../../composables/useAdminNotifications'
import type {
  PlatformNotification,
  PlatformNotificationStatus,
} from '@/apis/notification'
import type {
  TiptapEditorResolveImageSrc,
  TiptapEditorUploadedImage,
} from '@/components/tiptap-editor/content/typing'
import { PLATFORM_NOTIFICATION_STATUS } from '@haohaoxue/lexora-contracts/notification'
import { useI18n } from 'vue-i18n'
import Empty from '@/components/empty'
import { LoadingTableSkeleton } from '@/components/loading'
import { StandaloneContentEditor } from '@/components/tiptap-editor'
import { formatDateTime } from '@/utils/dayjs'

interface NotificationsPanelProps {
  notifications: PlatformNotification[]
  total: number
  pageNo: number
  pageSize: number
  isLoading: boolean
  drawerTitle: string
  drawerVisible: boolean
  form: AdminNotificationForm
  formRules: FormRules<AdminNotificationForm>
  titleMaxLength: number
  isEditing: boolean
  isViewing: boolean
  isSaving: boolean
  deletingNotificationId: string
  setFormRef: (instance: FormInstance | null) => void
  getStatusLabel: (status: PlatformNotificationStatus) => string
  uploadImage: (file: File) => Promise<TiptapEditorUploadedImage>
  resolveImageSrc: TiptapEditorResolveImageSrc
}

interface NotificationsPanelEmits {
  viewNotification: [notification: PlatformNotification]
  editNotification: [notification: PlatformNotification]
  deleteNotification: [notification: PlatformNotification]
  pageChange: [pageNo: number]
  pageSizeChange: [pageSize: number]
  updateTitle: [title: string]
  updateContent: [content: TiptapJsonContent]
  closeDrawer: []
  saveDraft: []
  publishNotification: []
}

const props = defineProps<NotificationsPanelProps>()
const emits = defineEmits<NotificationsPanelEmits>()
const { t } = useI18n({ useScope: 'global' })

function handleDrawerVisibleUpdate(visible: boolean) {
  if (!visible) {
    emits('closeDrawer')
  }
}

function handleTitleUpdate(value: string | number) {
  emits('updateTitle', String(value))
}

function handleFormRef(instance: unknown) {
  props.setFormRef(isFormInstance(instance) ? instance : null)
}

function isFormInstance(instance: unknown): instance is FormInstance {
  return typeof instance === 'object'
    && instance !== null
    && 'validate' in instance
    && 'clearValidate' in instance
}

function isPublishedNotification(notification: PlatformNotification) {
  return notification.status === PLATFORM_NOTIFICATION_STATUS.PUBLISHED
}
</script>

<template>
  <section class="admin-notifications-panel">
    <div class="admin-notifications-panel__table-wrap">
      <ElTable
        :data="props.notifications"
        row-key="id"
        class="admin-notifications__table"
        height="calc(100vh - 15rem)"
      >
        <template #empty>
          <LoadingTableSkeleton v-if="props.isLoading" compact />
          <Empty v-else compact />
        </template>

        <ElTableColumn :label="t('admin.notifications.title')" min-width="220">
          <template #default="{ row }">
            <div class="min-w-0">
              <p class="m-0 truncate text-sm font-semibold leading-5 text-main">
                {{ row.title }}
              </p>
              <p class="m-0 mt-1 line-clamp-2 text-xs leading-5 text-secondary">
                {{ row.summary || t('admin.notifications.noSummary') }}
              </p>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn :label="t('admin.notifications.status')" width="120">
          <template #default="{ row }">
            <ElTag :type="row.status === 'PUBLISHED' ? 'success' : 'info'" effect="plain">
              {{ props.getStatusLabel(row.status) }}
            </ElTag>
          </template>
        </ElTableColumn>
        <ElTableColumn :label="t('admin.notifications.publishedAt')" width="180">
          <template #default="{ row }">
            {{ row.publishedAt ? formatDateTime(row.publishedAt) : '-' }}
          </template>
        </ElTableColumn>
        <ElTableColumn :label="t('admin.notifications.updatedBy')" width="160">
          <template #default="{ row }">
            {{ row.updatedByUser?.displayName ?? '-' }}
          </template>
        </ElTableColumn>
        <ElTableColumn :label="t('admin.notifications.updatedAt')" width="180">
          <template #default="{ row }">
            {{ formatDateTime(row.updatedAt) }}
          </template>
        </ElTableColumn>
        <ElTableColumn :label="t('admin.common.operation')" width="132" fixed="right">
          <template #default="{ row }">
            <ElButton
              v-if="isPublishedNotification(row)"
              link
              type="primary"
              @click="emits('viewNotification', row)"
            >
              {{ t('admin.common.view') }}
            </ElButton>
            <ElButton
              v-else
              link
              type="primary"
              @click="emits('editNotification', row)"
            >
              {{ t('admin.common.edit') }}
            </ElButton>
            <ElButton
              link
              type="danger"
              :loading="props.deletingNotificationId === row.id"
              @click="emits('deleteNotification', row)"
            >
              {{ t('admin.common.delete') }}
            </ElButton>
          </template>
        </ElTableColumn>
      </ElTable>
    </div>

    <div class="admin-notifications__pagination mt-4 flex justify-end">
      <ElPagination
        :current-page="props.pageNo"
        :page-size="props.pageSize"
        :total="props.total"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        background
        @current-change="emits('pageChange', $event)"
        @size-change="emits('pageSizeChange', $event)"
      />
    </div>

    <ElDrawer
      :model-value="props.drawerVisible"
      :title="props.drawerTitle"
      size="44rem"
      destroy-on-close
      @update:model-value="handleDrawerVisibleUpdate"
      @close="emits('closeDrawer')"
    >
      <div v-if="props.isViewing" class="admin-notifications__view grid gap-4">
        <div>
          <h3 class="m-0 text-lg font-semibold leading-7 text-main">
            {{ props.form.title }}
          </h3>
        </div>

        <div class="admin-notifications__editor w-full">
          <StandaloneContentEditor
            :content="props.form.content"
            :editable="false"
            :resolve-image-src="props.resolveImageSrc"
          />
        </div>
      </div>

      <ElForm
        v-else
        :ref="handleFormRef"
        :model="props.form"
        :rules="props.formRules"
        label-position="top"
        class="admin-notifications__form"
      >
        <ElFormItem :label="t('admin.notifications.title')" prop="title">
          <ElInput
            :model-value="props.form.title"
            :maxlength="props.titleMaxLength"
            show-word-limit
            @update:model-value="handleTitleUpdate"
          />
        </ElFormItem>
        <ElFormItem :label="t('admin.notifications.content')" prop="content">
          <div class="admin-notifications__editor w-full">
            <StandaloneContentEditor
              :content="props.form.content"
              :editable="!props.isViewing"
              can-upload-image
              :upload-image="props.uploadImage"
              :resolve-image-src="props.resolveImageSrc"
              @update:content="emits('updateContent', $event)"
            />
          </div>
        </ElFormItem>
      </ElForm>

      <template #footer>
        <div v-if="props.isViewing" class="flex justify-end">
          <ElButton @click="emits('closeDrawer')">
            {{ t('admin.common.close') }}
          </ElButton>
        </div>
        <div v-else class="flex justify-end gap-3">
          <ElButton @click="emits('closeDrawer')">
            {{ t('admin.common.cancel') }}
          </ElButton>
          <ElButton :loading="props.isSaving" @click="emits('saveDraft')">
            {{ t('admin.notifications.saveDraft') }}
          </ElButton>
          <ElButton type="primary" :loading="props.isSaving" @click="emits('publishNotification')">
            {{ props.isEditing ? t('admin.notifications.saveAndPublish') : t('admin.notifications.publish') }}
          </ElButton>
        </div>
      </template>
    </ElDrawer>
  </section>
</template>

<style scoped lang="scss">
.admin-notifications-panel {
  min-height: 0;
}

.admin-notifications {
  &__table {
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 82%, transparent);
    border-radius: 8px;
  }

  &__editor {
    height: 24rem;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 84%, transparent);
    border-radius: 8px;
    background: var(--brand-bg-surface);

    :deep(.standalone-content-editor) {
      display: flex;
      height: 100%;
      min-height: 0;
      flex-direction: column;
    }

    :deep(.standalone-content-editor__surface) {
      min-height: 0;
      flex: 1 1 0%;
    }

    :deep(.tiptap-editor) {
      min-height: 0;
    }

    :deep(.tiptap-editor__content) {
      min-height: 0;
      overflow: auto;
    }

    :deep(.ProseMirror) {
      min-height: 100%;
      padding: 1rem;
    }
  }
}
</style>
