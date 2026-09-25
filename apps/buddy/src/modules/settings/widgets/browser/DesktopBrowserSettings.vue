<script setup lang="ts">
import type { DesktopBrowserApi, LexoraConfigPatch } from '@buddy-electron/shared/desktopApi'
import type { ApplicationSettingsProps } from '../app/typing'
import { BROWSER_ZOOM_FACTORS } from '@buddy-shared/browser/browserPreferences'
import { NButton, NInputNumber, NSelect, NSwitch, useMessage } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopBrowserClearDataDialog from './DesktopBrowserClearDataDialog.vue'

const props = defineProps<ApplicationSettingsProps & { browser: Pick<DesktopBrowserApi, 'getDataSummary' | 'clearData'> }>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const clearing = shallowRef(false)
const pending = shallowRef(false)
const screenshotOptions = computed(() => [
  { label: t('desktop.browser.screenshotFile'), value: 'file' },
  { label: t('desktop.browser.screenshotClipboard'), value: 'clipboard' },
])
const zoomOptions = BROWSER_ZOOM_FACTORS.map(value => ({ label: `${Math.round(value * 100)}%`, value }))

async function update(patch: LexoraConfigPatch) {
  if (pending.value)
    return
  pending.value = true
  try {
    if (!await props.updateSettings(patch))
      message.error(t('desktop.settings.saveFailed'))
  }
  finally { pending.value = false }
}
</script>

<template>
  <section v-if="config" class="desktop-browser-settings">
    <section class="desktop-browser-settings__section">
      <h2>{{ t('desktop.browser.preferences') }}</h2>
      <div class="desktop-browser-settings__group">
        <div class="desktop-browser-settings__row">
          <div class="desktop-browser-settings__copy">
            <strong>{{ t('desktop.browser.screenshotDestination') }}</strong>
            <small>{{ t('desktop.browser.screenshotDescription') }}</small>
          </div>
          <NSelect :value="config.browser.screenshotDestination" :options="screenshotOptions" :disabled="pending" :aria-label="t('desktop.browser.screenshotDestination')" @update:value="update({ browser: { screenshotDestination: $event } })" />
        </div>
        <div class="desktop-browser-settings__row">
          <div class="desktop-browser-settings__copy">
            <strong>{{ t('desktop.browser.defaultZoom') }}</strong>
            <small>{{ t('desktop.browser.defaultZoomDescription') }}</small>
          </div>
          <NSelect :value="config.browser.defaultZoomFactor" :options="zoomOptions" :disabled="pending" :aria-label="t('desktop.browser.defaultZoom')" @update:value="update({ browser: { defaultZoomFactor: $event } })" />
        </div>
      </div>
    </section>
    <section class="desktop-browser-settings__section">
      <h2>{{ t('desktop.browser.freezing') }}</h2>
      <p class="desktop-browser-settings__hint">
        {{ t('desktop.browser.freezingDescription') }}
      </p>
      <div class="desktop-browser-settings__group">
        <div class="desktop-browser-settings__row">
          <div class="desktop-browser-settings__copy">
            <strong>{{ t('desktop.browser.freezeBackground') }}</strong>
            <small>{{ t('desktop.browser.freezeBackgroundDescription') }}</small>
          </div>
          <NSwitch class="desktop-browser-settings__switch" :round="false" :value="config.browser.freezeBackground" :disabled="pending" :aria-label="t('desktop.browser.freezeBackground')" @update:value="update({ browser: { freezeBackground: $event } })" />
        </div>
        <div class="desktop-browser-settings__row">
          <div class="desktop-browser-settings__copy">
            <strong>{{ t('desktop.browser.freezeForeground') }}</strong>
            <small>{{ t('desktop.browser.freezeForegroundDescription') }}</small>
          </div>
          <NSwitch class="desktop-browser-settings__switch" :round="false" :value="config.browser.freezeForeground" :disabled="pending" :aria-label="t('desktop.browser.freezeForeground')" @update:value="update({ browser: { freezeForeground: $event } })" />
        </div>
        <div class="desktop-browser-settings__row">
          <div class="desktop-browser-settings__copy">
            <strong>{{ t('desktop.browser.freezeDelay') }}</strong>
            <small>{{ t('desktop.browser.freezeDelayDescription') }}</small>
          </div>
          <NInputNumber :value="config.browser.freezeDelaySeconds" :min="5" :max="3600" :precision="0" :update-value-on-input="false" :disabled="pending || (!config.browser.freezeBackground && !config.browser.freezeForeground)" :input-props="{ 'aria-label': t('desktop.browser.freezeDelay') }" @update:value="$event !== null && update({ browser: { freezeDelaySeconds: $event } })">
            <template #suffix>
              {{ t('desktop.browser.seconds') }}
            </template>
          </NInputNumber>
        </div>
      </div>
    </section>
    <section class="desktop-browser-settings__section">
      <h2>{{ t('desktop.browser.data') }}</h2>
      <div class="desktop-browser-settings__group">
        <div class="desktop-browser-settings__row">
          <div class="desktop-browser-settings__copy">
            <strong>{{ t('desktop.browser.clearData') }}</strong>
            <small>{{ t('desktop.browser.clearDataDescription') }}</small>
          </div>
          <NButton class="desktop-browser-settings__clear" @click="clearing = true">
            {{ t('desktop.browser.clearData') }}
          </NButton>
        </div>
      </div>
    </section>
    <DesktopBrowserClearDataDialog v-if="clearing" :language="language" :browser="browser" @close="clearing = false" />
  </section>
</template>

<style scoped>
.desktop-browser-settings { display: grid; gap: 1.8rem; container-type: inline-size; }
.desktop-browser-settings__section { display: grid; gap: 0.8rem; }
.desktop-browser-settings__section h2 { margin: 0; font-size: 0.92rem; }
.desktop-browser-settings__group { border: 1px solid var(--buddy-border-subtle); border-radius: 0.65rem; background: var(--buddy-surface-base); }
.desktop-browser-settings__row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(8rem, 14rem); align-items: center; gap: 2rem; padding: 1rem; }
.desktop-browser-settings__row + .desktop-browser-settings__row { border-top: 1px solid var(--buddy-border-subtle); }
.desktop-browser-settings__copy { display: grid; gap: 0.35rem; }
.desktop-browser-settings__copy strong { font-size: 0.8rem; font-weight: 600; color: var(--buddy-text-primary); }
.desktop-browser-settings__copy small { font-size: 0.72rem; line-height: 1.6; color: var(--buddy-text-secondary); }
.desktop-browser-settings__clear, .desktop-browser-settings__switch { justify-self: end; }
.desktop-browser-settings__hint { margin: 0; font-size: 0.72rem; line-height: 1.6; color: var(--buddy-text-secondary); }
@container (max-width: 560px) {
  .desktop-browser-settings__row { grid-template-columns: minmax(0, 1fr); gap: 0.8rem; }
  .desktop-browser-settings__clear, .desktop-browser-settings__switch { justify-self: start; }
}
</style>
