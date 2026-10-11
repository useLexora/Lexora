<script setup lang="ts">
import type {
  DesktopChatWelcomePreference,
} from '@buddy-electron/shared/desktopApi'
import type { ApplicationSettingsProps } from './typing'
import { DESKTOP_CHAT_OUTLINE_POSITIONS } from '@buddy-electron/shared/desktopApi'
import { NSelect, NSpin, useMessage } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopWelcomePreferencePicker from '@/modules/settings/widgets/app/DesktopWelcomePreferencePicker.vue'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'
import DesktopThemeSettings from './DesktopThemeSettings.vue'

type AppearanceSettingField = 'welcome' | 'outlinePosition'

const props = defineProps<ApplicationSettingsProps>()

const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const { pending: pendingFields, save: updateSetting } = useSettingMutation<AppearanceSettingField>(
  patch => props.updateSettings(patch),
  () => message.error(t('desktop.settings.saveFailed')),
)
const pendingWelcomePreference = shallowRef<DesktopChatWelcomePreference | null>(null)
const outlinePositionOptions = computed(() => DESKTOP_CHAT_OUTLINE_POSITIONS.map(position => ({
  label: t(`desktop.settings.outlinePosition.${position}`),
  value: position,
})))
const activeWelcomePreference = computed(() => (
  pendingWelcomePreference.value
  ?? props.config?.desktop.chat.welcome
  ?? 'random'
))

async function updateWelcomePreference(preference: DesktopChatWelcomePreference) {
  pendingWelcomePreference.value = preference
  await updateSetting('welcome', { desktop: { chat: { welcome: preference } } })
  pendingWelcomePreference.value = null
}
</script>

<template>
  <section v-if="config" class="desktop-appearance-settings grid gap-[1.8rem] [container-type:inline-size]">
    <section class="grid gap-[0.8rem]">
      <h2 class="m-0 text-[0.92rem]">
        {{ t('desktop.settings.applicationAppearance') }}
      </h2>
      <DesktopThemeSettings :language="language" />
    </section>
    <section class="grid gap-[0.8rem]">
      <h2 class="m-0 text-[0.92rem]">
        {{ t('desktop.settings.conversationAppearance') }}
      </h2>
      <DesktopSettingsGroup>
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.outlinePosition')" :description="t('desktop.settings.outlinePositionDescription')">
          <NSelect
            v-bind="controlAttrs"
            :options="outlinePositionOptions"
            :value="config.desktop.chat.outlinePosition"
            :disabled="pendingFields.has('outlinePosition')"
            @update:value="updateSetting('outlinePosition', { desktop: { chat: { outlinePosition: $event } } })"
          />
          <NSpin v-if="pendingFields.has('outlinePosition')" size="small" />
        </DesktopSettingRow>
        <DesktopSettingRow :label="t('desktop.settings.welcome')">
          <DesktopWelcomePreferencePicker
            :language="language"
            :pending="pendingFields.has('welcome')"
            :value="activeWelcomePreference"
            @select="updateWelcomePreference"
          />
          <NSpin v-if="pendingFields.has('welcome')" size="small" />
        </DesktopSettingRow>
      </DesktopSettingsGroup>
    </section>
  </section>
</template>
