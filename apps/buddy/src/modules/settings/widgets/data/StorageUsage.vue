<script setup lang="ts">
import type { StorageUsage } from '@buddy-shared/storage/storageApi'
import { ArrowClockwise20Regular } from '@vicons/fluent'
import { NButton, NSkeleton } from 'naive-ui'
import { computed } from 'vue'
import { formatFileSize } from '@/shared/lib/formatFileSize'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ usage: StorageUsage | null, loading: boolean, failed: boolean, english: boolean }>()
defineEmits<{ scan: [] }>()
const text = (zh: string, en: string) => props.english ? en : zh
const total = computed(() => props.usage?.categories.reduce((sum, item) => sum + item.bytes, 0) ?? 0)
const files = computed(() => props.usage?.categories.reduce((sum, item) => sum + item.files, 0) ?? 0)
const categories = computed(() => props.usage?.categories.map(item => ({
  ...item,
  label: ({ data: text('任务与文件', 'Tasks and files'), device: text('应用设置', 'Application settings'), browser: text('浏览器网站数据', 'Browser site data'), plugins: text('插件与插件数据', 'Plugins and plugin data'), skills: 'Skills', cache: text('应用缓存', 'Application cache'), browserCache: text('浏览器缓存', 'Browser cache'), logs: text('日志', 'Logs'), recovery: text('恢复副本', 'Recovery copies'), exports: text('本地备份与导出', 'Backups and exports') })[item.id],
  color: ({ data: '--buddy-accent-solid', device: '--buddy-text-muted', browser: '--buddy-data-blue', plugins: '--buddy-data-violet', skills: '--buddy-data-cyan', cache: '--buddy-data-violet', browserCache: '--buddy-data-blue', logs: '--buddy-brand-gold', recovery: '--buddy-data-cyan', exports: '--buddy-text-muted' })[item.id],
})) ?? [])
</script>

<template>
  <section class="grid grid-cols-1 gap-3 p-[0.9rem]" :aria-label="text('空间占用', 'Storage usage')" :aria-busy="loading">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <h3 class="m-0 text-[0.8rem] font-600">
        {{ text('空间占用', 'Storage usage') }}
      </h3>
      <NButton :loading="loading" :disabled="loading || (!usage && !failed)" @click="$emit('scan')">
        <template #icon>
          <DesktopIcon :component="ArrowClockwise20Regular" />
        </template>
        {{ failed ? text('重试', 'Retry') : text('重新统计', 'Refresh') }}
      </NButton>
    </header>
    <div v-if="loading || (!usage && !failed)" role="status">
      <span class="sr-only">{{ text('正在统计空间占用…', 'Calculating storage usage…') }}</span>
      <div aria-hidden="true">
        <NSkeleton height="1.6rem" width="7rem" />
        <NSkeleton height="0.45rem" round class="mt-4" />
        <div class="storage-usage-legend grid grid-cols-2 gap-x-8 gap-y-3 mt-4">
          <div v-for="index in 10" :key="index" class="flex h-[1.2rem] items-center justify-between gap-3">
            <NSkeleton height="0.75rem" width="8rem" />
            <NSkeleton height="0.75rem" width="3.5rem" />
          </div>
        </div>
        <NSkeleton height="1.1rem" width="12rem" class="mt-4 max-w-full" />
        <NSkeleton height="1.1rem" width="28rem" class="mt-2 max-w-full" />
      </div>
    </div>
    <div v-else-if="!usage" class="grid gap-1 py-2" role="status">
      <span class="text-[0.8rem]">{{ text('暂时无法读取空间占用', 'Storage usage is unavailable') }}</span>
      <span class="text-[0.7rem] text-muted">{{ text('可以重试，其他设置仍可使用。', 'You can retry and continue using other settings.') }}</span>
    </div>
    <div v-else>
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1" role="status">
        <strong class="text-[1.3rem] leading-tight font-600 tabular-nums tracking-tight">{{ formatFileSize(total) }}</strong>
      </div>
      <div class="flex h-[0.45rem] overflow-hidden rounded-full bg-[var(--buddy-border-subtle)] mt-4" aria-hidden="true">
        <span v-for="item in categories.filter(item => item.bytes > 0)" :key="item.id" class="min-w-px basis-0" :style="{ flexGrow: item.bytes, background: `var(${item.color})` }" />
      </div>
      <dl class="storage-usage-legend grid grid-cols-2 gap-x-8 gap-y-3 m-0 mt-4">
        <div v-for="item in categories" :key="item.id" class="flex items-center justify-between gap-3 text-[0.75rem]">
          <dt class="flex min-w-0 items-center gap-2">
            <span class="h-2 w-2 flex-none rounded-full" :style="{ background: `var(${item.color})` }" />
            {{ item.label }}
          </dt>
          <dd class="m-0 shrink-0 text-muted tabular-nums">
            {{ formatFileSize(item.bytes) }}
          </dd>
        </div>
      </dl>
      <p class="m-0 mt-4 text-[0.7rem] text-muted leading-relaxed">
        {{ text(`共 ${files.toLocaleString()} 个文件`, `${files.toLocaleString()} files`) }} · {{ text('更新于', 'Updated') }} {{ new Date(usage.scannedAt).toLocaleTimeString(english ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit' }) }}
        <span v-if="usage.missing">{{ text('部分文件无法读取，实际占用可能更大。', 'Some files could not be read; actual usage may be higher.') }}</span>
      </p>
      <p class="m-0 mt-2 text-[0.7rem] text-muted">
        {{ text('浏览器缓存包含网页、代码与图形缓存；浏览器设置中的大小仅统计网页缓存。', 'Browser cache includes web, code and graphics caches. Browser settings report web cache only.') }}
      </p>
      <p v-if="failed" class="m-0 mt-2 text-[0.7rem] text-muted" role="status">
        {{ text('更新未完成，仍显示上次统计结果。', 'Refresh failed. Showing the previous result.') }}
      </p>
    </div>
  </section>
</template>

<style scoped lang="scss">
.storage-usage-legend {
  @container (max-width: 560px) {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  :deep(.n-skeleton) {
    animation: none;
  }
}
</style>
