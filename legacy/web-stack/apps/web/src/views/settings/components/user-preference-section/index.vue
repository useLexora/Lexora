<script setup lang="ts">
import type { AppearancePreference, LanguagePreference } from '@haohaoxue/lexora-contracts'
import type { UserPreferenceSectionProps } from './typing'
import { useI18n } from 'vue-i18n'
import { useUserPreferenceSection } from '../../composables/useUserPreferenceSection'
import UserSettingsSectionHeader from '../section-header'

const props = defineProps<UserPreferenceSectionProps>()
const language = defineModel<LanguagePreference>('language', { required: true })
const appearance = defineModel<AppearancePreference>('appearance', { required: true })
const { t } = useI18n({ useScope: 'global' })
const {
  appearanceOptions,
  formatAppearancePreference,
  formatLanguagePreference,
  languageOptions,
} = useUserPreferenceSection()
</script>

<template>
  <ElCard shadow="never" class="user-preference-section">
    <UserSettingsSectionHeader
      :title="t('settings.preference.title')"
      :description="t('settings.preference.description')"
    />

    <div class="mb-5 last:mb-0">
      <div class="mb-3 text-sm font-semibold text-main">
        {{ t('settings.preference.languageTitle') }}
      </div>
      <ElRadioGroup
        v-model="language"
        :disabled="props.isSavingLanguage"
        class="flex flex-wrap"
      >
        <ElRadioButton
          v-for="item in languageOptions"
          :key="item"
          :value="item"
        >
          {{ formatLanguagePreference(item) }}
        </ElRadioButton>
      </ElRadioGroup>
    </div>

    <div class="mb-5 last:mb-0">
      <div class="mb-3 text-sm font-semibold text-main">
        {{ t('settings.preference.appearanceTitle') }}
      </div>
      <ElRadioGroup
        v-model="appearance"
        :disabled="props.isSavingAppearance"
        class="flex flex-wrap"
      >
        <ElRadioButton
          v-for="item in appearanceOptions"
          :key="item"
          :value="item"
        >
          {{ formatAppearancePreference(item) }}
        </ElRadioButton>
      </ElRadioGroup>
    </div>
  </ElCard>
</template>

<style scoped lang="scss">
.user-preference-section {
  border-color: color-mix(in srgb, var(--brand-border-base) 85%, transparent);
}
</style>
