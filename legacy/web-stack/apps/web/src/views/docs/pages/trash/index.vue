<script setup lang="ts">
import type { CSSProperties } from 'vue'
import { formatDocumentLocation } from '@haohaoxue/lexora-shared/document'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Empty from '@/components/empty'
import { LoadingTableSkeleton } from '@/components/loading'
import { formatDateTime } from '@/utils/dayjs'
import { useDocsTrashPage } from '../../composables/useDocsTrashPage'

const {
  items,
  isLoading,
  errorMessage,
  actionItemId,
  loadItems,
  restoreItem,
  permanentlyDeleteItem,
} = useDocsTrashPage()
const { t } = useI18n()

const tableItems = computed(() =>
  items.value.map(item => ({
    ...item,
    locationLabel: formatDocumentLocation(item.collection, item.ancestorTitles),
    trashedAtLabel: formatDateTime(item.trashedAt),
  })),
)

const tableHeaderCellStyle: CSSProperties = {
  padding: '1rem 1.25rem',
  borderBottomColor: 'color-mix(in srgb, var(--brand-border-base) 78%, transparent)',
  fontSize: '0.8125rem',
  fontWeight: 600,
}

const tableBodyCellStyle: CSSProperties = {
  padding: '1rem 1.25rem',
  borderBottomColor: 'color-mix(in srgb, var(--brand-border-base) 68%, transparent)',
}

function isItemActing(documentId: string) {
  return actionItemId.value === documentId
}
</script>

<template>
  <section class="docs-trash-page min-h-0 flex-1 overflow-auto p-[clamp(1.25rem,2vw,1.75rem)]">
    <div class="docs-trash-page__surface mx-auto w-full max-w-[var(--page-mode-table-max-width)] overflow-hidden rounded-lg">
      <ElTable
        :data="tableItems"
        row-key="id"
        class="docs-trash-table"
        :header-cell-style="tableHeaderCellStyle"
        :cell-style="tableBodyCellStyle"
      >
        <template #empty>
          <LoadingTableSkeleton v-if="isLoading" compact />

          <Empty v-else :description="errorMessage || t('docs.trash.empty')">
            <ElButton v-if="errorMessage" type="primary" @click="loadItems">
              {{ t('docs.common.reload') }}
            </ElButton>
          </Empty>
        </template>

        <ElTableColumn :label="t('docs.trash.title')" prop="title" min-width="320" show-overflow-tooltip />
        <ElTableColumn :label="t('docs.trash.originalLocation')" prop="locationLabel" min-width="260" show-overflow-tooltip />
        <ElTableColumn :label="t('docs.trash.deletedAt')" prop="trashedAtLabel" width="180" />

        <ElTableColumn :label="t('docs.common.operation')" width="180" align="right" header-align="right">
          <template #default="{ row }">
            <div class="flex flex-wrap justify-end gap-2">
              <ElButton
                size="small"
                :loading="isItemActing(row.id)"
                :disabled="isItemActing(row.id)"
                @click="restoreItem(row.id)"
              >
                {{ t('docs.common.restore') }}
              </ElButton>

              <ElButton
                size="small"
                type="danger"
                plain
                :loading="isItemActing(row.id)"
                :disabled="isItemActing(row.id)"
                @click="permanentlyDeleteItem(row.id)"
              >
                {{ t('docs.trash.deletePermanently') }}
              </ElButton>
            </div>
          </template>
        </ElTableColumn>
      </ElTable>
    </div>
  </section>
</template>

<style scoped lang="scss">
.docs-trash-page {
  background: var(--brand-bg-base);
}

.docs-trash-page__surface {
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 78%, transparent);
  background: var(--brand-bg-surface);
  box-shadow: var(--brand-shadow-hairline);
}

.docs-trash-table {
  --el-table-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
  --el-fill-color-blank: transparent;
  --el-table-border-color: color-mix(in srgb, var(--brand-border-base) 68%, transparent);
  --el-table-header-bg-color: color-mix(in srgb, var(--brand-fill-light) 86%, var(--brand-bg-surface));
  --el-table-header-text-color: var(--brand-text-secondary);
  --el-table-text-color: var(--brand-text-primary);
  --el-table-row-hover-bg-color: color-mix(in srgb, var(--brand-primary) 4%, var(--brand-bg-surface));

  :deep(.el-table__inner-wrapper::before) {
    display: none;
  }

  :deep(.el-table__cell .cell) {
    padding: 0;
  }
}
</style>
