<script setup lang="ts">
import type { editor } from 'monaco-editor/editor/editor.api.js'
import type { ChangeFilePresentation } from './changeContextPresentation'
import type { ObserveChangeFile } from './useChangeFileViewport'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronDown16Regular, ChevronRight16Regular } from '@vicons/fluent'
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { FileIcon } from '@/shared/ui/file-icon'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopMonacoDiff from './DesktopMonacoDiff.vue'

const props = defineProps<{ file: ChangeFilePresentation, collapsed: boolean, observe: ObserveChangeFile, language: BuddyLocale, wrap: boolean, sideBySide: boolean }>()
defineEmits<{ toggle: [] }>()
const { t } = useBuddyI18n(() => props.language)
const root = useTemplateRef<HTMLElement>('root')
const visible = shallowRef(false)
const contentHeight = shallowRef(160)
const viewState = shallowRef<editor.IDiffEditorViewState | null>(null)
watch(root, (element, _previous, onCleanup) => {
  if (element)
    onCleanup(props.observe(element, value => visible.value = value))
}, { flush: 'post' })
watch(() => [props.file.path, props.file.beforeText, props.file.afterText], () => viewState.value = null)
const counts = computed(() => props.file.lineCounts)
const parentPath = computed(() => props.file.path.includes('/') ? props.file.path.slice(0, props.file.path.lastIndexOf('/') + 1) : '')
const fileName = computed(() => props.file.path.slice(parentPath.value.length))
</script>

<template>
  <article ref="root" class="desktop-change-file-block min-w-0 flex-none overflow-hidden border border-solid border-border-strong rounded-[8px] bg-surface" :data-change-id="file.id">
    <button class="desktop-change-file-block__header flex w-full min-w-0 min-h-[42px] items-center gap-[8px] py-[8px] px-[12px] border-0 bg-subtle text-fg cursor-pointer text-left hover:bg-hover ui-focus-ring" type="button" :aria-expanded="!collapsed" @click="$emit('toggle')">
      <DesktopIcon :component="collapsed ? ChevronRight16Regular : ChevronDown16Regular" />
      <FileIcon :name="file.path" />
      <span class="flex min-w-0 flex-1 font-mono text-[12px] whitespace-nowrap" :title="file.path">
        <span v-if="parentPath" class="min-w-0 overflow-hidden text-muted text-ellipsis">{{ parentPath }}</span>
        <span class="desktop-change-file-block__filename min-w-0 max-w-full overflow-hidden font-500 text-ellipsis">{{ fileName }}</span>
      </span>
      <span v-if="counts" class="flex flex-none gap-[5px] font-mono text-[11px] font-500"><span class="is-added text-success">+{{ counts.added }}</span><span class="is-deleted text-danger">-{{ counts.deleted }}</span></span>
    </button>
    <template v-if="!collapsed">
      <DesktopMonacoDiff v-if="file.preview === 'text' && visible" :before="file.beforeText ?? ''" :after="file.afterText ?? ''" :language="file.language" :path="file.path" :wrap="wrap" :side-by-side="sideBySide" :initial-height="contentHeight" :view-state="viewState" fit-content @height="contentHeight = $event" @view-state="viewState = $event">
        <template #loading>
          {{ t('desktop.context.editorLoading') }}
        </template>
        <template #error>
          {{ t('desktop.context.editorLoadFailed') }}
        </template>
      </DesktopMonacoDiff>
      <div v-else-if="file.preview === 'text'" class="bg-surface" :style="{ height: `${contentHeight}px` }" />
      <div v-else class="desktop-change-file-block__unavailable grid min-h-[100px] p-[16px] text-muted text-[12px]">
        {{ t(`desktop.context.changePreview.${file.preview}`) }}
      </div>
      <div v-if="file.redacted" class="py-[6px] px-[12px] text-muted text-[11px]">
        {{ t('desktop.context.changeRedacted') }}
      </div>
    </template>
  </article>
</template>

<style scoped lang="scss">
.desktop-change-file-block__header[aria-expanded='true'] { border-bottom: 1px solid var(--buddy-border-subtle); }

.desktop-change-file-block__filename { flex: 0 0 auto; }

.desktop-change-file-block__unavailable { place-content: center; }
</style>
