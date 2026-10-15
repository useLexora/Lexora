<script setup lang="ts">
import type { StorageUsage } from '@buddy-shared/storage/storageApi'
import { ArrowClockwise20Regular } from '@vicons/fluent'
import { NButton, NSkeleton, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { formatFileSize } from '@/shared/lib/formatFileSize'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { presentStorageUsage } from '../../model/storageUsagePresentation'
import StorageUsageCategoryRow from './StorageUsageCategoryRow.vue'

const props = defineProps<{ usage: StorageUsage | null, loading: boolean, failed: boolean, english: boolean }>()
defineEmits<{ scan: [] }>()
const text = (zh: string, en: string) => props.english ? en : zh
const total = computed(() => props.usage?.categories.reduce((sum, item) => sum + item.bytes, 0) ?? 0)
const files = computed(() => props.usage?.categories.reduce((sum, item) => sum + item.files, 0) ?? 0)
const categories = computed(() => presentStorageUsage(props.usage, props.english))
const segments = computed(() => {
  const nonEmpty = categories.value.filter(category => category.bytes > 0)
  const minor = nonEmpty.filter(category => category.bytes < total.value * 0.01)
  const visible = minor.length > 1 ? nonEmpty.filter(category => category.bytes >= total.value * 0.01) : nonEmpty
  const result = visible.map(category => ({ id: category.id as string, bytes: category.bytes, color: category.color, label: category.label, items: [category] }))
  if (minor.length > 1) {
    result.push({
      id: 'other',
      bytes: minor.reduce((sum, category) => sum + category.bytes, 0),
      color: '--buddy-text-muted',
      label: text('其他分类', 'Other categories'),
      items: minor,
    })
  }
  return result
})
</script>

<template>
  <section class="storage-usage grid gap-4 p-[0.9rem]" :aria-label="text('空间占用', 'Storage usage')" :aria-busy="loading">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="grid gap-2">
        <h3 class="m-0 text-[0.8rem] font-600">
          {{ text('空间占用', 'Storage usage') }}
        </h3>
        <template v-if="usage">
          <strong role="status" class="text-[1.5rem] leading-tight font-600 tabular-nums tracking-tight">{{ formatFileSize(total) }}</strong>
          <span class="text-[0.7rem] text-muted">{{ text(`共 ${files.toLocaleString('zh-CN')} 个文件`, `${files.toLocaleString('en-US')} files`) }}</span>
        </template>
      </div>
      <NButton size="small" :loading="loading" :disabled="loading || (!usage && !failed)" @click="$emit('scan')">
        <template #icon>
          <DesktopIcon :component="ArrowClockwise20Regular" />
        </template>
        {{ failed ? text('重试', 'Retry') : text('重新统计', 'Refresh') }}
      </NButton>
    </header>
    <div v-if="!usage && (loading || !failed)" class="grid gap-4" role="status">
      <span class="sr-only">{{ text('正在统计空间占用…', 'Calculating storage usage…') }}</span>
      <div aria-hidden="true">
        <NSkeleton height="1.8rem" width="8rem" />
        <NSkeleton height="0.5rem" round class="mt-4" />
        <div class="grid gap-5 mt-5">
          <div v-for="index in 8" :key="index" class="flex items-center justify-between gap-3">
            <NSkeleton height="0.9rem" width="9rem" />
            <NSkeleton height="0.9rem" width="4rem" />
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="!usage" class="grid gap-1 py-2" role="status">
      <span class="text-[0.8rem]">{{ text('暂时无法读取空间占用', 'Storage usage is unavailable') }}</span>
      <span class="text-[0.7rem] text-muted">{{ text('可以重试，其他设置仍可使用。', 'You can retry and continue using other settings.') }}</span>
    </div>
    <template v-else>
      <div class="storage-usage-band flex h-3.5 gap-[2px] overflow-hidden rounded-[5px] bg-subtle p-[2px]" aria-hidden="true">
        <NTooltip v-for="item in segments" :key="item.id" :show-arrow="false">
          <template #trigger>
            <span class="storage-usage-segment min-w-0 basis-0 rounded-[2px]" :style="{ flexGrow: item.bytes, background: `color-mix(in srgb, var(${item.color}) 78%, var(--buddy-surface-base))` }" />
          </template>
          <div class="grid gap-1 text-[0.75rem]">
            <strong v-if="item.items.length > 1" class="font-500">{{ item.label }}</strong>
            <div v-for="category in item.items" :key="category.id" class="flex justify-between gap-6">
              <span>{{ category.label }}</span>
              <span class="tabular-nums">{{ formatFileSize(category.bytes) }}</span>
            </div>
          </div>
        </NTooltip>
      </div>
      <div>
        <div class="storage-usage-columns px-2 pb-2 text-[0.65rem] text-muted" aria-hidden="true">
          <span>{{ text('分类', 'Category') }}</span>
          <span class="storage-usage-share text-right">{{ text('占比', 'Share') }}</span>
          <span class="text-right">{{ text('占用', 'Size') }}</span>
        </div>
        <ul class="m-0 p-0">
          <StorageUsageCategoryRow v-for="category in categories" :key="category.id" :category="category" :english="english" />
        </ul>
      </div>
      <footer class="grid gap-1 text-[0.65rem] text-muted leading-relaxed">
        <span>{{ text('仅统计当前数据目录，不包含外部工作目录。', 'Includes the current data directory only. External working directories are excluded.') }}</span>
        <span>{{ text('更新于', 'Updated') }} {{ new Date(usage.scannedAt).toLocaleTimeString(english ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</span>
        <span v-if="usage.missing" role="status">{{ text('部分文件无法读取，实际占用可能更大。', 'Some files could not be read; actual usage may be higher.') }}</span>
        <span v-if="failed" role="status">{{ text('更新未完成，仍显示上次统计结果。', 'Refresh failed. Showing the previous result.') }}</span>
      </footer>
    </template>
  </section>
</template>

<style scoped lang="scss">
.storage-usage-band {
  box-shadow: inset 0 0 0 1px var(--buddy-border-subtle);
}

.storage-usage {
  :deep(.storage-usage-columns) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 4rem 6rem 1rem;
    align-items: center;
    gap: 0.75rem;
  }

  @container (max-width: 400px) {
    :deep(.storage-usage-columns) {
      grid-template-columns: minmax(0, 1fr) 5rem 1rem;
      gap: 0.5rem;
    }

    :deep(.storage-usage-share) {
      display: none;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .storage-usage :deep(.n-skeleton) {
    animation: none;
  }
}
</style>
