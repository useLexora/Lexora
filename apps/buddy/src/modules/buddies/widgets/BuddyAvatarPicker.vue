<script setup lang="ts">
import type { LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import { Checkmark16Regular, ImageAdd24Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import { computed, useTemplateRef } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { buddyLabels } from '../buddyLabels'
import { buddyAvatarPresets, buddyPresetAvatar, defaultBuddyAvatar } from '../model/buddyAvatarPresets'
import BuddyAvatar from './BuddyAvatar.vue'

const props = defineProps<{
  kind: LocalBuddy['kind']
  buddyId?: string
  avatar: string | null
  customAvatars: readonly string[]
  language: string
  disabled: boolean
}>()
const emit = defineEmits<{ select: [source: string | null], upload: [files: File[]], remove: [source: string] }>()
const labels = computed(() => buddyLabels(props.language))
const presets = computed(() => buddyAvatarPresets(props.kind))
const defaultSource = computed(() => defaultBuddyAvatar(props.kind, props.buddyId))
const selectedAvatar = computed(() => props.avatar ?? (props.kind === 'actor' ? buddyPresetAvatar('actor-lexora') : null))
const input = useTemplateRef<HTMLInputElement>('file')
function upload(event: Event) {
  const field = event.target as HTMLInputElement
  const files = Array.from(field.files ?? [])
  field.value = ''
  if (files.length)
    emit('upload', files)
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
    <div class="flex min-w-0 items-start gap-4">
      <BuddyAvatar :buddy-id="buddyId" :src="avatar" class="size-[80px] bg-subtle" data-testid="buddy-avatar" />
      <div class="buddy-avatar-gallery grid min-w-0 flex-1 grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-2" role="group" :aria-label="labels.presetAvatars">
        <NButton
          v-for="preset in presets"
          :key="preset.id"
          class="buddy-avatar-choice relative h-auto min-w-0 py-3"
          :type="selectedAvatar === buddyPresetAvatar(preset.id) ? 'primary' : 'default'"
          :secondary="selectedAvatar === buddyPresetAvatar(preset.id)"
          :disabled="disabled"
          :aria-pressed="selectedAvatar === buddyPresetAvatar(preset.id)"
          :data-testid="`buddy-avatar-preset-${preset.id}`"
          @click="emit('select', buddyPresetAvatar(preset.id))"
        >
          <span class="flex min-w-0 flex-col items-center gap-2">
            <BuddyAvatar :src="preset.src" class="size-[48px]" />
            <span class="text-[12px]">{{ labels[preset.label] }}</span>
          </span>
          <DesktopIcon v-if="selectedAvatar === buddyPresetAvatar(preset.id)" :component="Checkmark16Regular" :size="14" class="absolute right-1 top-1" />
        </NButton>
        <div v-for="(source, index) in customAvatars" :key="source" class="relative min-w-0" data-testid="buddy-avatar-custom">
          <NButton
            class="buddy-avatar-choice relative h-auto w-full min-w-0 py-3"
            :type="avatar === source ? 'primary' : 'default'"
            :secondary="avatar === source"
            :disabled="disabled"
            :aria-pressed="avatar === source"
            @click="emit('select', source)"
          >
            <span class="flex min-w-0 flex-col items-center gap-2">
              <BuddyAvatar :src="source" class="size-[48px]" />
              <span class="text-[12px]">{{ labels.customAvatarName(index + 1) }}</span>
            </span>
            <DesktopIcon v-if="avatar === source" :component="Checkmark16Regular" :size="14" class="absolute left-1 top-1" />
          </NButton>
          <NButton
            class="buddy-icon-button absolute right-1 top-1"
            quaternary
            size="tiny"
            :disabled="disabled"
            :aria-label="labels.deleteAvatar(index + 1)"
            @click="emit('remove', source)"
          >
            <template #icon>
              <DesktopIcon name="delete" :size="14" />
            </template>
          </NButton>
        </div>
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
    <input ref="file" class="hidden" type="file" multiple accept="image/png,image/jpeg,image/webp" :aria-label="labels.avatar" :disabled="disabled" @change="upload">
  </section>
</template>

<style scoped lang="scss">
.buddy-avatar-choice:focus-visible {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: 2px;
}
</style>
