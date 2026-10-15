<script setup lang="ts">
import type { StorageUsageCategoryView } from '../../model/storageUsagePresentation'
import { ChevronDown20Regular } from '@vicons/fluent'
import { computed, shallowRef, useId } from 'vue'
import { formatFileSize } from '@/shared/lib/formatFileSize'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ category: StorageUsageCategoryView, english: boolean }>()
const expanded = shallowRef(false)
const detailsId = useId()
const expandable = computed(() => props.category.details.length > 0)
const listeners = computed(() => expandable.value ? { click: () => expanded.value = !expanded.value } : {})

function formatFiles(files: number): string {
  const count = files.toLocaleString(props.english ? 'en-US' : 'zh-CN')
  return props.english ? count + (files === 1 ? ' file' : ' files') : `${count} 个文件`
}
</script>

<template>
  <li class="list-none border-t border-t-solid border-t-border">
    <component
      :is="expandable ? 'button' : 'div'"
      class="storage-usage-heading storage-usage-columns w-full box-border border-0 rounded-[var(--buddy-radius-micro)] bg-transparent my-1 px-2 py-3 text-left text-fg font-inherit"
      :class="expandable ? 'cursor-pointer ui-focus-ring' : ''"
      :type="expandable ? 'button' : undefined"
      :aria-expanded="expandable ? expanded : undefined"
      :aria-controls="expandable ? detailsId : undefined"
      v-on="listeners"
    >
      <span class="flex min-w-0 items-center gap-2.5">
        <span class="h-2 w-2 shrink-0 rounded-full" :style="{ background: `color-mix(in srgb, var(${category.color}) 78%, var(--buddy-surface-base))` }" aria-hidden="true" />
        <span class="text-[0.8rem] leading-snug">{{ category.label }}</span>
      </span>
      <span class="storage-usage-share text-right text-[0.7rem] text-muted tabular-nums">{{ category.share }}</span>
      <span class="text-right text-[0.8rem] tabular-nums">{{ formatFileSize(category.bytes) }}</span>
      <DesktopIcon v-if="expandable" :component="ChevronDown20Regular" :size="16" class="text-muted" :class="{ '-rotate-90': !expanded }" />
    </component>
    <dl v-if="expandable" v-show="expanded" :id="detailsId" class="m-0 grid gap-3 pt-3 pb-4 pl-[1.65rem] pr-9">
      <div v-for="detail in category.details" :key="detail.id" class="flex items-baseline justify-between gap-4 text-[0.75rem] leading-snug">
        <dt class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-muted">
          <span>{{ detail.label }}</span>
          <span class="text-[0.65rem] tabular-nums">{{ formatFiles(detail.files) }}</span>
        </dt>
        <dd class="m-0 shrink-0 tabular-nums">
          {{ formatFileSize(detail.bytes) }}
        </dd>
      </div>
    </dl>
  </li>
</template>

<style scoped lang="scss">
.storage-usage-heading[aria-expanded]:hover {
  background: color-mix(in srgb, var(--buddy-nav-hover) 65%, transparent);
}
</style>
