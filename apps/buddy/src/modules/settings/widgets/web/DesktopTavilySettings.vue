<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'

import { Eye20Regular, EyeOff20Regular } from '@vicons/fluent'
import { NButton, NInput, useMessage } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useWebCredentialInput } from '../../state/useWebCredentialInput'

const props = defineProps<{
  configured: boolean
  disabled: boolean
  language: BuddyLocale
  saveCredential: (key: string | null) => Promise<boolean>
  revealCredential: () => Promise<string | null>
}>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const { canSave, masked, revealFailed, revealing, save, toggleVisibility, update, value: credentialValue, visible } = useWebCredentialInput({ configured: () => props.configured, reveal: () => props.revealCredential(), save: key => props.saveCredential(key) })

async function toggleCredentialVisibility() {
  await toggleVisibility()
  if (revealFailed.value)
    message.error(t('desktop.web.revealFailed'))
}

function prepareEdit(event: Event) {
  if (masked.value && event.target instanceof HTMLInputElement)
    event.target.select()
}
</script>

<template>
  <div class="desktop-tavily-settings">
    <header class="desktop-tavily-settings__heading">
      <h3 class="desktop-tavily-settings__title">
        Tavily
      </h3>
    </header>
    <p class="desktop-tavily-settings__description">
      {{ t('desktop.web.tavilyDescription') }}
    </p>
    <form class="desktop-tavily-settings__credentials" @submit.prevent="save">
      <NInput
        :value="credentialValue"
        :type="visible ? 'text' : 'password'"
        autocomplete="off"
        clearable
        :aria-label="t('desktop.web.apiKey')"
        :placeholder="t('desktop.web.apiKey')"
        :disabled="disabled"
        @beforeinput="prepareEdit"
        @update:value="update"
      >
        <template #suffix>
          <NButton class="desktop-tavily-settings__reveal" quaternary :aria-label="t(visible ? 'desktop.web.hideKey' : 'desktop.web.showKey')" :aria-pressed="visible" :disabled="disabled || revealing" :loading="revealing" @mousedown.prevent @click="toggleCredentialVisibility">
            <DesktopIcon :component="visible ? Eye20Regular : EyeOff20Regular" />
          </NButton>
        </template>
      </NInput>
      <NButton attr-type="submit" :disabled="!canSave || disabled">
        {{ t('common.save') }}
      </NButton>
    </form>
  </div>
</template>

<style scoped lang="scss">
.desktop-tavily-settings { display: grid; gap: 0.7rem; }
.desktop-tavily-settings__heading, .desktop-tavily-settings__credentials { display: flex; align-items: center; gap: 0.65rem; }
.desktop-tavily-settings__title { margin: 0; font-size: 0.82rem; font-weight: 600; }
.desktop-tavily-settings__description { margin: 0; color: var(--buddy-text-secondary); font-size: 0.75rem; line-height: 1.65; }
.desktop-tavily-settings__reveal { width: 1.5rem; height: 1.5rem; padding: 0; color: var(--buddy-text-secondary); border-radius: 6px; }
.desktop-tavily-settings__credentials > .n-input { min-width: 0; flex: 1; }
@media (max-width: 900px) {
  .desktop-tavily-settings__credentials { flex-wrap: wrap; }
  .desktop-tavily-settings__credentials > .n-input { flex-basis: 100%; }
}
</style>
