<script setup lang="ts">
import { Checkmark16Regular, ImageAdd24Regular } from '@vicons/fluent'
import { NButton, NInput } from 'naive-ui'
import { useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { BuddyAvatar } from '@/modules/buddies/ui'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ language: string, customAvatar: string | null, disabled: boolean }>()
const emit = defineEmits<{ upload: [file: File] }>()
const name = defineModel<string>('name', { required: true })
const avatar = defineModel<string | null>('avatar', { required: true })
const { t } = useBuddyI18n(() => props.language)
const input = useTemplateRef<HTMLInputElement>('file')
const presets = [
  { avatar: 'preset:actor-lexora', name: 'Lexora' },
  { avatar: 'preset:actor-deepseek', name: 'DeepSeek' },
  { avatar: 'preset:actor-chatgpt', name: 'ChatGPT' },
  { avatar: 'preset:actor-claude', name: 'Claude' },
]
function upload(event: Event) {
  const field = event.target as HTMLInputElement
  const file = field.files?.[0]
  field.value = ''
  if (file)
    emit('upload', file)
}
</script>

<template>
  <div class="grid gap-7">
    <div class="grid gap-3">
      <span class="text-[14px] font-600">{{ t('onboarding.avatar') }}</span>
      <div class="grid grid-cols-5 gap-2" role="group" :aria-label="t('onboarding.avatar')">
        <NButton v-for="preset in presets" :key="preset.avatar" class="onboarding-avatar relative h-auto min-w-0 px-1 py-3" :type="avatar === preset.avatar ? 'primary' : 'default'" :secondary="avatar === preset.avatar" :aria-pressed="avatar === preset.avatar" :disabled="disabled" @click="avatar = preset.avatar">
          <span class="grid justify-items-center gap-2">
            <BuddyAvatar :src="preset.avatar" class="size-12" />
            <span class="text-[12px]">{{ preset.name }}</span>
          </span>
          <DesktopIcon v-if="avatar === preset.avatar" :component="Checkmark16Regular" :size="13" class="absolute right-1 top-1" />
        </NButton>
        <NButton class="onboarding-avatar relative h-auto min-w-0 px-1 py-3" :dashed="!customAvatar" :type="customAvatar && avatar === customAvatar ? 'primary' : 'default'" :secondary="!!customAvatar && avatar === customAvatar" :aria-pressed="!!customAvatar && avatar === customAvatar" :disabled="disabled" @click="customAvatar ? avatar = customAvatar : input?.click()">
          <span class="grid justify-items-center gap-2">
            <BuddyAvatar v-if="customAvatar" :src="customAvatar" class="size-12" />
            <span v-else class="grid size-12 place-items-center text-muted"><DesktopIcon :component="ImageAdd24Regular" :size="24" /></span>
            <span class="text-[12px]">{{ t(customAvatar ? 'onboarding.customAvatar' : 'onboarding.upload') }}</span>
          </span>
          <DesktopIcon v-if="customAvatar && avatar === customAvatar" :component="Checkmark16Regular" :size="13" class="absolute right-1 top-1" />
        </NButton>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
        <span>{{ t('onboarding.avatarHint') }}</span>
        <NButton v-if="customAvatar" text size="tiny" :disabled="disabled" @click="input?.click()">
          {{ t('onboarding.replaceAvatar') }}
        </NButton>
      </div>
      <input ref="file" type="file" class="hidden" accept="image/png,image/jpeg,image/webp" :disabled="disabled" :aria-label="t('onboarding.upload')" @change="upload">
    </div>
    <div class="grid gap-2">
      <label for="onboarding-name" class="text-[14px] font-600">{{ t('onboarding.name') }}</label>
      <NInput v-model:value="name" :input-props="{ id: 'onboarding-name' }" :maxlength="80" :disabled="disabled" size="large" :placeholder="t('onboarding.namePlaceholder')" />
      <p class="m-0 text-[12px] leading-relaxed text-muted">
        {{ t('onboarding.identityHint') }}
      </p>
    </div>
  </div>
</template>

<style scoped lang="scss">
.onboarding-avatar:focus-visible {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: 3px;
}
</style>
