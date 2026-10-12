<script setup lang="ts">
import type { LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import { Checkmark16Regular, ImageAdd24Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import { computed, useTemplateRef } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { buddyLabels } from '../buddyLabels'
import { buddyAvatarPresets } from '../model/buddyAvatarPresets'
import BuddyAvatar from './BuddyAvatar.vue'

const props = defineProps<{
  kind: LocalBuddy['kind']
  buddyId?: string
  avatar: string | null
  customAvatar: string | null
  language: string
  disabled: boolean
}>()
const emit = defineEmits<{ select: [source: string | null], upload: [file: File] }>()
const labels = computed(() => buddyLabels(props.language))
const presets = computed(() => buddyAvatarPresets(props.kind))
const defaultSource = computed(() => props.buddyId ? null : presets.value[0]?.src ?? null)
const input = useTemplateRef<HTMLInputElement>('file')
function upload(event: Event) {
  const field = event.target as HTMLInputElement
  const file = field.files?.[0]
  field.value = ''
  if (file)
    emit('upload', file)
}
</script>

<template>
  <section class="flex min-w-0 flex-col gap-3" data-testid="buddy-avatar-picker">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="m-0 text-[14px] font-600 text-fg">
        {{ labels.avatarLabel }}
      </h2>
      <p class="m-0 text-[13px] leading-relaxed text-muted">
        {{ labels.chooseAvatarHint }}
      </p>
    </div>
    <div class="flex min-w-0 items-center gap-4">
      <BuddyAvatar :buddy-id="buddyId" :src="avatar" class="size-[80px] bg-subtle" data-testid="buddy-avatar" />
      <div class="buddy-avatar-gallery grid min-w-0 flex-1 grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-2 max-h-[180px] overflow-y-auto p-1 -m-1" role="group" :aria-label="labels.presetAvatars">
        <NButton
          v-for="preset in presets"
          :key="preset.id"
          class="buddy-avatar-choice relative h-auto min-w-0 py-3"
          :type="avatar === preset.src ? 'primary' : 'default'"
          :secondary="avatar === preset.src"
          :disabled="disabled"
          :aria-pressed="avatar === preset.src"
          :data-testid="`buddy-avatar-preset-${preset.id}`"
          @click="emit('select', preset.src)"
        >
          <span class="flex min-w-0 flex-col items-center gap-2">
            <BuddyAvatar :src="preset.src" class="size-[48px]" />
            <span class="text-[12px]">{{ labels[preset.label] }}</span>
          </span>
          <DesktopIcon v-if="avatar === preset.src" :component="Checkmark16Regular" :size="14" class="absolute right-1 top-1" />
        </NButton>
        <NButton
          v-if="customAvatar"
          class="buddy-avatar-choice relative h-auto min-w-0 py-3"
          :type="avatar === customAvatar ? 'primary' : 'default'"
          :secondary="avatar === customAvatar"
          :disabled="disabled"
          :aria-pressed="avatar === customAvatar"
          data-testid="buddy-avatar-custom"
          @click="emit('select', customAvatar)"
        >
          <span class="flex min-w-0 flex-col items-center gap-2">
            <BuddyAvatar :src="customAvatar" class="size-[48px]" />
            <span class="text-[12px]">{{ labels.customAvatar }}</span>
          </span>
          <DesktopIcon v-if="avatar === customAvatar" :component="Checkmark16Regular" :size="14" class="absolute right-1 top-1" />
        </NButton>
        <NButton class="buddy-avatar-choice h-auto min-w-0 py-3" dashed :disabled="disabled" @click="input?.click()">
          <span class="flex flex-col items-center gap-2">
            <span class="flex size-[48px] items-center justify-center text-muted">
              <DesktopIcon :component="ImageAdd24Regular" :size="24" />
            </span>
            <span class="text-[12px]">{{ labels.uploadAvatar }}</span>
          </span>
        </NButton>
      </div>
    </div>
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <p class="m-0 text-[12px] leading-relaxed text-muted">
        {{ labels.imageHint }}
      </p>
      <NButton v-if="avatar !== defaultSource" text size="tiny" :disabled="disabled" @click="emit('select', defaultSource)">
        {{ labels.reset }}
      </NButton>
    </div>
    <input ref="file" class="hidden" type="file" accept="image/png,image/jpeg,image/webp" :aria-label="labels.avatar" :disabled="disabled" @change="upload">
  </section>
</template>

<style scoped lang="scss">
.buddy-avatar-choice:focus-visible {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: 2px;
}
</style>
