<script setup lang="ts">
import type { CSSProperties } from 'vue'
import type { UserDataExpansionProps } from './typing'
import { useI18n } from 'vue-i18n'
import { formatDateTime } from '@/utils/dayjs'

const props = defineProps<UserDataExpansionProps>()
const { t } = useI18n({ useScope: 'global' })
const tableCellStyle: CSSProperties = {
  paddingTop: '0.5rem',
  paddingBottom: '0.5rem',
}

function getLimitText(total: number, shown: number, unit: string) {
  if (total <= shown) {
    return t('admin.users.detailTotal', { total, unit })
  }

  return t('admin.users.detailLimit', { shown, total, unit })
}
</script>

<template>
  <div class="user-data-expansion min-h-[4.5rem] bg-fill-lighter-a70 px-5 py-4">
    <ElSkeleton v-if="props.loading" animated>
      <template #template>
        <div class="grid gap-4">
          <section v-for="section in 2" :key="section" class="grid gap-3">
            <div class="flex items-center justify-between gap-3">
              <ElSkeletonItem variant="h3" class="max-w-24" />
              <ElSkeletonItem variant="text" class="max-w-28" />
            </div>
            <div class="grid gap-2">
              <ElSkeletonItem v-for="row in 3" :key="row" variant="rect" class="h-8 w-full" />
            </div>
          </section>
        </div>
      </template>
    </ElSkeleton>

    <ElAlert
      v-else-if="props.errorMessage"
      :title="props.errorMessage"
      type="error"
      show-icon
      :closable="false"
      class="mb-3"
    />

    <div v-else-if="props.detail" class="flex flex-col gap-4">
      <section class="user-data-expansion__section min-w-0 w-full">
        <div class="user-data-expansion__section-header mb-3 flex items-baseline justify-between gap-3">
          <span class="user-data-expansion__section-title text-[13px] font-bold text-main">{{ t('admin.users.documentData') }}</span>
          <span class="user-data-expansion__section-meta text-xs text-secondary">
            {{ getLimitText(props.detail.documentTotal, props.detail.documents.length, t('admin.users.documentUnit')) }}
          </span>
        </div>

        <ElTable
          :data="props.detail.documents"
          size="small"
          border
          row-key="id"
          :empty-text="t('admin.users.documentEmpty')"
          class="user-data-expansion__table"
          :cell-style="tableCellStyle"
        >
          <ElTableColumn :label="t('admin.users.title')" min-width="160">
            <template #default="{ row }">
              <span class="text-xs font-medium text-main">{{ row.title || t('admin.users.unnamedDocument') }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('admin.users.createdAt')" width="160">
            <template #default="{ row }">
              <span class="text-xs text-secondary">{{ formatDateTime(row.createdAt) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('admin.users.updatedAt')" width="160">
            <template #default="{ row }">
              <span class="text-xs text-secondary">{{ formatDateTime(row.updatedAt) }}</span>
            </template>
          </ElTableColumn>
        </ElTable>
      </section>

      <section class="user-data-expansion__section min-w-0 w-full">
        <div class="user-data-expansion__section-header mb-3 flex items-baseline justify-between gap-3">
          <span class="user-data-expansion__section-title text-[13px] font-bold text-main">{{ t('admin.users.chatData') }}</span>
          <span class="user-data-expansion__section-meta text-xs text-secondary">
            {{ getLimitText(props.detail.chatSessionTotal, props.detail.chatSessions.length, t('admin.users.chatUnit')) }}
          </span>
        </div>

        <ElTable
          :data="props.detail.chatSessions"
          size="small"
          border
          row-key="id"
          :empty-text="t('admin.users.chatEmpty')"
          class="user-data-expansion__table"
          :cell-style="tableCellStyle"
        >
          <ElTableColumn :label="t('admin.users.title')" min-width="180">
            <template #default="{ row }">
              <span class="text-xs font-medium text-main">{{ row.title }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('admin.users.createdAt')" width="160">
            <template #default="{ row }">
              <span class="text-xs text-secondary">{{ formatDateTime(row.createdAt) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn :label="t('admin.users.updatedAt')" width="160">
            <template #default="{ row }">
              <span class="text-xs text-secondary">{{ formatDateTime(row.updatedAt) }}</span>
            </template>
          </ElTableColumn>
        </ElTable>
      </section>
    </div>
  </div>
</template>
