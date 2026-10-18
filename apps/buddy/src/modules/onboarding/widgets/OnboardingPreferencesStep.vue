<script setup lang="ts">
import type { DesktopUpdateCapabilities } from '@buddy-electron/shared/desktopUpdates'
import type { OnboardingPreferences } from '../state/useDesktopOnboarding'
import { NSwitch, NTooltip } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DesktopNavigationLayoutPicker, DesktopSettingRow } from '@/modules/settings/ui'

const props = defineProps<{ language: string, capabilities?: DesktopUpdateCapabilities, disabled: boolean }>()
const preferences = defineModel<OnboardingPreferences>({ required: true })
const { t } = useBuddyI18n(() => props.language)
const hovered = shallowRef<string | null>(null)
const focused = shallowRef<string | null>(null)
const toggles = computed(() => [
  { field: 'updateNotificationsEnabled' as const, label: t('desktop.update.autoCheck'), description: t('onboarding.autoCheckHint'), reason: props.capabilities?.automaticCheck ? null : t('desktop.update.autoCheckUnavailable') },
  { field: 'autoDownloadUpdates' as const, label: t('desktop.update.autoDownload'), description: t(preferences.value.updateNotificationsEnabled ? 'onboarding.autoDownloadHint' : 'desktop.update.autoDownloadPaused'), reason: props.capabilities?.download ? null : t('desktop.update.autoDownloadUnavailable') },
  { field: 'petEnabled' as const, label: t('onboarding.pet'), description: t('onboarding.petHint'), reason: null },
])
function update<K extends keyof OnboardingPreferences>(key: K, value: OnboardingPreferences[K]) {
  preferences.value = { ...preferences.value, [key]: value }
}
</script>

<template>
  <div class="grid gap-6">
    <section class="grid gap-3">
      <h2 class="m-0 text-[14px] font-600">
        {{ t('desktop.settings.navigationLayout') }}
      </h2>
      <DesktopNavigationLayoutPicker :value="preferences.navigationLayout" :language="language" :disabled="disabled" :aria-label="t('desktop.settings.navigationLayout')" @update:value="update('navigationLayout', $event)" />
    </section>
    <section class="grid [--setting-control-min:0px] [--setting-control-max:max-content]">
      <DesktopSettingRow v-for="toggle in toggles" :key="toggle.field" v-slot="{ controlAttrs }" class="py-3 first:pt-0 last:pb-0" :label="toggle.label" :description="toggle.description" toggle>
        <NTooltip trigger="manual" :show="!!toggle.reason && (hovered === toggle.field || focused === toggle.field)">
          <template #trigger>
            <span
              class="inline-flex rounded-micro ui-focus-ring"
              :tabindex="toggle.reason ? 0 : undefined" :role="toggle.reason ? 'group' : undefined"
              :aria-labelledby="toggle.reason ? controlAttrs['aria-labelledby'] : undefined" :aria-description="toggle.reason ?? undefined"
              @mouseenter="hovered = toggle.field" @mouseleave="hovered = null"
              @focus="focused = toggle.field" @blur="focused = null" @keydown.esc="hovered = null; focused = null"
            >
              <NSwitch v-bind="controlAttrs" :round="false" :value="preferences[toggle.field]" :disabled="disabled || !!toggle.reason" :aria-disabled="disabled || !!toggle.reason" @update:value="update(toggle.field, $event)" />
            </span>
          </template>
          {{ toggle.reason }}
        </NTooltip>
      </DesktopSettingRow>
    </section>
  </div>
</template>
