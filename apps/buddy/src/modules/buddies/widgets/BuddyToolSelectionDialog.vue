<script setup lang="ts">
import type { BuddyToolOption } from '@buddy-shared/buddies/buddyApi'
import {
  AppFolder20Regular,
  ChevronDown20Regular,
  ChevronRight20Regular,
  PlugConnected20Regular,
  PuzzlePiece20Regular,
  Search20Regular,
} from '@vicons/fluent'
import {
  NButton,
  NCheckbox,
  NInput,
  NModal,
  NScrollbar,
  NTag,
} from 'naive-ui'
import { computed, ref, shallowRef, watch } from 'vue'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { buddyLabels } from '../buddyLabels'

interface ToolGroup {
  key: string
  kind: BuddyToolOption['source']['kind']
  title: string
  tools: BuddyToolOption[]
}

const props = defineProps<{
  show: boolean
  toolCatalog: readonly BuddyToolOption[]
  selectedIds: readonly string[]
  disabled: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  'save': [selectedIds: string[]]
}>()

const { language } = useDesktopUi()
const labels = computed(() => buddyLabels(language.value))
const searchQuery = shallowRef('')
const draftSelection = ref<Set<string>>(new Set())
const collapsedGroups = ref<Set<string>>(new Set())

watch(() => props.show, (open) => {
  if (open) {
    draftSelection.value = new Set(props.selectedIds)
    searchQuery.value = ''
    collapsedGroups.value = new Set()
  }
})

const groups = computed<ToolGroup[]>(() => {
  const map = new Map<string, ToolGroup>()
  for (const tool of props.toolCatalog) {
    const key = `${tool.source.kind}:${tool.source.id}`
    let group = map.get(key)
    if (!group) {
      group = {
        key,
        kind: tool.source.kind,
        title: tool.source.title || tool.source.id,
        tools: [],
      }
      map.set(key, group)
    }
    group.tools.push(tool)
  }
  return [...map.values()]
})

const filteredGroups = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query)
    return groups.value

  return groups.value.map((group) => {
    const matchGroup = group.title.toLowerCase().includes(query)
    const matchingTools = group.tools.filter(tool =>
      matchGroup || tool.name.toLowerCase().includes(query) || tool.title.toLowerCase().includes(query),
    )
    return matchingTools.length ? { ...group, tools: matchingTools } : null
  }).filter((g): g is ToolGroup => g !== null)
})

function toggleTool(id: string) {
  if (props.disabled)
    return
  const next = new Set(draftSelection.value)
  if (next.has(id))
    next.delete(id)
  else
    next.add(id)
  draftSelection.value = next
}

function getGroupCheckState(group: ToolGroup): { checked: boolean, indeterminate: boolean } {
  const total = group.tools.length
  if (total === 0)
    return { checked: false, indeterminate: false }
  const selectedCount = group.tools.filter(t => draftSelection.value.has(t.id)).length
  return {
    checked: selectedCount === total,
    indeterminate: selectedCount > 0 && selectedCount < total,
  }
}

function toggleGroup(group: ToolGroup) {
  if (props.disabled)
    return
  const next = new Set(draftSelection.value)
  const { checked } = getGroupCheckState(group)
  if (checked) {
    for (const tool of group.tools)
      next.delete(tool.id)
  }
  else {
    for (const tool of group.tools)
      next.add(tool.id)
  }
  draftSelection.value = next
}

function toggleCollapse(groupKey: string) {
  const next = new Set(collapsedGroups.value)
  if (next.has(groupKey))
    next.delete(groupKey)
  else
    next.add(groupKey)
  collapsedGroups.value = next
}

function selectAll() {
  draftSelection.value = new Set(props.toolCatalog.map(t => t.id))
}

function deselectAll() {
  draftSelection.value = new Set()
}

function confirm() {
  emit('save', [...draftSelection.value])
  emit('update:show', false)
}

