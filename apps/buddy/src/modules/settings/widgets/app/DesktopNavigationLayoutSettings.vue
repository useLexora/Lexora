<script setup lang="ts">
import type { ApplicationSettingsProps } from './typing'
import { DESKTOP_NAVIGATION_LAYOUTS } from '@buddy-electron/shared/desktopApi'
import { useMessage } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopNavigationLayoutPicker from '../shared/DesktopNavigationLayoutPicker.vue'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'

const props = defineProps<ApplicationSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const { pending, save } = useSettingMutation<'navigationLayout'>(
  patch => props.updateSettings(patch),
  () => message.error(t('desktop.settings.saveFailed')),
)
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
      <DesktopNavigationLayoutPicker
        v-bind="controlAttrs"
        :value="config.desktop.navigationLayout"
        :language="language"
        :disabled="saving"
        @update:value="select"
      />
    </DesktopSettingRow>
  </DesktopSettingsGroup>
</template>

<style scoped lang="scss">
.desktop-navigation-layout-settings__row {
  grid-template-columns: minmax(0, 1fr);
  gap: 0.75rem;
}
</style>
