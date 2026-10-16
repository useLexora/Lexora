<script setup lang="ts">
import UserPreferenceSection from '../../components/user-preference-section'
import { useSettingsPreferencePage } from '../../composables/useSettingsPreferencePage'

const {
  appearancePreference,
  errorMessage,
  isLoading,
  isSavingAppearance,
  isSavingLanguage,
  languagePreference,
} = useSettingsPreferencePage()
</script>

<template>
  <div class="settings-preference-page mx-auto w-full max-w-[var(--page-mode-form-max-width)] px-6 py-6">
    <ElAlert
      v-if="errorMessage"
      :title="errorMessage"
      type="error"
      show-icon
      :closable="false"
      class="mb-4"
    />

    <ElSkeleton v-else-if="isLoading" animated>
      <template #template>
        <ElCard shadow="never">
          <div class="grid gap-5">
            <ElSkeletonItem variant="h3" class="max-w-32" />
            <ElSkeletonItem variant="text" class="max-w-72" />
            <ElSkeletonItem variant="rect" class="h-12" />
            <ElSkeletonItem variant="rect" class="h-12" />
          </div>
        </ElCard>
      </template>
    </ElSkeleton>

    <UserPreferenceSection
      v-else
      v-model:language="languagePreference"
      v-model:appearance="appearancePreference"
      :is-saving-language="isSavingLanguage"
      :is-saving-appearance="isSavingAppearance"
    />
  </div>
</template>
