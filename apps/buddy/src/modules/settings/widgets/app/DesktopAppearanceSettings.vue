<script setup lang="ts">
import type { ApplicationSettingsProps } from './typing'
import { DESKTOP_CHAT_OUTLINE_POSITIONS } from '@buddy-electron/shared/desktopApi'
import { NSelect, useMessage } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'
import DesktopFileIconSettings from './DesktopFileIconSettings.vue'
import DesktopThemeSettings from './DesktopThemeSettings.vue'
import DesktopTypographySettings from './DesktopTypographySettings.vue'
import DesktopWelcomeSettings from './DesktopWelcomeSettings.vue'

const props = defineProps<ApplicationSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const { pending, save } = useSettingMutation<'outlinePosition'>(
  patch => props.updateSettings(patch),
  () => message.error(t('desktop.settings.saveFailed')),
)
const outlinePositionOptions = computed(() => DESKTOP_CHAT_OUTLINE_POSITIONS.map(position => ({
  label: t(`desktop.settings.outlinePosition.${position}`),
  value: position,
})))
</script>

<template>
  <section v-if="config" class="desktop-appearance-settings grid gap-[1.8rem] [container-type:inline-size]">
    <section class="grid gap-[0.8rem]">
      <h2 class="m-0 text-[0.92rem]">
        {{ t('desktop.settings.applicationAppearance') }}
      </h2>
      <DesktopThemeSettings :language="language" />
      <DesktopFileIconSettings :language="language" />
    </section>
    <DesktopTypographySettings v-bind="props" />
    <section class="grid gap-[0.8rem]">
      <h2 class="m-0 text-[0.92rem]">
        {{ t('desktop.settings.conversationAppearance') }}
      </h2>
      <DesktopSettingsGroup>
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.outlinePosition')" :description="t('desktop.settings.outlinePositionDescription')">
          <NSelect
            v-bind="controlAttrs" :options="outlinePositionOptions" :value="config.desktop.chat.outlinePosition"
            :loading="pending.has('outlinePosition')"
            :disabled="pending.has('outlinePosition')"
            @update:value="save('outlinePosition', { desktop: { chat: { outlinePosition: $event } } })"
          />
        </DesktopSettingRow>
      </DesktopSettingsGroup>
    </section>
    <DesktopWelcomeSettings v-bind="props" />
  </section>
</template>
