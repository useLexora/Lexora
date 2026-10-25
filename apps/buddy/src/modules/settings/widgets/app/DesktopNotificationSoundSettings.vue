<script setup lang="ts">
import type { NotificationSoundFailure } from '../../state/useNotificationSoundSettings'
import type { ApplicationSettingsProps } from './typing'
import type { BuddyI18nKey } from '@/i18n/buddyI18n'
import { BUILTIN_NOTIFICATION_SOUNDS, NOTIFICATION_SOUND_MAX_BYTES, NOTIFICATION_SOUND_MAX_DURATION_MS } from '@buddy-shared/notifications/notificationSound'
import { NButton, NPopconfirm, NRadio, NRadioGroup, NSlider, useMessage } from 'naive-ui'
import { computed, shallowRef, useId, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { useNotificationSoundSettings } from '../../state/useNotificationSoundSettings'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'

const props = defineProps<ApplicationSettingsProps & { disabled?: boolean }>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const headingId = useId()
const descriptionId = `${headingId}-description`
const soundNameKeys = {
  bell: 'desktop.settings.notificationSoundBell',
  drop: 'desktop.settings.notificationSoundDrop',
  ambient: 'desktop.settings.notificationSoundAmbient',
} as const satisfies Record<string, BuddyI18nKey>
const failureKeys: Record<NotificationSoundFailure, BuddyI18nKey> = {
  'save': 'desktop.settings.saveFailed',
  'preview': 'desktop.settings.notificationSoundPreviewFailed',
  'remove': 'desktop.settings.notificationSoundRemoveFailed',
  'import-size': 'desktop.settings.notificationSoundTooLarge',
  'import-type': 'desktop.settings.notificationSoundInvalid',
  'import-duration': 'desktop.settings.notificationSoundTooLong',
  'import-read': 'desktop.settings.notificationSoundReadFailed',
  'import-save': 'desktop.settings.notificationSoundImportFailed',
}
const limits = {
  size: NOTIFICATION_SOUND_MAX_BYTES / 1024 / 1024,
  duration: NOTIFICATION_SOUND_MAX_DURATION_MS / 1000,
}
const {
  preferences,
  importing,
  removingId,
  previewingId,
  pending,
  busy,
  selectionDisabled,
  volumeDisabled,
  select,
  setVolume,
  importSound,
  remove,
  preview,
} = useNotificationSoundSettings({
  settings: props,
  api: requireDesktopApi().notificationSounds,
  disabled: () => props.disabled ?? false,
  onFailure: failure => message.error(t(failureKeys[failure], limits)),
})
const options = computed(() => [
  { id: 'system', name: t('desktop.settings.notificationSoundSystem'), durationMs: 0, custom: false },
  ...BUILTIN_NOTIFICATION_SOUNDS.map(sound => ({
    ...sound,
    name: t(soundNameKeys[sound.id]),
    custom: false,
  })),
  ...preferences.value.sounds.map(sound => ({ ...sound, custom: true })),
])
const volumeDraft = shallowRef<number | null>(null)
const draggingVolume = shallowRef(false)
const volumePercent = computed(() => volumeDraft.value ?? Math.round(preferences.value.volume * 100))
const volumeDescription = computed(() => t(preferences.value.selected === 'system'
  ? 'desktop.settings.notificationSoundSystemVolume'
  : 'desktop.settings.notificationSoundVolumeDescription'))

async function commitVolume() {
  draggingVolume.value = false
  const value = volumeDraft.value
  if (value === null)
    return
  try {
    await setVolume(value / 100)
  }
  finally {
    volumeDraft.value = null
  }
}

function updateVolume(value: number) {
  if (volumeDisabled.value)
    return
  volumeDraft.value = value
  if (!draggingVolume.value)
    void commitVolume()
}

watch(volumeDisabled, (disabled) => {
  if (disabled && !pending.value.has('volume')) {
    draggingVolume.value = false
    volumeDraft.value = null
  }
})
</script>

<template>
  <DesktopSettingsGroup>
    <section class="desktop-notification-sound-settings min-w-0" :aria-labelledby="headingId">
      <header class="grid gap-1 px-[0.9rem] pt-[0.75rem]">
        <div class="flex items-center justify-between gap-3">
          <h3 :id="headingId" class="m-0 text-[0.8rem] font-600">
            {{ t('desktop.settings.notificationSound') }}
          </h3>
          <NButton size="small" :disabled="busy" :loading="importing" @click="importSound">
            {{ t('desktop.settings.notificationSoundImport') }}
          </NButton>
        </div>
        <p :id="descriptionId" class="m-0 text-[0.7rem] text-muted leading-[1.5]">
          {{ t('desktop.settings.notificationSoundImportHint', limits) }}
        </p>
      </header>
      <NRadioGroup
        class="grid box-border w-full min-w-0 px-[0.9rem] py-2"
        :value="preferences.selected" :aria-labelledby="headingId" :aria-describedby="descriptionId"
        @update:value="select"
      >
        <div
          v-for="option in options" :key="option.id" :data-sound-id="option.id"
          class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-b-solid border-b-border py-2 last:border-b-0"
        >
          <NRadio class="notification-sound-choice min-w-0" :value="option.id" :disabled="selectionDisabled">
            <span class="block break-all text-[0.8rem]">{{ option.name }}</span>
            <span class="block text-[0.7rem] text-muted leading-[1.5]">
              {{ option.id === 'system' ? t('desktop.settings.notificationSoundSystemHint') : t('desktop.settings.notificationSoundDuration', { seconds: Math.round(option.durationMs / 100) / 10 }) }}
            </span>
          </NRadio>
          <div v-if="option.id !== 'system'" class="flex shrink-0 items-center gap-1">
            <NButton
              size="small" quaternary :disabled="removingId === option.id" :aria-pressed="previewingId === option.id"
              @click="preview(option.id)"
            >
              {{ t(previewingId === option.id ? 'desktop.settings.notificationSoundStop' : 'desktop.settings.notificationSoundPreview') }}
            </NButton>
            <template v-if="option.custom">
              <NPopconfirm
                v-if="preferences.selected === option.id"
                :positive-text="t('desktop.settings.notificationSoundRemove')" :negative-text="t('desktop.settings.notificationSoundCancel')"
                @positive-click="remove(option.id, true)"
              >
                <template #trigger>
                  <NButton size="small" quaternary :disabled="busy" :loading="removingId === option.id">
                    {{ t('desktop.settings.notificationSoundRemove') }}
                  </NButton>
                </template>
                {{ t('desktop.settings.notificationSoundRemoveConfirm', { name: option.name }) }}
              </NPopconfirm>
              <NButton v-else size="small" quaternary :disabled="busy" :loading="removingId === option.id" @click="remove(option.id)">
                {{ t('desktop.settings.notificationSoundRemove') }}
              </NButton>
            </template>
          </div>
        </div>
      </NRadioGroup>
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.notificationSoundVolume')" :description="volumeDescription" :disabled="volumeDisabled" class="border-t border-t-solid border-t-border">
        <div class="flex items-center gap-3">
          <NSlider
            v-bind="controlAttrs" role="group" :value="volumePercent" :min="0" :max="100" :step="1" :disabled="volumeDisabled"
            :format-tooltip="value => `${value}%`" @dragstart="draggingVolume = true" @dragend="commitVolume" @update:value="updateVolume"
          />
          <span class="min-w-[3ch] text-right text-[0.75rem] tabular-nums">{{ volumePercent }}%</span>
        </div>
      </DesktopSettingRow>
    </section>
  </DesktopSettingsGroup>
</template>

<style scoped lang="scss">
.notification-sound-choice :deep(.n-radio__label) {
  min-width: 0;
}
</style>
