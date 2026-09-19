<script setup lang="ts">
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'

import type { InputInst } from 'naive-ui'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { TaskSpaceInput } from '@/modules/tasks/state/task-index/typing'
import {
  Checkmark16Regular,
  ChevronDown16Regular,
  FolderAdd16Regular,
  Search16Regular,
} from '@vicons/fluent'
import { NButton, NInput, NPopover } from 'naive-ui'
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopSpaceIcon from '@/modules/tasks/widgets/space/DesktopSpaceIcon.vue'
import DesktopSpaceDialog from '@/modules/tasks/widgets/task-index/DesktopSpaceDialog.vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  activeSpace: LocalSpace | null
  language: BuddyLocale
  spaces: ReadonlyArray<LocalSpace>
  selectDirectory: () => Promise<string | null>
  createSpace: (input: TaskSpaceInput) => Promise<boolean>
}>()

const emit = defineEmits<{
  selectSpace: [spaceId: string | null]
}>()

const { t } = useBuddyI18n(() => props.language)
const panelOpen = shallowRef(false)
const spaceDialogOpen = shallowRef(false)
const query = shallowRef('')
const searchInput = useTemplateRef<InputInst>('searchInput')
const activeSpaces = computed(() => props.spaces.filter(space => space.revokedAt === null))
const visibleSpaces = computed(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase()
  if (!normalizedQuery)
    return activeSpaces.value
  return activeSpaces.value.filter(space => (
    space.name.toLocaleLowerCase().includes(normalizedQuery)
  ))
})
const triggerLabel = computed(() => props.activeSpace?.name ?? t('desktop.tasks.spaceSelect'))

watch(panelOpen, async (open) => {
  if (!open)
    return
  query.value = ''
  await nextTick()
  searchInput.value?.focus()
})

function selectSpace(spaceId: string) {
  panelOpen.value = false
  if (spaceId !== props.activeSpace?.id)
    emit('selectSpace', spaceId)
}

function clearSpace() {
  panelOpen.value = false
  emit('selectSpace', null)
}

function openSpaceCreator() {
  panelOpen.value = false
  spaceDialogOpen.value = true
}
</script>

<template>
  <div class="desktop-task-space-selector">
    <NPopover
      class="buddy-raw-popover"
      raw
      :show="panelOpen"
      :show-arrow="false"
      placement="top-start"
      to=".buddy-app"
      trigger="click"
      @update:show="panelOpen = $event"
    >
      <template #trigger>
        <NButton
          class="desktop-task-space-selector__trigger"
          quaternary
          size="small"
          aria-haspopup="dialog"
          :aria-label="triggerLabel"
          :aria-expanded="panelOpen"
        >
          <DesktopSpaceIcon class="desktop-task-space-selector__icon" :icon="activeSpace?.icon" :icon-color="activeSpace?.iconColor" :size="16" />
          <span class="desktop-task-space-selector__label">{{ triggerLabel }}</span>
          <DesktopIcon
            class="desktop-task-space-selector__chevron"
            :class="{ 'is-open': panelOpen }"
            :component="ChevronDown16Regular"
            :size="16"
          />
        </NButton>
      </template>

      <section
        class="desktop-task-space-selector__panel"
        role="dialog"
        :aria-label="t('desktop.tasks.spaceSelect')"
      >
        <div class="desktop-task-space-selector__search">
          <NInput
            ref="searchInput"
            v-model:value="query"
            clearable
            size="small"
            :placeholder="t('desktop.tasks.spaceSearch')"
          >
            <template #prefix>
              <DesktopIcon class="desktop-task-space-selector__icon" :component="Search16Regular" :size="16" />
            </template>
          </NInput>
        </div>

        <div class="desktop-task-space-selector__spaces" role="listbox">
          <button
            v-for="space in visibleSpaces"
            :key="space.id"
            class="desktop-task-space-selector__space"
            :class="{ 'is-selected': activeSpace?.id === space.id }"
            type="button"
            role="option"
            :aria-selected="activeSpace?.id === space.id"
            @click="selectSpace(space.id)"
          >
            <DesktopSpaceIcon class="desktop-task-space-selector__icon" :icon="space.icon" :icon-color="space.iconColor" :size="16" />
            <span>{{ space.name }}</span>
            <DesktopIcon
              v-if="activeSpace?.id === space.id"
              class="desktop-task-space-selector__icon"
              :component="Checkmark16Regular"
              :size="16"
            />
          </button>
          <span v-if="!visibleSpaces.length" class="desktop-task-space-selector__empty">
            {{ t('desktop.tasks.spaceSearchEmpty') }}
          </span>
        </div>

        <div class="desktop-task-space-selector__divider" role="separator" />
        <button
          class="desktop-task-space-selector__action desktop-task-space-selector__create"
          type="button"
          @click="openSpaceCreator"
        >
          <DesktopIcon class="desktop-task-space-selector__icon" :component="FolderAdd16Regular" :size="16" />
          <span>{{ t('desktop.tasks.createSpaceTitle') }}</span>
        </button>

        <template v-if="activeSpace">
          <div class="desktop-task-space-selector__divider" role="separator" />
          <button
            class="desktop-task-space-selector__action desktop-task-space-selector__clear"
            type="button"
            @click="clearSpace"
          >
            <DesktopIcon class="desktop-task-space-selector__icon" name="spaceNone" />
            <span>{{ t('desktop.tasks.spaceNone') }}</span>
          </button>
        </template>
      </section>
    </NPopover>

    <DesktopSpaceDialog
      v-model:show="spaceDialogOpen"
      :language="language"
      :space="null"
      :select-directory="selectDirectory"
      :save="createSpace"
    />
  </div>
