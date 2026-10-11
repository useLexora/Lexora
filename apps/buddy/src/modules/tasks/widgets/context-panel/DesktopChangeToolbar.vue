<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ArrowCollapseAll20Regular, ArrowExpand20Regular, ArrowWrap20Regular, TextColumnOne20Regular, TextColumnTwo20Regular } from '@vicons/fluent'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopContextAction from '@/shared/ui/files/DesktopContextAction.vue'
import DirectoryTreeCollapsedIcon from '@/shared/ui/icon/DirectoryTreeCollapsedIcon.vue'
import DirectoryTreeExpandedIcon from '@/shared/ui/icon/DirectoryTreeExpandedIcon.vue'

const props = defineProps<{ language: BuddyLocale, added: number, deleted: number, canShowTurn: boolean, allCollapsed: boolean, wrap: boolean, sideBySide: boolean, treeVisible: boolean }>()
defineEmits<{ toggleAll: [], toggleWrap: [], toggleLayout: [], toggleTree: [] }>()
const range = defineModel<'all' | 'turn'>('range', { required: true })
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <div class="desktop-change-toolbar flex w-full min-w-0 items-center gap-[10px] py-0 px-[10px]">
    <div class="desktop-change-toolbar__range flex flex-none gap-[2px] p-[3px] rounded-[7px] bg-subtle">
      <button type="button" :class="{ 'is-active': range === 'all' }" @click="range = 'all'">
        {{ t('desktop.context.allChanges') }}
      </button>
      <button type="button" :disabled="!canShowTurn" :class="{ 'is-active': range === 'turn' }" @click="range = 'turn'">
        {{ t('desktop.context.turnChanges') }}
      </button>
    </div>
    <div class="flex gap-[5px] font-mono text-[12px] whitespace-nowrap" data-testid="change-line-counts">
      <span class="is-added text-success">+{{ added }}</span><span class="is-deleted text-danger">-{{ deleted }}</span>
    </div>
    <div class="flex flex-none ml-auto gap-[2px]">
      <DesktopContextAction :icon="allCollapsed ? ArrowExpand20Regular : ArrowCollapseAll20Regular" :label="t(allCollapsed ? 'desktop.context.expandAll' : 'desktop.context.collapseAll')" @click="$emit('toggleAll')" />
      <DesktopContextAction :icon="ArrowWrap20Regular" :label="t('desktop.context.wrap')" :active="wrap" @click="$emit('toggleWrap')" />
      <DesktopContextAction :icon="sideBySide ? TextColumnTwo20Regular : TextColumnOne20Regular" :label="t(sideBySide ? 'desktop.context.inlineDiff' : 'desktop.context.splitDiff')" @click="$emit('toggleLayout')" />
      <DesktopContextAction :icon="treeVisible ? DirectoryTreeExpandedIcon : DirectoryTreeCollapsedIcon" :label="t(treeVisible ? 'desktop.context.hideTree' : 'desktop.context.showTree')" :active="treeVisible" @click="$emit('toggleTree')" />
    </div>
  </div>
</template>

<style scoped lang="scss">
.desktop-change-toolbar__range button { border: 0; border-radius: 5px; background: transparent; color: var(--buddy-text-secondary); cursor: pointer; font-size: 12px; font-weight: 580; padding: 5px 8px; white-space: nowrap; }
.desktop-change-toolbar__range button.is-active { background: var(--buddy-surface-base); box-shadow: var(--buddy-shadow-soft); color: var(--buddy-text-strong); }
.desktop-change-toolbar__range button:disabled { opacity: 0.4; cursor: default; }
.desktop-change-toolbar__range button:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: 1px; }
</style>
