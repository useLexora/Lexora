<script setup lang="ts">
import type { LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import type { DropdownOption } from 'naive-ui'
import {
  ArrowReset20Regular,
  ChevronDown16Regular,
  Edit16Regular,
  Star16Regular,
} from '@vicons/fluent'
import { NButton, NDropdown, NTag } from 'naive-ui'
import { computed, h, shallowRef } from 'vue'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { buddyLabels } from '../buddyLabels'
import BuddyAvatar from './BuddyAvatar.vue'

const props = defineProps<{
  buddy: LocalBuddy
  disabled: boolean
  isDefault: boolean
  isBuiltin: boolean
}>()

const emit = defineEmits<{
  setDefault: []
  edit: []
  resetProfile: []
}>()

const { language } = useDesktopUi()
const labels = computed(() => buddyLabels(language.value))
const menuOpen = shallowRef(false)

const actions = computed<DropdownOption[]>(() => {
  const items: DropdownOption[] = []
  if (!props.isDefault && props.buddy.kind === 'actor' && props.buddy.enabled) {
    items.push({
      key: 'default',
      label: labels.value.setDefault,
      disabled: props.disabled,
      props: { role: 'menuitem' },
      icon: () => h(DesktopIcon, { component: Star16Regular, size: 16 }),
    })
  }
  if (props.isBuiltin) {
    if (items.length)
      items.push({ type: 'divider', key: 'divider' })
    items.push({
      key: 'resetProfile',
      label: labels.value.resetProfile,
      disabled: props.disabled,
      props: { role: 'menuitem' },
      icon: () => h(DesktopIcon, { component: ArrowReset20Regular, size: 16 }),
    })
  }
  return items
})

function handleSelect(key: string) {
  if (props.disabled)
    return
  if (key === 'default')
    emit('setDefault')
  else if (key === 'resetProfile')
    emit('resetProfile')
}
</script>

<template>
  <section class="buddy-profile-card relative isolate overflow-hidden flex flex-wrap items-center gap-4 rounded-[0.65rem] border border-solid border-border bg-surface p-5" data-testid="buddy-profile-card">
    <BuddyAvatar :buddy-id="buddy.id" :src="buddy.avatar" class="relative size-16" data-testid="buddy-profile-avatar" />
    <div class="relative min-w-0 flex-1 basis-40">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="m-0 mr-1 text-[22px] leading-tight font-600 text-fg break-words">
          {{ buddy.name }}
        </h2>
        <NTag size="small" :bordered="false">
          {{ buddy.kind === 'actor' ? labels.actor : labels.npc }}
        </NTag>
        <NTag v-if="isDefault" size="small" :bordered="false" type="primary">
          {{ labels.default }}
        </NTag>
      </div>
      <p v-if="buddy.description" class="m-0 mt-2 text-[13px] text-muted leading-relaxed whitespace-pre-wrap break-words">
        {{ buddy.description }}
      </p>
    </div>

    <div class="buddy-profile-card__split-actions relative ml-auto inline-flex items-stretch" :class="{ 'has-menu': actions.length }">
      <NButton
        size="small"
        type="primary"
        :disabled="disabled"
        @click="emit('edit')"
      >
        <template #icon>
          <DesktopIcon :component="Edit16Regular" :size="16" />
        </template>
        {{ labels.edit }}
      </NButton>

      <NDropdown
        v-if="actions.length"
        v-model:show="menuOpen"
        trigger="click"
        placement="bottom-end"
        :options="actions"
        :disabled="disabled"
        @select="handleSelect"
      >
        <NButton
          class="buddy-icon-button buddy-profile-card__split-arrow"
          size="small"
          type="primary"
          :disabled="disabled"
          :aria-label="labels.more"
          aria-haspopup="menu"
          :aria-expanded="menuOpen"
        >
          <template #icon>
            <DesktopIcon
              :component="ChevronDown16Regular"
              :size="14"
              class="buddy-profile-card__split-chevron"
              :class="{ 'is-open': menuOpen }"
            />
          </template>
        </NButton>
      </NDropdown>
    </div>
  </section>
</template>

<style scoped lang="scss">
.buddy-profile-card {
  background-image: radial-gradient(ellipse at 0% 50%, color-mix(in srgb, var(--buddy-accent-solid) 10%, transparent), transparent 65%);

  &::before,
  &::after {
    content: '';
    position: absolute;
    z-index: -1;
    pointer-events: none;
    width: 220px;
    height: 220px;
    border: 1px solid color-mix(in srgb, var(--buddy-accent-solid) 15%, transparent);
    border-radius: 50%;
  }

  &::before {
    top: -84px;
    right: 90px;
  }

  &::after {
    top: -34px;
    right: 20px;
  }
}

.buddy-profile-card__split-actions.has-menu > :deep(.n-button:first-child) {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}

.buddy-profile-card__split-arrow {
  width: 28px;
  margin-left: 1px;
  padding: 0;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

.buddy-profile-card__split-chevron {
  transition: transform 140ms ease;

  &.is-open {
    transform: rotate(180deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .buddy-profile-card__split-chevron {
    transition: none;
  }
}
</style>
