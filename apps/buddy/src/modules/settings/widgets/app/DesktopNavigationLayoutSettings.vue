<script setup lang="ts">
import type { ApplicationSettingsProps } from './typing'
import { DESKTOP_NAVIGATION_LAYOUTS } from '@buddy-electron/shared/desktopApi'
import { Checkmark20Regular } from '@vicons/fluent'
import { NRadio, NRadioGroup, useMessage } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'

const props = defineProps<ApplicationSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const { pending, save } = useSettingMutation<'navigationLayout'>(
  patch => props.updateSettings(patch),
  () => message.error(t('desktop.settings.saveFailed')),
)
const options = computed(() => DESKTOP_NAVIGATION_LAYOUTS.map(value => ({
  value,
  label: t(`desktop.settings.navigationLayout.${value}`),
  description: t(`desktop.settings.navigationLayout.${value}Description`),
})))
const saving = computed(() => pending.value.has('navigationLayout'))

function select(value: string | number | boolean) {
  const navigationLayout = DESKTOP_NAVIGATION_LAYOUTS.find(layout => layout === value)
  if (navigationLayout && navigationLayout !== props.config?.desktop.navigationLayout)
    return save('navigationLayout', { desktop: { navigationLayout } })
}
</script>

<template>
  <DesktopSettingsGroup v-if="config" class="desktop-navigation-layout-settings">
    <DesktopSettingRow
      v-slot="{ controlAttrs }"
      class="desktop-navigation-layout-settings__row"
      :label="t('desktop.settings.navigationLayout')"
      :description="t('desktop.settings.navigationLayoutDescription')"
    >
      <NRadioGroup
        v-bind="controlAttrs"
        role="radiogroup"
        class="desktop-navigation-layout-settings__options grid min-w-0 gap-3"
        :value="config.desktop.navigationLayout"
        :disabled="saving"
        :aria-disabled="saving"
        :aria-busy="saving"
        @update:value="select"
      >
        <NRadio
          v-for="option in options"
          :key="option.value"
          :value="option.value"
          :theme-overrides="{ labelPadding: '0' }"
          class="desktop-navigation-layout-settings__card min-w-0 border border-solid rounded-[0.5rem] p-3 transition-state-colors"
          :class="[
            config.desktop.navigationLayout === option.value ? 'border-accent bg-accent-subtle ring-1 ring-accent' : 'border-border hover:bg-hover',
            { 'opacity-60': saving },
          ]"
          :aria-disabled="saving"
        >
          <span class="grid min-w-0 gap-2">
            <span aria-hidden="true" class="flex h-20 overflow-hidden border border-solid border-border rounded-micro bg-canvas">
              <span
                v-if="option.value !== 'immersive'"
                class="grid shrink-0 content-start gap-1 border-r border-r-solid border-r-border bg-app-sidebar p-1.5"
                :class="option.value === 'full' ? 'w-[30%]' : 'w-5'"
              >
                <span v-for="item in 3" :key="item" class="flex items-center gap-1">
                  <span class="h-1.5 w-1.5 shrink-0 rounded-[1px] bg-muted" />
                  <span v-if="option.value === 'full'" class="h-1 min-w-0 flex-1 bg-border-strong" />
                </span>
              </span>
              <span class="flex w-[34%] shrink-0 flex-col gap-1 border-r border-r-solid border-r-border bg-workspace-sidebar p-1.5">
                <span class="mb-1 h-1 w-2/3 bg-muted" />
                <span v-for="item in 3" :key="item" class="h-1 w-full bg-border-strong" />
                <span v-if="option.value === 'immersive'" class="mt-auto flex justify-between gap-1 pt-2">
                  <span v-for="item in 3" :key="item" class="h-1.5 w-1.5 rounded-[1px] bg-muted" />
                </span>
              </span>
              <span class="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 p-1.5">
                <span class="h-1 w-2/3 bg-border-strong" />
                <span class="h-1 w-full bg-border" />
                <span class="mt-1 h-3 w-full border border-solid border-border rounded-[2px]" />
              </span>
            </span>
            <span class="flex min-h-5 items-center justify-between gap-2">
              <strong class="text-[0.8rem] font-600" :class="config.desktop.navigationLayout === option.value ? 'text-accent-text' : 'text-fg'">{{ option.label }}</strong>
              <span v-if="config.desktop.navigationLayout === option.value" aria-hidden="true" class="grid size-5 flex-none place-items-center rounded-micro bg-accent text-on-accent">
                <DesktopIcon :component="Checkmark20Regular" :size="14" />
              </span>
            </span>
            <span class="text-[0.7rem] text-muted leading-[1.5]">{{ option.description }}</span>
          </span>
        </NRadio>
      </NRadioGroup>
    </DesktopSettingRow>
  </DesktopSettingsGroup>
</template>

<style scoped lang="scss">
.desktop-navigation-layout-settings {
  .desktop-navigation-layout-settings__row {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.75rem;
  }

  .desktop-navigation-layout-settings__options {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .desktop-navigation-layout-settings__card:has(input:focus-visible) {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: 3px;
  }

  .desktop-navigation-layout-settings__card :deep(.n-radio__dot-wrapper) {
    width: 0;
  }

  .desktop-navigation-layout-settings__card :deep(.n-radio__dot) {
    display: none;
  }

  .desktop-navigation-layout-settings__card :deep(.n-radio__label) {
    min-width: 0;
    flex: 1;
  }

  @container (max-width: 560px) {
    .desktop-navigation-layout-settings__options {
      grid-template-columns: minmax(0, 1fr);
    }
  }
}
</style>
