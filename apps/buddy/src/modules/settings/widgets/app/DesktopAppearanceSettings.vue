<script setup lang="ts">
import type {
  DesktopChatWelcomePreference,
  LexoraConfigPatch,
} from '@buddy-electron/shared/desktopApi'
import type { ApplicationSettingsProps } from './typing'
import { DESKTOP_CHAT_OUTLINE_POSITIONS } from '@buddy-electron/shared/desktopApi'
import { NSelect, NSpin } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopWelcomePreferencePicker from '@/modules/settings/widgets/app/DesktopWelcomePreferencePicker.vue'

type AppearanceSettingField = 'theme' | 'welcome' | 'outlinePosition'

const props = defineProps<ApplicationSettingsProps>()

const { t } = useBuddyI18n(() => props.language)
const pendingFields = shallowRef<ReadonlySet<AppearanceSettingField>>(new Set())
const failedField = shallowRef<AppearanceSettingField | null>(null)
const pendingWelcomePreference = shallowRef<DesktopChatWelcomePreference | null>(null)
const themeOptions = computed(() => [
  { label: t('desktop.settings.themeSystem'), value: 'system' },
  { label: t('desktop.settings.themeLight'), value: 'light' },
  { label: t('desktop.settings.themeDark'), value: 'dark' },
])
const outlinePositionOptions = computed(() => DESKTOP_CHAT_OUTLINE_POSITIONS.map(position => ({
  label: t(`desktop.settings.outlinePosition.${position}`),
  value: position,
})))
const activeWelcomePreference = computed(() => (
  pendingWelcomePreference.value
  ?? props.config?.desktop.chat.welcome
  ?? 'random'
))

async function updateSetting(field: AppearanceSettingField, patch: LexoraConfigPatch) {
  pendingFields.value = new Set([...pendingFields.value, field])
  const succeeded = await props.updateSettings(patch)
  pendingFields.value = new Set([...pendingFields.value].filter(item => item !== field))
  failedField.value = succeeded ? null : field
}

async function updateWelcomePreference(preference: DesktopChatWelcomePreference) {
  pendingWelcomePreference.value = preference
  await updateSetting('welcome', { desktop: { chat: { welcome: preference } } })
  pendingWelcomePreference.value = null
}
</script>

<template>
  <section v-if="config" class="desktop-appearance-settings">
    <section class="desktop-appearance-settings__section">
      <h2>{{ t('desktop.settings.applicationAppearance') }}</h2>
      <div class="desktop-appearance-settings__group">
        <div class="desktop-settings-row">
          <div>
            <strong>{{ t('desktop.settings.theme') }}</strong>
          </div>
          <div class="desktop-settings-row__control">
            <NSelect
              :options="themeOptions"
              :value="config.desktop.theme"
              @update:value="updateSetting('theme', { desktop: { theme: $event } })"
            />
            <NSpin v-if="pendingFields.has('theme')" size="small" />
            <small v-else-if="failedField === 'theme'" class="is-error">
              {{ error ?? t('desktop.settings.saveFailed') }}
            </small>
          </div>
        </div>
      </div>
    </section>
    <section class="desktop-appearance-settings__section">
      <h2>{{ t('desktop.settings.conversationAppearance') }}</h2>
      <div class="desktop-appearance-settings__group">
        <div class="desktop-settings-row">
          <div>
            <strong>{{ t('desktop.settings.outlinePosition') }}</strong>
            <small>{{ t('desktop.settings.outlinePositionDescription') }}</small>
          </div>
          <div class="desktop-settings-row__control">
            <NSelect
              :options="outlinePositionOptions"
              :value="config.desktop.chat.outlinePosition"
              :disabled="pendingFields.has('outlinePosition')"
              @update:value="updateSetting('outlinePosition', { desktop: { chat: { outlinePosition: $event } } })"
            />
            <NSpin v-if="pendingFields.has('outlinePosition')" size="small" />
            <small v-else-if="failedField === 'outlinePosition'" class="is-error" role="alert">
              {{ error ?? t('desktop.settings.saveFailed') }}
            </small>
          </div>
        </div>
        <div class="desktop-settings-row">
          <div>
            <strong>{{ t('desktop.settings.welcome') }}</strong>
          </div>
          <div class="desktop-settings-row__control">
            <DesktopWelcomePreferencePicker
              :language="language"
              :pending="pendingFields.has('welcome')"
              :value="activeWelcomePreference"
              @select="updateWelcomePreference"
            />
            <NSpin v-if="pendingFields.has('welcome')" size="small" />
            <small v-else-if="failedField === 'welcome'" class="is-error">
              {{ error ?? t('desktop.settings.saveFailed') }}
            </small>
          </div>
        </div>
      </div>
    </section>
  </section>
</template>

<style scoped lang="scss">
.desktop-appearance-settings {
  display: grid;
  gap: 1.8rem;
  container-type: inline-size;
}

.desktop-appearance-settings__section {
  display: grid;
  gap: 0.8rem;
}

.desktop-appearance-settings__section h2 {
  margin: 0;
  font-size: 0.92rem;
}

.desktop-appearance-settings__group {
  overflow: hidden;
  border: 1px solid var(--buddy-border-subtle);
  border-radius: 0.65rem;
  background: var(--buddy-surface-base);
}

.desktop-settings-row {
  display: grid;
  min-height: 4rem;
  grid-template-columns: minmax(0, 1fr) minmax(10rem, 19rem);
  align-items: center;
  gap: 2rem;
  border-bottom: 1px solid var(--buddy-border-subtle);
  padding: 0.75rem 0.9rem;
}

.desktop-settings-row:last-child {
  border-bottom: 0;
}

.desktop-settings-row > div:first-child {
  display: grid;
  gap: 0.25rem;
}

.desktop-settings-row strong {
  color: var(--buddy-text-primary);
  font-size: 0.8rem;
  font-weight: 600;
}

.desktop-settings-row small {
  color: var(--buddy-text-secondary);
  font-size: 0.7rem;
  line-height: 1.5;
}

.desktop-settings-row__control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.55rem;
}

.desktop-settings-row__control .is-error {
  grid-column: 1 / -1;
  color: var(--buddy-status-danger-text);
  text-align: right;
}

@container (max-width: 560px) {
  .desktop-settings-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.7rem;
  }

}
</style>
