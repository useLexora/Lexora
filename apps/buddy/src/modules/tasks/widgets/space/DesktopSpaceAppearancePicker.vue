<script setup lang="ts">
import type { SpaceIcon, SpaceIconColor, SpaceLinearIcon } from '@buddy-shared/spaces/spaceAppearance'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { SPACE_FILLED_ICONS, SPACE_ICON_COLORS, SPACE_LINEAR_ICONS } from '@buddy-shared/spaces/spaceAppearance'
import { NButton, NPopover, NRadioButton, NRadioGroup } from 'naive-ui'
import { computed, nextTick, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopColorPalette from '@/shared/ui/color-picker/DesktopColorPalette.vue'
import DesktopSpaceIcon from './DesktopSpaceIcon.vue'

const props = defineProps<{
  disabled?: boolean
  language: BuddyLocale
}>()
const icon = defineModel<SpaceIcon>('icon', { required: true })
const iconColor = defineModel<SpaceIconColor>('iconColor', { required: true })
const { t } = useBuddyI18n(() => props.language)
const open = defineModel<boolean>('show', { required: true })
const trigger = useTemplateRef('trigger')
const panel = useTemplateRef('panel')
const iconStyle = computed({
  get: () => icon.value.endsWith('-filled') ? 'filled' : 'linear',
  set: (style: 'linear' | 'filled') => {
    const linearIcon = icon.value.replace(/-filled$/, '') as SpaceLinearIcon
    icon.value = style === 'filled' ? `${linearIcon}-filled` : linearIcon
  },
})
const visibleIcons = computed(() => iconStyle.value === 'filled' ? SPACE_FILLED_ICONS : SPACE_LINEAR_ICONS)
const colorOptions = SPACE_ICON_COLORS.map(value => ({
  value,
  color: value === 'default' ? 'var(--buddy-text-secondary)' : `var(--buddy-space-icon-${value})`,
  reset: value === 'default',
}))

watch(open, async (value) => {
  if (!value)
    return
  await nextTick()
  if (open.value)
    panel.value?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()
})
watch(() => props.disabled, (disabled) => {
  if (disabled)
    open.value = false
})

function close() {
  open.value = false
  trigger.value?.$el.focus()
}

function reset() {
  icon.value = 'folder'
  iconColor.value = 'default'
}
</script>

<template>
  <NPopover
    v-model:show="open"
    :disabled="disabled"
    :show-arrow="false"
    placement="bottom-start"
    trigger="click"
    :to="false"
  >
    <template #trigger>
      <NButton
        ref="trigger"
        class="desktop-space-appearance-picker__trigger"
        :disabled="disabled"
        :aria-label="t('desktop.tasks.spaceAppearance')"
        :aria-expanded="open"
        aria-haspopup="dialog"
        @keydown.esc.stop.prevent="close"
      >
        <DesktopSpaceIcon :icon="icon" :icon-color="iconColor" :size="20" />
      </NButton>
    </template>
    <section
      ref="panel"
      class="desktop-space-appearance-picker w-[246px] text-fg"
      role="dialog"
      :aria-label="t('desktop.tasks.spaceAppearance')"
      @keydown.esc.stop.prevent="close"
    >
      <NRadioGroup v-model:value="iconStyle" class="desktop-space-appearance-picker__styles" :disabled="disabled" size="small">
        <NRadioButton class="desktop-space-appearance-picker__style" value="linear">
          {{ t('desktop.tasks.spaceIconLinear') }}
        </NRadioButton>
        <NRadioButton class="desktop-space-appearance-picker__style" value="filled">
          {{ t('desktop.tasks.spaceIconFilled') }}
        </NRadioButton>
      </NRadioGroup>
      <div class="grid grid-cols-[repeat(6,_36px)] gap-[6px] mb-[16px]">
        <NButton
          v-for="value in visibleIcons"
          :key="value"
          class="desktop-space-appearance-picker__option"
          :class="{ 'is-selected': icon === value }"
          quaternary
          :disabled="disabled"
          :aria-label="value"
          :data-icon="value"
          :aria-pressed="icon === value"
          @click="icon = value"
        >
          <DesktopSpaceIcon :icon="value" :icon-color="iconColor" :size="20" />
        </NButton>
      </div>
      <DesktopColorPalette v-model="iconColor" class="desktop-space-appearance-picker__colors" :options="colorOptions" :disabled="disabled" />
      <div class="flex justify-end mt-[12px] pt-[8px] border-t-1 border-t-solid border-t-border">
        <NButton size="tiny" quaternary :disabled="disabled" @click="reset">
          {{ t('desktop.tasks.spaceAppearanceReset') }}
        </NButton>
      </div>
    </section>
  </NPopover>
</template>

<style scoped lang="scss">
.desktop-space-appearance-picker__trigger {
  width: var(--n-height);
  flex: none;
  padding: 0;
  border-radius: 6px;
}

.desktop-space-appearance-picker__styles {
  display: flex;
  width: 100%;
  margin-bottom: 12px;
}

.desktop-space-appearance-picker__style {
  flex: 1;
  text-align: center;
}

.desktop-space-appearance-picker__option {
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 6px;
  color: var(--buddy-text-secondary);
}

.desktop-space-appearance-picker__option.is-selected {
  box-shadow: inset 0 0 0 1px var(--buddy-accent-border);
  background: var(--buddy-accent-surface);
}

.desktop-space-appearance-picker__colors {
  padding-top: 16px;
  border-top: 1px solid var(--buddy-border-subtle);
}
</style>
