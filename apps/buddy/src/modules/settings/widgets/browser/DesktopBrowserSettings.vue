<script setup lang="ts">
import type { DesktopBrowserApi, LexoraConfigPatch } from '@buddy-electron/shared/desktopApi'
import type { ApplicationSettingsProps } from '../app/typing'
import { BROWSER_ZOOM_FACTORS } from '@buddy-shared/browser/browserPreferences'
import { NButton, NInputNumber, NSelect, NSwitch, useMessage } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'
import DesktopBrowserClearDataDialog from './DesktopBrowserClearDataDialog.vue'

const props = defineProps<ApplicationSettingsProps & { browser: Pick<DesktopBrowserApi, 'getDataSummary' | 'clearData'> }>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const clearing = shallowRef(false)
const { pending: pendingFields, save } = useSettingMutation<'browser'>(
  patch => props.updateSettings(patch),
  () => message.error(t('desktop.settings.saveFailed')),
)
const pending = computed(() => pendingFields.value.has('browser'))
const screenshotOptions = computed(() => [
  { label: t('desktop.browser.screenshotFile'), value: 'file' },
  { label: t('desktop.browser.screenshotClipboard'), value: 'clipboard' },
])
const zoomOptions = BROWSER_ZOOM_FACTORS.map(value => ({ label: `${Math.round(value * 100)}%`, value }))

function update(patch: LexoraConfigPatch) {
  return save('browser', patch)
}
</script>

<template>
  <section v-if="config" class="desktop-browser-settings grid gap-[1.8rem] [container-type:inline-size] [--setting-row-height:0px] [--setting-row-px:1rem] [--setting-row-py:1rem] [--setting-control-min:8rem] [--setting-control-max:14rem] [--setting-copy-gap:0.35rem] [--setting-description-size:0.72rem] [--setting-description-leading:1.6]">
    <section class="grid gap-[0.8rem]">
      <h2 class="m-0 text-[0.92rem]">
        {{ t('desktop.browser.preferences') }}
      </h2>
      <DesktopSettingsGroup>
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.browser.screenshotDestination')" :description="t('desktop.browser.screenshotDescription')">
          <NSelect v-bind="controlAttrs" :value="config.browser.screenshotDestination" :options="screenshotOptions" :disabled="pending" @update:value="update({ browser: { screenshotDestination: $event } })" />
        </DesktopSettingRow>
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.browser.defaultZoom')" :description="t('desktop.browser.defaultZoomDescription')">
          <NSelect v-bind="controlAttrs" :value="config.browser.defaultZoomFactor" :options="zoomOptions" :disabled="pending" @update:value="update({ browser: { defaultZoomFactor: $event } })" />
        </DesktopSettingRow>
      </DesktopSettingsGroup>
    </section>
    <section class="grid gap-[0.8rem]">
      <h2 class="m-0 text-[0.92rem]">
        {{ t('desktop.browser.freezing') }}
      </h2>
      <p class="m-0 text-[0.72rem] leading-[1.6] text-muted">
        {{ t('desktop.browser.freezingDescription') }}
      </p>
      <DesktopSettingsGroup>
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.browser.freezeBackground')" :description="t('desktop.browser.freezeBackgroundDescription')" toggle>
          <NSwitch v-bind="controlAttrs" :round="false" :value="config.browser.freezeBackground" :disabled="pending" :aria-disabled="pending" @update:value="update({ browser: { freezeBackground: $event } })" />
        </DesktopSettingRow>
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.browser.freezeForeground')" :description="t('desktop.browser.freezeForegroundDescription')" toggle>
          <NSwitch v-bind="controlAttrs" :round="false" :value="config.browser.freezeForeground" :disabled="pending" :aria-disabled="pending" @update:value="update({ browser: { freezeForeground: $event } })" />
        </DesktopSettingRow>
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.browser.freezeDelay')" :description="t('desktop.browser.freezeDelayDescription')">
          <NInputNumber v-bind="controlAttrs" :value="config.browser.freezeDelaySeconds" :min="5" :max="3600" :precision="0" :update-value-on-input="false" :disabled="pending || (!config.browser.freezeBackground && !config.browser.freezeForeground)" @update:value="$event !== null && update({ browser: { freezeDelaySeconds: $event } })">
            <template #suffix>
              {{ t('desktop.browser.seconds') }}
            </template>
          </NInputNumber>
        </DesktopSettingRow>
      </DesktopSettingsGroup>
    </section>
    <section class="grid gap-[0.8rem]">
      <h2 class="m-0 text-[0.92rem]">
        {{ t('desktop.browser.data') }}
      </h2>
      <DesktopSettingsGroup>
        <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.browser.clearData')" :description="t('desktop.browser.clearDataDescription')" toggle>
          <NButton v-bind="controlAttrs" @click="clearing = true">
            {{ t('desktop.browser.clearData') }}
          </NButton>
        </DesktopSettingRow>
      </DesktopSettingsGroup>
    </section>
    <DesktopBrowserClearDataDialog v-if="clearing" :language="language" :browser="browser" @close="clearing = false" />
  </section>
</template>
