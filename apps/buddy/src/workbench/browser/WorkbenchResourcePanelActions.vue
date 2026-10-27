<script setup lang="ts">
import type { DropdownOption } from 'naive-ui'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Dismiss20Regular, MoreHorizontal20Regular } from '@vicons/fluent'
import { NDropdown, NTooltip } from 'naive-ui'
import { computed, h, nextTick, shallowRef, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ language: BuddyLocale, maximized: boolean, onLeft: boolean, canSwap: boolean }>()
const emit = defineEmits<{ swap: [], toggleMaximize: [], close: [] }>()
const { t } = useBuddyI18n(() => props.language)
const menuOpen = shallowRef(false)
const menuButton = useTemplateRef<HTMLButtonElement>('menuButton')
const position = computed(() => props.onLeft ? 'left' : 'right')
const options = computed<DropdownOption[]>(() => [
  ...(props.canSwap && !props.maximized
    ? [
        {
          key: 'swap',
          label: t(props.onLeft ? 'desktop.context.moveToRight' : 'desktop.context.moveToLeft'),
          icon: () => h(DesktopIcon, { class: 'text-accent-text' }, {
            default: () => h('svg', {
              'viewBox': '0 0 24 24',
              'fill': 'none',
              'stroke': 'currentColor',
              'stroke-width': 1.5,
              'stroke-linecap': 'round',
              'stroke-linejoin': 'round',
              'aria-hidden': true,
            }, [
              h('path', { d: 'M4 8h16m-4-4 4 4-4 4', opacity: props.onLeft ? 1 : 0.4 }),
              h('path', { d: 'M20 16H4m4-4-4 4 4 4', opacity: props.onLeft ? 0.4 : 1 }),
            ]),
          }),
          props: { role: 'menuitem' },
        },
        { type: 'divider', key: 'separator' },
      ]
    : []),
  {
    key: 'close',
    label: t('desktop.context.close'),
    icon: () => h(DesktopIcon, { component: Dismiss20Regular }),
    props: { role: 'menuitem' },
  },
])

async function select(key: string | number) {
  if (key === 'close') {
    emit('close')
    return
  }
  if (key === 'swap')
    emit('swap')
  await nextTick()
  menuButton.value?.focus({ preventScroll: true })
}
</script>

<template>
  <NTooltip :delay="350">
    <template #trigger>
      <button class="workbench-resource-panel-action grid w-8 h-8 flex-none place-items-center p-0 border-0 rounded-icon bg-transparent text-muted cursor-pointer hover:(bg-hover text-strong) ui-focus-ring" data-testid="context-panel-maximize" type="button" :aria-label="t(maximized ? 'desktop.context.restore' : 'desktop.context.maximize')" :aria-pressed="maximized" @click="emit('toggleMaximize')">
        <DesktopIcon :size="16">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path :d="maximized ? 'm4 20 6-6m-6 0h6v6m10-16-6 6m0-6v6h6' : 'M14 4h6v6m0-6-6 6M4 14v6h6m-6 0 6-6'" />
          </svg>
        </DesktopIcon>
      </button>
    </template>
    {{ t(maximized ? 'desktop.context.restore' : 'desktop.context.maximize') }}
  </NTooltip>
  <NDropdown :key="`${position}-${maximized}`" v-model:show="menuOpen" trigger="click" placement="bottom-end" :options="options" @select="select">
    <NTooltip :delay="350" :disabled="menuOpen">
      <template #trigger>
        <button ref="menuButton" class="workbench-resource-panel-action grid w-8 h-8 flex-none place-items-center p-0 border-0 rounded-icon cursor-pointer hover:(bg-hover text-strong) ui-focus-ring" :class="menuOpen ? 'bg-hover text-strong' : 'bg-transparent text-muted'" data-testid="context-panel-more" type="button" :aria-label="t('desktop.context.moreActions')" :aria-expanded="menuOpen" aria-haspopup="menu">
          <DesktopIcon :component="MoreHorizontal20Regular" :size="16" />
        </button>
      </template>
      {{ t('desktop.context.moreActions') }}
    </NTooltip>
  </NDropdown>
</template>