</template>

<style scoped lang="scss">
.desktop-task-space-selector {
  display: inline-flex;
  min-width: 0;
  flex: none;
  align-items: center;

  @container desktop-chat-composer (max-width: 21rem) {
    display: none;
  }
}

.desktop-task-space-selector__trigger {
  max-width: min(14rem, 40cqw);
  min-width: 0;
  height: var(--buddy-composer-control-height);
  border-radius: var(--buddy-composer-control-radius);
  background-color: transparent;
  color: var(--buddy-text-secondary);
  transition:
    background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing),
    color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);

  &.n-button:not(.n-button--disabled):hover,
  &.n-button:not(.n-button--disabled):focus-visible {
    background-color: var(--buddy-accent-surface-subtle);
    color: var(--buddy-text-strong);
  }

  &.n-button:not(.n-button--disabled)[aria-expanded='true'] {
    background-color: var(--buddy-accent-surface);
    color: var(--buddy-text-strong);
  }

  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }

  :deep(.n-button__content) {
    min-width: 0;
    gap: 0.3rem;
  }

  span {
    overflow: hidden;
    min-width: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @container desktop-chat-composer (max-width: 30rem) {
    width: var(--buddy-composer-control-height);
    min-width: var(--buddy-composer-control-height);
    max-width: var(--buddy-composer-control-height);
    padding: 0;

    :deep(.n-button__content) {
      gap: 0;
    }
  }
}

.desktop-task-space-selector__label,
.desktop-task-space-selector__chevron {
  @container desktop-chat-composer (max-width: 30rem) {
    display: none;
  }
}

.desktop-task-space-selector__chevron {
  flex: none;
  font-size: 14px;
  transition: transform 120ms ease;

  &.is-open {
    transform: rotate(180deg);
  }
}

.desktop-task-space-selector__panel {
  width: min(12rem, calc(100vw - 2rem));
  overflow: hidden;
  border: 1px solid var(--buddy-border-subtle);
  border-radius: var(--buddy-menu-radius);
  background: var(--buddy-surface-raised);
  box-shadow: var(--buddy-shadow-overlay);
  color: var(--buddy-text-strong);
  padding: 8px;
}

.desktop-task-space-selector__search {
  padding-bottom: 5px;
}

.desktop-task-space-selector__search :deep(.n-input) {
  border-radius: var(--buddy-radius-micro);
}

.desktop-task-space-selector__spaces {
  display: grid;
  max-height: calc(var(--buddy-menu-row-height) * 5 + var(--buddy-menu-row-gap) * 4);
  align-content: start;
  gap: var(--buddy-menu-row-gap);
  overflow-y: auto;
  scrollbar-color: var(--buddy-border-strong) transparent;
  scrollbar-width: thin;

  &::-webkit-scrollbar {
    width: 0.35rem;
  }

  &::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background: var(--buddy-border-strong);
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }

  &::-webkit-scrollbar-button {
    display: none;
  }
}

.desktop-task-space-selector__space,
.desktop-task-space-selector__action {
  display: grid;
  width: 100%;
  min-width: 0;
  height: var(--buddy-menu-row-height);
  grid-template-columns: var(--buddy-menu-icon-size) minmax(0, 1fr) var(--buddy-menu-icon-size);
  align-items: center;
  gap: 7px;
  border: 0;
  border-radius: var(--buddy-menu-item-radius);
  background: transparent;
  color: var(--buddy-text-primary);
  cursor: pointer;
  font: inherit;
  font-size: var(--buddy-sidebar-space-font-size);
  padding: 0 7px;
  text-align: left;
  transition:
    background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing),
    color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);

  > span {
    overflow: hidden;
    min-width: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &:hover {
    background: var(--buddy-nav-hover);
    color: var(--buddy-text-strong);
  }

  &:focus-visible {
    background: var(--buddy-nav-hover);
    color: var(--buddy-text-strong);
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }
}

.desktop-task-space-selector__space.is-selected {
  background: var(--buddy-nav-selected);
  color: var(--buddy-nav-foreground);
  font-weight: 600;
}

.desktop-task-space-selector__space.is-selected:hover {
  background: var(--buddy-nav-pressed);
  color: var(--buddy-nav-foreground);
}

.desktop-task-space-selector__space.is-selected:focus-visible {
  background: var(--buddy-nav-selected);
  color: var(--buddy-nav-foreground);
}

.desktop-task-space-selector__action {
  grid-template-columns: var(--buddy-menu-icon-size) minmax(0, 1fr);
}

.desktop-task-space-selector__icon {
  width: var(--buddy-menu-icon-size);
  height: var(--buddy-menu-icon-size);
  font-size: var(--buddy-menu-icon-size);
}

.desktop-task-space-selector__divider {
  height: 1px;
  background: var(--buddy-border-subtle);
  margin: 5px 6px;
}

.desktop-task-space-selector__empty {
  display: grid;
  min-height: var(--buddy-menu-row-height);
  place-items: center;
  color: var(--buddy-text-muted);
  font-size: 0.72rem;
}
</style>
