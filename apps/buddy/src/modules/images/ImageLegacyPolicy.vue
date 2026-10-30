<script setup lang="ts">
import type { ImageCandidate, ImagePolicy, ImageReadingCandidate } from '@buddy-shared/images/imagePreferences'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { imagePolicyTargets } from '@buddy-shared/images/imagePreferences'
import { NButton } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DesktopSettingRow } from '@/modules/settings/ui'

const props = defineProps<{ operation: 'document' | 'edit' | 'extract', policy: ImagePolicy, candidates: (ImageCandidate | ImageReadingCandidate)[], language: BuddyLocale, disabled: boolean }>()
const emit = defineEmits<{ inherit: [] }>()
const { t } = useBuddyI18n(() => props.language)
const summary = computed(() => [
  t(`images.mode.${props.policy.mode}`),
  ...imagePolicyTargets(props.policy).map(target => props.candidates.find(candidate => JSON.stringify(candidate.target) === JSON.stringify(target))?.title ?? target.modelId),
].join(' · '))
</script>

<template>
  <DesktopSettingRow :label="t(`images.legacy.${operation}`)" :description="summary" :disabled="disabled">
    <NButton class="justify-self-end" size="small" :disabled="disabled" @click="emit('inherit')">
      {{ t(operation === 'extract' ? 'images.clearLegacy' : operation === 'edit' ? 'images.followGeneration' : 'images.followVision') }}
    </NButton>
  </DesktopSettingRow>
</template>
