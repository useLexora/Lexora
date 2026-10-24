<script setup lang="ts">
import type { DesktopChatWelcomeItem, DesktopChatWelcomePreference } from '@buddy-electron/shared/desktopApi'
import type { ApplicationSettingsProps } from './typing'
import { DEFAULT_DESKTOP_CHAT_PREFERENCES } from '@buddy-electron/shared/desktopApi'
import { DESKTOP_CHAT_WELCOME_MAX_ITEMS, DESKTOP_CHAT_WELCOME_MAX_LENGTH } from '@buddy-electron/shared/desktopChatWelcome'
import { NButton, NSwitch, useMessage } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopSegmentedControl from '@/shared/ui/segmented-control/DesktopSegmentedControl.vue'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'
import DesktopWelcomeImageSettings from './DesktopWelcomeImageSettings.vue'
import DesktopWelcomeMessagesDialog from './DesktopWelcomeMessagesDialog.vue'

const props = defineProps<ApplicationSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const { pending, save } = useSettingMutation<'enabled' | 'welcome' | 'greeting'>(
  patch => props.updateSettings(patch),
  () => message.error(t('desktop.settings.saveFailed')),
)
const preferences = computed(() => props.config?.desktop.chat ?? DEFAULT_DESKTOP_CHAT_PREFERENCES)
const newText = shallowRef('')
const showMessages = shallowRef(false)
const mode = computed(() => ['none', 'random'].includes(preferences.value.welcome) ? preferences.value.welcome : 'fixed')
const modeOptions = computed(() => [
  { label: t('desktop.settings.welcomeNone'), value: 'none' },
  { label: t('desktop.settings.welcomeRandom'), value: 'random', disabled: preferences.value.welcomeItems.length === 0 },
  { label: t('desktop.settings.welcomeFixed'), value: 'fixed', disabled: preferences.value.welcomeItems.length === 0 },
])
const disabled = computed(() => !preferences.value.welcomeEnabled || pending.value.has('enabled'))
const modeDescription = computed(() => t(mode.value === 'none'
  ? 'desktop.settings.welcomeNoneDescription'
  : mode.value === 'random' ? 'desktop.settings.welcomeRandomDescription' : 'desktop.settings.welcomeFixedDescription'))

function selectPreference(welcome: DesktopChatWelcomePreference) {
  if (disabled.value || welcome === preferences.value.welcome)
    return
  void save('welcome', { desktop: { chat: { welcome } } })
}

function selectMode(value: string) {
  const preference = value === 'fixed' ? preferences.value.welcomeItems[0]?.id : value
  if (preference)
    selectPreference(preference)
}

async function addMessage() {
  const text = newText.value.trim()
  if (disabled.value || !text || text.length > DESKTOP_CHAT_WELCOME_MAX_LENGTH || pending.value.has('welcome') || preferences.value.welcomeItems.length >= DESKTOP_CHAT_WELCOME_MAX_ITEMS)
    return
  const item: DesktopChatWelcomeItem = { kind: 'custom', id: `custom-${crypto.randomUUID()}`, text }
  const welcomeItems = [...preferences.value.welcomeItems.map(item => ({ ...item })), item]
  const saved = await save('welcome', { desktop: { chat: { welcomeItems } } })
  if (saved)
    newText.value = ''
}

function deleteMessage(id: string) {
  if (disabled.value)
    return
  const welcomeItems = preferences.value.welcomeItems.filter(item => item.id !== id).map(item => ({ ...item }))
  void save('welcome', { desktop: { chat: { welcomeItems } } })
}
</script>

<template>
  <section class="grid gap-[0.8rem]" data-testid="welcome-settings">
    <h2 class="m-0 text-[0.92rem]">
      {{ t('desktop.settings.welcomeSection') }}
    </h2>
    <DesktopSettingsGroup>
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.welcomeEnabled')" :description="t('desktop.settings.welcomeEnabledDescription')" toggle>
        <NSwitch
          v-bind="controlAttrs" :round="false" :value="preferences.welcomeEnabled"
          :loading="pending.has('enabled')" :disabled="pending.size > 0" :aria-disabled="pending.size > 0"
          @update:value="save('enabled', { desktop: { chat: { welcomeEnabled: $event } } })"
        />
      </DesktopSettingRow>
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.welcome')" :description="modeDescription" :disabled="disabled" toggle class="[--setting-control-max:24rem]">
        <DesktopSegmentedControl
          v-bind="controlAttrs" :options="modeOptions" :model-value="mode" :disabled="disabled || pending.has('welcome')"
          data-testid="welcome-mode" @update:model-value="selectMode"
        />
        <NButton quaternary size="small" :theme-overrides="{ fontSizeSmall: '13px' }" :disabled="disabled || pending.has('welcome')" @click="showMessages = true">
          {{ t('desktop.settings.welcomeMessages') }}
        </NButton>
      </DesktopSettingRow>
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.welcomeGreeting')" :description="t('desktop.settings.welcomeGreetingDescription')" :disabled="disabled" toggle>
        <NSwitch
          v-bind="controlAttrs" :round="false" :value="preferences.welcomeGreetingEnabled"
          :loading="pending.has('greeting')" :disabled="disabled || pending.has('greeting')" :aria-disabled="disabled || pending.has('greeting')"
          @update:value="save('greeting', { desktop: { chat: { welcomeGreetingEnabled: $event } } })"
        />
      </DesktopSettingRow>
      <DesktopWelcomeImageSettings v-bind="props" :disabled="disabled" />
    </DesktopSettingsGroup>
    <DesktopWelcomeMessagesDialog
      v-if="showMessages" v-model:draft="newText" :language="language" :items="preferences.welcomeItems" :selected-id="mode === 'fixed' ? preferences.welcome : null"
      :pending="pending.has('welcome')" :disabled="disabled" @add="addMessage" @delete="deleteMessage" @select="selectPreference" @close="showMessages = false"
    />
  </section>
</template>
