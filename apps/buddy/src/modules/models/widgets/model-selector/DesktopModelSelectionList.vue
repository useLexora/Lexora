<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ArrowDown16Regular, ArrowUp16Regular, Dismiss16Regular } from '@vicons/fluent'
import { NButton, NTooltip } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  items: readonly { id: string, label: string, source: string, unavailable: boolean }[]
  disabled?: boolean
  language: BuddyLocale
  ordered: boolean
  label?: string
}>()
const emit = defineEmits<{ remove: [id: string], move: [index: number, direction: -1 | 1] }>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <div class="desktop-model-selection-list shrink-0 border-b border-b-solid border-b-border p-2">
    <div class="mb-1 px-1 text-xs text-muted">
      {{ label ?? t('desktop.models.selection.selected') }}
    </div>
    <ol class="m-0 grid max-h-36 list-none gap-1 overflow-y-auto p-0">
      <li v-for="(item, index) in items" :key="item.id" class="flex min-w-0 items-center gap-2 rounded-micro bg-subtle px-2 py-1.5">
        <span v-if="ordered" class="w-4 shrink-0 text-center text-xs text-muted">{{ index + 1 }}</span>
        <div class="grid min-w-0 flex-1 gap-0.5">
          <span class="truncate text-xs" :class="item.unavailable ? 'text-muted' : 'text-fg'">{{ item.label }}</span>
          <span class="truncate text-[0.65rem] text-muted">{{ item.unavailable ? t('provider.status.unavailable') : item.source }}</span>
        </div>
        <div class="flex shrink-0 items-center gap-0.5">
          <template v-if="ordered && items.length > 1">
            <NTooltip>
              <template #trigger>
                <NButton quaternary size="tiny" class="buddy-icon-button" :disabled="disabled || index === 0" :aria-label="t('desktop.models.selection.moveUp', { name: item.label })" @click="emit('move', index, -1)">
                  <template #icon>
                    <DesktopIcon :component="ArrowUp16Regular" />
                  </template>
                </NButton>
              </template>
              {{ t('desktop.models.selection.moveUp', { name: item.label }) }}
            </NTooltip>
            <NTooltip>
              <template #trigger>
                <NButton quaternary size="tiny" class="buddy-icon-button" :disabled="disabled || index === items.length - 1" :aria-label="t('desktop.models.selection.moveDown', { name: item.label })" @click="emit('move', index, 1)">
                  <template #icon>
                    <DesktopIcon :component="ArrowDown16Regular" />
                  </template>
                </NButton>
              </template>
              {{ t('desktop.models.selection.moveDown', { name: item.label }) }}
            </NTooltip>
          </template>
          <NTooltip>
            <template #trigger>
              <NButton quaternary size="tiny" class="buddy-icon-button" :disabled="disabled" :aria-label="t('desktop.models.selection.remove', { name: item.label })" @click="emit('remove', item.id)">
                <template #icon>
                  <DesktopIcon :component="Dismiss16Regular" />
                </template>
              </NButton>
            </template>
            {{ t('desktop.models.selection.remove', { name: item.label }) }}
          </NTooltip>
        </div>
      </li>
    </ol>
  </div>
</template>
