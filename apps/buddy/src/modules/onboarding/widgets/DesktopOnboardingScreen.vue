<script setup lang="ts">
import type { DesktopAppInfo } from '@buddy-electron/shared/desktopApi'
import type { DesktopOnboarding } from '../state/useDesktopOnboarding'
import type { BuddyI18nKey } from '@/i18n/buddyI18n'
import { Checkmark16Regular } from '@vicons/fluent'
import { NAlert, NButton, NSelect } from 'naive-ui'
import { computed, nextTick, onMounted, useTemplateRef, watch } from 'vue'
import { BUDDY_LOCALES, useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import OnboardingBuddyStep from './OnboardingBuddyStep.vue'
import OnboardingModelStep from './OnboardingModelStep.vue'
import OnboardingPreferencesStep from './OnboardingPreferencesStep.vue'
import OnboardingPreview from './OnboardingPreview.vue'

const props = defineProps<{ controller: DesktopOnboarding, appInfo: DesktopAppInfo | null }>()
const state = props.controller
const { step, name, avatar, customAvatar, preferences, disabled, busy, error, buddyReady, canContinue, replaying } = state
const language = state.settings.language
const { t, languageOptions } = useBuddyI18n(language)
const heading = useTemplateRef<HTMLElement>('heading')
const steps: Array<{ label: BuddyI18nKey, title: BuddyI18nKey, description: BuddyI18nKey }> = [
  { label: 'onboarding.buddyStep', title: 'onboarding.buddyTitle', description: 'onboarding.buddyDescription' },
  { label: 'onboarding.modelStep', title: 'onboarding.modelTitle', description: 'onboarding.modelDescription' },
  { label: 'onboarding.preferencesStep', title: 'onboarding.preferencesTitle', description: 'onboarding.preferencesDescription' },
]
const current = computed(() => steps[step.value]!)
const themeOptions = computed(() => [
  { label: t('onboarding.themeSystem'), value: 'system' },
  { label: t('onboarding.themeLight'), value: 'lexora.themes.classic-light' },
  { label: t('onboarding.themeDark'), value: 'lexora.themes.classic-dark' },
])
function changeLanguage(value: string) {
  const language = BUDDY_LOCALES.find(locale => locale === value)
  if (language)
    void state.updateAppearance({ desktop: { language } })
}
function next() {
  if (step.value === 0)
    void state.continueFromBuddy()
  else if (step.value === 1)
    step.value = 2
  else
    void state.complete()
}
function back(index: number) {
  if (!disabled.value && index < step.value) {
    error.value = null
    step.value = index
  }
}
async function focusHeading() {
  await nextTick()
  heading.value?.focus({ preventScroll: true })
}
onMounted(focusHeading)
watch(step, focusHeading)
</script>

<template>
  <section class="desktop-onboarding absolute inset-0 z-10 flex min-h-0 flex-col bg-canvas text-fg" data-testid="desktop-onboarding" :aria-label="t('onboarding.welcome')" @keydown.stop>
    <header class="flex flex-none items-center justify-between gap-4 px-8 py-4">
      <strong class="text-[19px] font-650 tracking-[-0.02em]">Lexora</strong>
      <div class="flex items-center gap-2">
        <NSelect class="w-28" size="small" :value="language" :options="languageOptions" :disabled="disabled" :aria-label="t('onboarding.language')" @update:value="changeLanguage" />
        <NSelect class="w-32" size="small" :value="state.settings.config.value?.desktop.theme.id ?? 'system'" :options="themeOptions" :disabled="disabled" :aria-label="t('onboarding.appearance')" @update:value="state.updateAppearance({ desktop: { theme: { id: $event } } })" />
        <NButton v-if="replaying" quaternary size="small" :disabled="disabled" @click="state.close">
          {{ t('onboarding.close') }}
        </NButton>
      </div>
    </header>
    <div class="min-h-0 flex-1 overflow-hidden px-8 pb-6">
      <div class="onboarding-body mx-auto grid h-full min-h-0 max-w-[1120px] gap-12">
        <OnboardingPreview :name="name" :avatar="avatar" :language="language" :layout="preferences.navigationLayout" :step="step" />
        <div class="flex min-h-0 min-w-0 flex-col justify-center py-4">
          <ol class="m-0 mb-6 flex flex-none list-none items-center gap-5 p-0" :aria-label="t('onboarding.steps')">
            <li v-for="(item, index) in steps" :key="item.label" :aria-current="index === step ? 'step' : undefined">
              <button type="button" class="flex items-center gap-2 border-0 rounded-micro bg-transparent p-0 text-[12px] ui-focus-ring" :class="index === step ? 'text-accent-text font-600' : 'text-muted'" :disabled="index >= step || disabled" @click="back(index)">
                <span class="grid size-6 place-items-center rounded-full" :class="index === step ? 'bg-accent text-on-accent' : 'bg-subtle'">
                  <DesktopIcon v-if="index < step" :component="Checkmark16Regular" :size="14" />
                  <template v-else>{{ index + 1 }}</template>
                </span>
                {{ t(item.label) }}
              </button>
            </li>
          </ol>
          <div class="mb-5 grid flex-none gap-3">
            <h1 ref="heading" tabindex="-1" class="m-0 text-[28px] font-600 leading-[1.35] outline-none">
              {{ t(current.title) }}
            </h1>
            <p class="m-0 text-[14px] leading-[1.7] text-muted">
              {{ t(current.description) }}
            </p>
          </div>
          <div class="min-h-0 overflow-auto px-1 py-1">
            <OnboardingBuddyStep v-if="step === 0 && buddyReady" v-model:name="name" v-model:avatar="avatar" :custom-avatar="customAvatar" :language="language" :disabled="disabled" @upload="state.uploadAvatar" />
            <div v-else-if="step === 0" class="grid justify-items-start gap-3 py-8">
              <p class="m-0 text-muted">
                {{ t('onboarding.buddyUnavailable') }}
              </p>
              <NButton :loading="busy" @click="state.reloadBuddy">
                {{ t('onboarding.retry') }}
              </NButton>
            </div>
            <OnboardingModelStep v-else-if="step === 1" :providers="state.providers" />
            <OnboardingPreferencesStep v-else v-model="preferences" :language="language" :capabilities="appInfo?.updateCapabilities" :disabled="disabled" />
          </div>
          <NAlert v-if="error" class="mt-3 flex-none" type="error" :show-icon="false" role="alert">
            {{ t(error) }}
            <NButton v-if="error === 'onboarding.buddyConflict'" text :disabled="disabled" @click="state.reloadBuddy">
              {{ t('onboarding.reloadBuddy') }}
            </NButton>
          </NAlert>
          <footer class="mt-5 flex flex-none items-center justify-between gap-4 border-t border-t-solid border-t-border pt-5">
            <NButton v-if="step > 0" quaternary :disabled="disabled" @click="back(step - 1)">
              {{ t('onboarding.back') }}
            </NButton>
            <span v-else class="text-[12px] text-muted">{{ t('onboarding.localProfile') }}</span>
            <NButton type="primary" size="large" :loading="busy" :disabled="disabled || (step === 0 && !canContinue)" @click="next">
              {{ t(step === 2 ? replaying ? 'onboarding.save' : 'onboarding.finish' : step === 1 && !state.providers.models.value.length ? 'onboarding.skipModel' : 'onboarding.next') }}
            </NButton>
          </footer>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.onboarding-body {
  grid-template-columns: minmax(240px, 0.78fr) minmax(0, 1.22fr);

  @media (max-width: 1000px) {
    gap: 2rem;
  }
  @media (max-width: 780px) {
    grid-template-columns: minmax(0, 1fr);
    max-width: 540px;
  }
}
</style>
