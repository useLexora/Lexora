<script setup lang="ts">
import type { ApplicationSettingsProps } from './typing'
import { DEFAULT_DESKTOP_CHAT_PREFERENCES } from '@buddy-electron/shared/desktopApi'
import { WELCOME_COMPANION_IMAGE_MIME_TYPES } from '@buddy-electron/shared/welcomeCompanionImage'
import { NButton, NScrollbar, NSwitch, useMessage } from 'naive-ui'
import { computed, onBeforeUnmount, shallowRef, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { resolveCompanionStickerImage } from '@/shared/branding/welcome/companionStickers'
import { readWelcomeCompanionImage, WelcomeCompanionImageError } from '../../state/readWelcomeCompanionImage'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'

const props = defineProps<ApplicationSettingsProps & { disabled: boolean }>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const { pending, save } = useSettingMutation<'image' | 'enabled'>(
  patch => props.updateSettings(patch),
  () => message.error(t('desktop.settings.saveFailed')),
)
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
const reading = shallowRef(false)
const error = shallowRef<'type' | 'size' | 'read' | null>(null)
const preferences = computed(() => props.config?.desktop.chat ?? DEFAULT_DESKTOP_CHAT_PREFERENCES)
const image = computed(() => preferences.value.welcomeCompanionImage)
const busy = computed(() => reading.value || pending.value.size > 0)
const canSelect = computed(() => !props.disabled && preferences.value.welcomeCompanionEnabled)
const options = computed(() => [
  { label: t('desktop.settings.welcomeImageLexora'), value: 'lexora' },
  { label: t('desktop.settings.welcomeImageWhale'), value: 'whale' },
  ...preferences.value.welcomeCompanionImages.map((value, index) => ({
    label: t('desktop.settings.welcomeImageCustom', { index: index + 1 }),
    value,
  })),
])
const errorText = computed(() => error.value
  ? t(error.value === 'size' ? 'desktop.settings.welcomeImageTooLarge' : error.value === 'type' ? 'desktop.settings.welcomeImageInvalid' : 'desktop.settings.welcomeImageReadFailed')
  : null)
let disposed = false
onBeforeUnmount(() => {
  disposed = true
})

async function setEnabled(value: boolean) {
  if (props.disabled || busy.value)
    return
  try {
    await save('enabled', { desktop: { chat: { welcomeCompanionEnabled: value } } })
  }
  catch {}
}

async function selectImage(value: string) {
  if (!canSelect.value || busy.value || value === image.value)
    return
  error.value = null
  try {
    await save('image', { desktop: { chat: { welcomeCompanionImage: value } } })
  }
  catch {}
}

async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || busy.value)
    return
  error.value = null
  reading.value = true
  try {
    const value = await readWelcomeCompanionImage(file)
    if (disposed)
      return
    const welcomeCompanionImages = [...new Set([...preferences.value.welcomeCompanionImages, value])]
    await save('image', { desktop: { chat: {
      welcomeCompanionImages,
      ...(canSelect.value ? { welcomeCompanionImage: value } : {}),
    } } })
  }
  catch (cause) {
    if (!disposed && cause instanceof WelcomeCompanionImageError)
      error.value = cause.reason
  }
  finally {
    reading.value = false
  }
}
</script>

<template>
  <section class="min-w-0" data-testid="companion-stickers">
    <DesktopSettingRow
      v-slot="{ controlAttrs }" :label="t('desktop.settings.welcomeCompanion')" :description="t('desktop.settings.welcomeImageDescription')"
      :error="errorText" toggle class="!border-b-0"
    >
      <NSwitch
        v-bind="controlAttrs" :round="false" :value="preferences.welcomeCompanionEnabled"
        :loading="pending.has('enabled')" :disabled="disabled || busy" :aria-disabled="disabled || busy" @update:value="setEnabled"
      />
      <NButton size="small" :disabled="busy" :loading="reading || pending.has('image')" @click="fileInput?.click()">
        {{ t('desktop.settings.welcomeImageUpload') }}
      </NButton>
      <input
        ref="fileInput" class="hidden" type="file" :accept="WELCOME_COMPANION_IMAGE_MIME_TYPES.join(',')"
        :disabled="busy" @change="upload"
      >
    </DesktopSettingRow>
    <div class="min-w-0 px-[0.9rem] pb-[0.9rem]">
      <NScrollbar x-scrollable content-style="width: max-content; min-width: 100%">
        <div class="flex w-max min-w-full gap-3 p-1" role="group" :aria-label="t('desktop.settings.welcomeCompanion')">
          <NButton
            v-for="option in options" :key="option.value"
            class="companion-sticker-choice h-auto w-[7rem] flex-none py-3"
            :type="image === option.value ? 'primary' : 'default'" :secondary="image === option.value"
            :disabled="!canSelect || busy" :aria-pressed="image === option.value"
            @click="selectImage(option.value)"
          >
            <span class="flex flex-col items-center gap-2">
              <img
                :src="resolveCompanionStickerImage(option.value)" class="h-[5rem] w-[5rem] object-contain select-none"
                :class="{ '-scale-x-100': option.value === 'whale' }" alt="" draggable="false"
              >
              <span class="text-[12px]">{{ option.label }}</span>
            </span>
          </NButton>
        </div>
      </NScrollbar>
    </div>
  </section>
</template>

<style scoped lang="scss">
.companion-sticker-choice:focus-visible {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: 2px;
}
</style>
