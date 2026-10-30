<script setup lang="ts">
import type { DownloadProxy } from '@buddy-shared/network/downloadSettings'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { MoreHorizontal20Regular } from '@vicons/fluent'
import { NButton, NDropdown, NSwitch, NTooltip } from 'naive-ui'
import { computed, shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  proxy: Readonly<DownloadProxy>
  language: BuddyLocale
  disabled: boolean
  index: number
  last: boolean
}>()
const emit = defineEmits<{ toggle: [enabled: boolean], edit: [], remove: [], move: [direction: -1 | 1] }>()
const { t } = useBuddyI18n(() => props.language)
const labelId = useId()
const menuOpen = shallowRef(false)
const actions = computed(() => [
  { key: 'up', label: t('desktop.settings.downloads.moveUp'), disabled: props.disabled || props.index === 0 },
  { key: 'down', label: t('desktop.settings.downloads.moveDown'), disabled: props.disabled || props.last },
  { key: 'divider', type: 'divider' as const },
  { key: 'remove', label: t('desktop.settings.downloads.remove'), disabled: props.disabled },
])

function selectAction(key: string) {
  if (props.disabled)
    return
  if (key === 'up')
    emit('move', -1)
  else if (key === 'down')
    emit('move', 1)
  else if (key === 'remove')
    emit('remove')
}
</script>

<template>
  <li class="desktop-download-proxy-row grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b border-b-solid border-b-border last:border-b-0 px-[0.9rem] py-3" data-testid="download-proxy-row">
    <span class="text-center text-[0.7rem] text-muted tabular-nums" aria-hidden="true">{{ index + 1 }}</span>
    <div class="min-w-0">
      <div :id="labelId" class="break-words text-[0.8rem] font-500 text-fg">
        {{ proxy.name }}
      </div>
      <div class="mt-1 break-all font-mono text-[0.7rem] leading-relaxed text-muted">
        {{ proxy.url }}
      </div>
    </div>
    <div class="desktop-download-proxy-row__actions flex items-center gap-3">
      <NSwitch :aria-labelledby="labelId" size="small" :round="false" :value="proxy.enabled" :disabled="disabled" :aria-disabled="disabled" @update:value="emit('toggle', $event)" />
      <div class="flex items-center gap-1">
        <NButton size="small" quaternary :disabled="disabled" @click="emit('edit')">
          {{ t('desktop.settings.downloads.edit') }}
        </NButton>
        <NDropdown
          v-model:show="menuOpen" trigger="click" :options="actions" :disabled="disabled"
          :menu-props="() => ({ role: 'menu' })"
          :node-props="option => ({ 'role': 'menuitem', 'aria-disabled': option.disabled ? 'true' : 'false' })"
          @select="selectAction"
        >
          <NTooltip :delay="300">
            <template #trigger>
              <NButton size="small" quaternary class="buddy-icon-button" :disabled="disabled" :aria-label="t('desktop.settings.downloads.actions')" aria-haspopup="menu" :aria-expanded="menuOpen" data-testid="download-proxy-actions">
                <DesktopIcon :component="MoreHorizontal20Regular" :size="18" />
              </NButton>
            </template>
            {{ t('desktop.settings.downloads.actions') }}
          </NTooltip>
        </NDropdown>
      </div>
    </div>
  </li>
</template>

<style scoped lang="scss">
.desktop-download-proxy-row {
  @container (max-width: 560px) {
    grid-template-columns: 1.25rem minmax(0, 1fr);

    .desktop-download-proxy-row__actions {
      grid-column: 2;
      justify-content: end;
    }
  }
}
</style>
