<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { TASK_MARK_COLORS } from '@buddy-shared/conversation/taskMarkApi'
import { buddyColorThemes } from '@buddy-shared/theme/buddyTheme'
import { ChevronDown16Regular, Color20Regular } from '@vicons/fluent'
import { NButton, NColorPicker, NPopover } from 'naive-ui'
import { nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopColorPalette from '@/shared/ui/color-picker/DesktopColorPalette.vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ disabled?: boolean, readonly?: boolean, language: BuddyLocale }>()
const color = defineModel<string>({ required: true })
const { t } = useBuddyI18n(() => props.language)
const open = shallowRef(false)
const trigger = useTemplateRef('trigger')
const panel = useTemplateRef('panel')
const options = [TASK_MARK_COLORS[0], ...Object.values(buddyColorThemes.light.spaceIcon)].map(value => ({ value, color: value }))

watch(open, async (value) => {
  if (value) {
    await nextTick()
    if (open.value)
      panel.value?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()
  }
})
watch(() => props.disabled || props.readonly, (disabled) => {
  if (disabled)
    open.value = false
})

function close() {
  open.value = false
  trigger.value?.$el.focus()
}

function select(value: string) {
  color.value = value
  close()
}

function updateCustom(value: string | null) {
  if (value)
    color.value = value.toLowerCase()
}

function handleCustomEnter(event: KeyboardEvent) {
  if (event.target instanceof HTMLInputElement) {
    event.preventDefault()
    event.stopPropagation()
  }
}
</script>

<template>
  <span v-if="readonly" class="inline-block w-[20px] h-[20px] border border-solid border-border rounded-[6px]" :style="{ backgroundColor: color }" />
  <NPopover v-else v-model:show="open" :disabled="disabled" :show-arrow="false" placement="bottom-start" trigger="click" :to="false">
    <template #trigger>
      <NButton ref="trigger" class="desktop-task-mark-color-picker__trigger" :disabled="disabled" :aria-expanded="open" aria-haspopup="dialog" @keydown.esc.stop.prevent="close">
        <span class="desktop-task-mark-color-picker__preview inline-block h-[20px] w-[20px] border border-solid border-border-subtle rounded-[6px]" :style="{ backgroundColor: color }" />
        <span class="font-mono text-[12px]">{{ color }}</span>
        <DesktopIcon :component="ChevronDown16Regular" :size="14" />
      </NButton>
    </template>
    <section ref="panel" class="desktop-task-mark-color-picker w-[246px]" role="dialog" @keydown.esc.stop.prevent="close">
      <DesktopColorPalette :model-value="color" :options="options" :disabled="disabled" @update:model-value="select" />
      <div class="desktop-task-mark-color-picker__footer" @keydown.enter="handleCustomEnter">
        <NColorPicker :value="color" :modes="['hex']" :show-alpha="false" :actions="['confirm']" :disabled="disabled" :to="false" @update:value="updateCustom" @confirm="close">
          <template #trigger="{ onClick, ref: setTriggerRef }">
            <NButton :ref="setTriggerRef" class="desktop-task-mark-color-picker__custom" size="small" quaternary :disabled="disabled" @click="onClick">
              <template #icon>
                <DesktopIcon :component="Color20Regular" />
              </template>
              {{ t('desktop.marks.customColor') }}
            </NButton>
          </template>
        </NColorPicker>
      </div>
    </section>
  </NPopover>
</template>

<style scoped lang="scss">
.desktop-task-mark-color-picker__trigger {
  gap: 8px;
}

.desktop-task-mark-color-picker__trigger :deep(.n-button__content) {
  gap: 8px;
}

.desktop-task-mark-color-picker__footer {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--buddy-border-subtle);
}

.desktop-task-mark-color-picker__custom {
  width: 100%;
  justify-content: flex-start;
}
</style>
