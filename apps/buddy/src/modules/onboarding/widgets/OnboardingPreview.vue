<script setup lang="ts">
import type { DesktopNavigationLayout } from '@buddy-shared/desktopNavigationLayout'
import { Add20Regular, Chat20Regular, Grid20Regular, Settings20Regular } from '@vicons/fluent'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { BuddyAvatar } from '@/modules/buddies/ui'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ name: string, avatar: string | null, language: string, layout: DesktopNavigationLayout, step: number }>()
const { t } = useBuddyI18n(() => props.language)
const navigation = [Chat20Regular, Grid20Regular, Settings20Regular]
</script>

<template>
  <aside class="onboarding-preview flex min-h-0 min-w-0 flex-col justify-center gap-8 rounded-[18px] bg-subtle p-8" aria-hidden="true">
    <div class="grid justify-items-start gap-5">
      <BuddyAvatar :src="avatar" buddy-id="default" class="size-24" />
      <div class="grid min-w-0 gap-3">
        <h2 class="m-0 line-clamp-2 break-words text-[28px] leading-[1.35] font-600">
          {{ t('onboarding.greeting', { name: name.trim() || 'Lexora' }) }}
        </h2>
        <p class="m-0 max-w-72 text-[14px] leading-[1.8] text-muted">
          {{ t(step === 2 ? 'onboarding.previewLayout' : 'onboarding.previewIntro') }}
        </p>
      </div>
    </div>
    <div class="onboarding-preview-window flex-none overflow-hidden rounded-lg border border-solid border-border bg-canvas" :data-preview-layout="layout">
      <div class="flex h-6 items-center gap-1 border-b border-b-solid border-b-border px-2">
        <span v-for="dot in 3" :key="dot" class="size-1 rounded-full bg-border-strong" />
      </div>
      <div class="onboarding-preview-workspace flex h-42">
        <div v-if="layout !== 'immersive'" class="flex flex-none flex-col gap-3 border-r border-r-solid border-r-border bg-app-sidebar p-2" :class="layout === 'full' ? 'w-[24%]' : 'w-8'">
          <span v-for="(icon, index) in navigation" :key="index" class="flex min-w-0 items-center gap-1.5 text-muted">
            <DesktopIcon :component="icon" :size="12" />
            <span v-if="layout === 'full'" class="h-1 min-w-0 flex-1 rounded bg-border-strong" />
          </span>
        </div>
        <div class="flex w-[28%] flex-none flex-col gap-2 border-r border-r-solid border-r-border bg-workspace-sidebar p-2">
          <span class="flex items-center gap-1 text-accent-text"><DesktopIcon :component="Add20Regular" :size="12" /><span class="h-1 flex-1 bg-accent-subtle" /></span>
          <span v-for="line in 3" :key="line" class="h-1 rounded bg-border" />
          <span v-if="layout === 'immersive'" class="mt-auto flex gap-2 text-muted"><DesktopIcon v-for="(icon, index) in navigation" :key="index" :component="icon" :size="12" /></span>
        </div>
        <div class="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-3">
          <BuddyAvatar :src="avatar" buddy-id="default" class="size-8" />
          <span class="w-full truncate text-center text-[10px] text-muted">{{ t('onboarding.previewPrompt') }}</span>
          <span class="flex h-7 w-full items-end justify-end rounded border border-solid border-border p-1"><span class="size-3 rounded-[3px] bg-accent" /></span>
        </div>
      </div>
    </div>
    <span class="text-[12px] leading-relaxed text-muted">{{ t('onboarding.changeLater') }}</span>
  </aside>
</template>

<style scoped lang="scss">
.onboarding-preview {
  @media (max-width: 1000px) {
    padding: 1.5rem;
    gap: 1.5rem;
  }
  @media (max-height: 700px) {
    gap: 1rem;
    .onboarding-preview-workspace {
      height: 7rem;
    }
  }
  @media (max-width: 780px) {
    display: none;
  }
}
</style>
