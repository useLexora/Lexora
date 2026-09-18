<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ArrowWrap20Regular, ChevronRight16Regular } from '@vicons/fluent'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DirectoryTreeCollapsedIcon from '@/shared/ui/icon/DirectoryTreeCollapsedIcon.vue'
import DirectoryTreeExpandedIcon from '@/shared/ui/icon/DirectoryTreeExpandedIcon.vue'
import DesktopContextAction from './DesktopContextAction.vue'

const props = defineProps<{ path: string, rootName: string, language: BuddyLocale, wrap: boolean, treeVisible: boolean }>()
defineEmits<{ toggleWrap: [], toggleTree: [] }>()
const { t } = useBuddyI18n(() => props.language)
const segments = computed(() => [props.rootName, ...props.path.split('/').filter(Boolean)])
</script>

<template>
  <div class="desktop-file-toolbar">
    <slot>
      <div class="desktop-file-toolbar__path">
        <template v-for="(segment, index) in segments" :key="index">
          <DesktopIcon v-if="index" :component="ChevronRight16Regular" />
          <span :class="{ 'is-current': index === segments.length - 1 }">{{ segment }}</span>
        </template>
      </div>
    </slot>
    <div class="desktop-file-toolbar__actions">
      <DesktopContextAction :icon="ArrowWrap20Regular" :label="t('desktop.context.wrap')" :active="wrap" @click="$emit('toggleWrap')" />
      <DesktopContextAction :icon="treeVisible ? DirectoryTreeExpandedIcon : DirectoryTreeCollapsedIcon" :label="t(treeVisible ? 'desktop.context.hideTree' : 'desktop.context.showTree')" :active="treeVisible" @click="$emit('toggleTree')" />
    </div>
  </div>
</template>

<style scoped>
.desktop-file-toolbar { display: flex; width: 100%; min-width: 0; align-items: center; gap: 8px; padding: 0 10px 0 14px; }
.desktop-file-toolbar__path { display: flex; flex: 1; min-width: 0; align-items: center; gap: 5px; overflow: hidden; font-size: 12px; color: var(--buddy-text-muted); }
.desktop-file-toolbar__path > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.desktop-file-toolbar__path > .is-current { flex: 0 0 auto; max-width: 70%; color: var(--buddy-text-primary); }
.desktop-file-toolbar__path :deep(.n-icon) { flex: none; font-size: 12px; }
.desktop-file-toolbar__actions { display: flex; flex: none; gap: 4px; }
</style>
