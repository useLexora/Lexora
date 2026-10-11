<script setup lang="ts">
import type { WebSearchSource } from '@buddy-shared/network/webProtocol'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useSortable } from '@dnd-kit/vue/sortable'
import { Info16Regular, ReOrderDotsVertical20Regular } from '@vicons/fluent'
import { NButton, NSwitch, NTooltip } from 'naive-ui'
import { shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ source: Readonly<WebSearchSource>, index: number, disabled: boolean, language: BuddyLocale }>()
const emit = defineEmits<{ toggle: [enabled: boolean] }>()
const { t } = useBuddyI18n(() => props.language)
const element = shallowRef<HTMLElement | null>(null)
const handle = shallowRef<InstanceType<typeof NButton> | null>(null)
useSortable({ id: () => props.source.provider, index: () => props.index, disabled: () => props.disabled, element, handle })
</script>

<template>
  <li ref="element" class="desktop-web-search__row relative flex items-center gap-[0.8rem] min-h-13 pt-[0.65rem] pr-4 pb-[0.65rem] pl-[0.65rem] border-b-1 border-b-solid border-b-border last:border-b-0" :data-provider="source.provider">
    <NButton ref="handle" class="desktop-web-search__handle" quaternary :aria-label="t('desktop.web.reorderSource', { name: t(`desktop.web.${source.provider}`) })" aria-describedby="web-search-order-help" :aria-disabled="disabled">
      <DesktopIcon :component="ReOrderDotsVertical20Regular" />
    </NButton>
    <div class="desktop-web-search__name flex items-center gap-1 min-w-0 flex-1">
      <strong :id="`web-search-${source.provider}`">{{ t(`desktop.web.${source.provider}`) }}</strong>
      <NTooltip :delay="200" style="max-width: 18rem">
        <template #trigger>
          <NButton class="desktop-web-search__info" quaternary :aria-label="t('desktop.web.sourceInfo', { name: t(`desktop.web.${source.provider}`) })">
            <DesktopIcon :component="Info16Regular" />
          </NButton>
        </template>
        {{ t(`desktop.web.${source.provider}SearchDescription`) }}
      </NTooltip>
    </div>
    <NSwitch :round="false" :aria-labelledby="`web-search-${source.provider}`" :value="source.enabled" :disabled="disabled" @update:value="emit('toggle', $event)" />
  </li>
</template>

<style scoped lang="scss">
.desktop-web-search__row {
  &[data-dnd-dragging] {
    background: var(--buddy-surface-raised);
    border-radius: 0.5rem;
    outline: 1px solid var(--buddy-border-strong);
    box-shadow: 0 4px 12px rgb(0 0 0 / 10%);
    cursor: grabbing;
  }
  &[data-dnd-placeholder] {
    visibility: visible;
    background: var(--buddy-accent-surface-subtle);
    > * { visibility: hidden; }
  }
}
.desktop-web-search__handle { width: 1.8rem; height: 1.8rem; flex: none; padding: 0; color: var(--buddy-text-secondary); cursor: grab; border-radius: 6px; touch-action: none; }
.desktop-web-search__handle[aria-disabled='true'] { opacity: 0.5; cursor: default; }
.desktop-web-search__name strong { font-size: 0.8rem; font-weight: 500; }
.desktop-web-search__info { width: 1.5rem; height: 1.5rem; flex: none; padding: 0; color: var(--buddy-text-secondary); border-radius: 6px; }
</style>