function groupIcon(kind: ToolGroup['kind']) {
  if (kind === 'mcp')
    return PlugConnected20Regular
  if (kind === 'plugin')
    return PuzzlePiece20Regular
  return AppFolder20Regular
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="labels.configureTools"
    :bordered="false"
    :mask-closable="!disabled"
    :close-on-esc="!disabled"
    :closable="!disabled"
    class="w-[min(680px,calc(100vw-32px))] buddy-tool-dialog"
    @update:show="emit('update:show', $event)"
  >
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <NInput
          v-model:value="searchQuery"
          size="small"
          class="flex-1"
          clearable
          :placeholder="labels.searchTools"
        >
          <template #prefix>
            <DesktopIcon :component="Search20Regular" class="text-muted" />
          </template>
        </NInput>
        <div class="flex shrink-0 items-center gap-2">
          <NButton size="small" quaternary :disabled="disabled" @click="selectAll">
            {{ labels.selectAll }}
          </NButton>
          <NButton size="small" quaternary :disabled="disabled" @click="deselectAll">
            {{ labels.deselectAll }}
          </NButton>
        </div>
      </div>

      <NScrollbar class="max-h-[min(56vh,480px)] pr-2">
        <div class="flex flex-col gap-3 pt-1.5 px-1 pb-2">
          <div
            v-for="group in filteredGroups"
            :key="group.key"
            class="rounded-[0.5rem] border border-solid border-border bg-subtle transition-colors"
          >
            <div
              class="flex cursor-pointer items-center justify-between gap-2 px-3 py-2.5 select-none hover:bg-hover rounded-t-[0.5rem]"
              :class="{ 'rounded-b-[0.5rem]': collapsedGroups.has(group.key) }"
              @click="toggleCollapse(group.key)"
            >
              <div class="flex items-center gap-2.5 min-w-0" @click.stop>
                <NCheckbox
                  :checked="getGroupCheckState(group).checked"
                  :indeterminate="getGroupCheckState(group).indeterminate"
                  :disabled="disabled"
                  @update:checked="toggleGroup(group)"
                />
                <DesktopIcon :component="groupIcon(group.kind)" class="text-muted shrink-0" />
                <span class="truncate text-[13px] font-600 text-fg">{{ group.title }}</span>
                <NTag size="tiny" :bordered="false" class="shrink-0 uppercase">
                  {{ group.kind }}
                </NTag>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <span class="text-[12px] text-muted tabular-nums">
                  {{ group.tools.filter(t => draftSelection.has(t.id)).length }}/{{ group.tools.length }}
                </span>
                <DesktopIcon
                  :component="collapsedGroups.has(group.key) ? ChevronRight20Regular : ChevronDown20Regular"
                  class="text-muted text-[13px]"
                />
              </div>
            </div>

            <div
              v-show="!collapsedGroups.has(group.key)"
              class="grid grid-cols-2 gap-2 border-t border-t-solid border-t-border px-3 py-2.5 bg-surface"
            >
              <div
                v-for="tool in group.tools"
                :key="tool.id"
                class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-hover transition-colors"
                @click="toggleTool(tool.id)"
              >
                <NCheckbox
                  :checked="draftSelection.has(tool.id)"
                  :disabled="disabled"
                  @click.stop
                  @update:checked="toggleTool(tool.id)"
                />
                <div class="min-w-0 flex-1">
                  <div class="truncate font-mono text-[12px] font-600 text-fg">
                    {{ tool.name }}
                  </div>
                  <div v-if="tool.title && tool.title !== tool.name" class="truncate text-[11px] text-muted">
                    {{ tool.title }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-if="!filteredGroups.length" class="py-8 text-center text-[13px] text-muted">
            {{ labels.unavailableChoice }}
          </div>
        </div>
      </NScrollbar>
    </div>

    <template #action>
      <div class="flex items-center justify-between w-full">
        <span class="text-[12px] text-muted">
          {{ labels.toolsCount(draftSelection.size, groups.filter(g => g.tools.some(t => draftSelection.has(t.id))).length) }}
        </span>
        <div class="flex items-center gap-2">
          <NButton size="small" :disabled="disabled" @click="emit('update:show', false)">
            {{ labels.cancel }}
          </NButton>
          <NButton size="small" type="primary" :disabled="disabled" @click="confirm">
            {{ labels.confirm }}
          </NButton>
        </div>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.buddy-tool-dialog {
  :deep(.n-card-header) {
    padding: 16px 20px 12px;
  }
  :deep(.n-card__content) {
    padding: 0 20px 16px;
  }
  :deep(.n-card__action) {
    padding: 12px 20px;
  }
}
</style>
