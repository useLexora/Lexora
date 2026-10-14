<script setup lang="ts">
import type { SnapshotCatalog } from '@buddy-shared/storage/snapshot'
import { Archive20Regular, History20Regular } from '@vicons/fluent'
import { NAlert, NButton, NPopconfirm } from 'naive-ui'
import { formatFileSize } from '@/shared/lib/formatFileSize'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ catalog: SnapshotCatalog, disabled: boolean, english: boolean }>()
defineEmits<{ select: [id: string], export: [id: string], delete: [id: string] }>()
const text = (zh: string, en: string) => props.english ? en : zh
</script>

<template>
  <div class="grid gap-3">
    <NAlert v-if="catalog.unreadableIds.length" type="warning" :show-icon="false">
      {{ text('部分备份无法读取，已保留原文件。其他备份仍可使用。', 'Some backups could not be read. Their files are preserved; other backups remain available.') }}
    </NAlert>
    <div v-if="!catalog.snapshots.length" class="flex items-center gap-3 py-4 text-muted text-[0.8rem]">
      <DesktopIcon :component="Archive20Regular" :size="22" />
      <span>{{ text('还没有本地备份。创建一份，随时恢复重要数据。', 'No local backups yet. Create one to keep a recovery point.') }}</span>
    </div>
    <ul v-else class="list-none p-0 m-0">
      <li v-for="item in catalog.snapshots" :key="item.id" class="flex flex-wrap items-center justify-between gap-3 py-3 border-b border-b-solid border-border last:border-b-0">
        <div class="flex items-center gap-3">
          <DesktopIcon class="text-muted flex-none" :component="Archive20Regular" :size="20" />
          <div class="grid gap-1">
            <strong class="text-[0.8rem] font-500">{{ new Date(item.createdAt).toLocaleString(english ? 'en-US' : 'zh-CN') }}<span v-if="item.automatic" class="ml-2 text-[0.7rem] text-muted">{{ text('自动', 'Automatic') }}</span></strong>
            <span class="text-[0.7rem] text-muted tabular-nums">{{ formatFileSize(item.bytes) }} · {{ item.files }} {{ text('个文件', 'files') }}<span v-if="item.excludedLinks"> · {{ text('已跳过链接', 'Links skipped') }} {{ item.excludedLinks }}</span></span>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <NButton :disabled="disabled" @click="$emit('export', item.id)">
            {{ text('导出', 'Export') }}
          </NButton>
          <NButton :disabled="disabled" @click="$emit('select', item.id)">
            <template #icon>
              <DesktopIcon :component="History20Regular" />
            </template>
            {{ text('恢复备份', 'Restore backup') }}
          </NButton>
          <NPopconfirm :positive-text="text('删除备份', 'Delete backup')" :negative-text="text('取消', 'Cancel')" @positive-click="$emit('delete', item.id)">
            <template #trigger>
              <NButton quaternary type="error" :disabled="disabled">
                {{ text('删除', 'Delete') }}
              </NButton>
            </template>
            {{ text('删除这份本地备份？当前数据、云端备份和已导出的副本不受影响。', 'Delete this local backup? Current data, cloud backups and exported copies will be kept.') }}
          </NPopconfirm>
        </div>
      </li>
    </ul>
  </div>
</template>
