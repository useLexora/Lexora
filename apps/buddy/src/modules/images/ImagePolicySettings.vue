<script setup lang="ts">
import type { ImageCandidate, ImagePolicy, ImageReadingCandidate, ImageTarget } from '@buddy-shared/images/imagePreferences'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { imagePolicyTargets } from '@buddy-shared/images/imagePreferences'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DesktopSettingRow } from '@/modules/settings/ui'
import DesktopSegmentedControl from '@/shared/ui/segmented-control/DesktopSegmentedControl.vue'
import ImageModelsSelect from './ImageModelsSelect.vue'

const props = defineProps<{ policy: ImagePolicy, operation: 'understand' | 'generate', candidates: (ImageCandidate | ImageReadingCandidate)[], language: BuddyLocale, disabled: boolean }>()
const emit = defineEmits<{ change: [policy: ImagePolicy] }>()
defineSlots<{ default?: () => unknown }>()
const { t } = useBuddyI18n(() => props.language)
const modes = computed(() => (['auto', 'selected', 'native'] as const).map(value => ({ value, label: t(`images.mode.${value}`) })))
const targets = computed(() => imagePolicyTargets(props.policy))
const candidates = computed(() => props.candidates.filter(candidate => candidate.support.operations.some(operation => props.operation === 'generate' ? operation === 'generate' || operation === 'edit' : operation === 'understand' || operation === 'document')))
function changeTargets(targets: ImageTarget[]) {
  emit('change', { ...props.policy, target: targets[0] ?? null, fallbacks: targets.slice(1) })
}
</script>

<template>
  <section class="border-b border-b-solid border-b-border last:border-b-0" :data-image-operation="operation">
    <DesktopSettingRow v-slot="{ controlAttrs }" :label="t(`images.${operation}`)">
      <DesktopSegmentedControl
        v-bind="controlAttrs"
        class="image-policy-mode justify-self-end"
        :model-value="policy.mode" :options="modes" :disabled="disabled"
        @update:model-value="emit('change', { ...policy, mode: $event })"
      />
    </DesktopSettingRow>
    <DesktopSettingRow v-if="policy.mode !== 'native'" v-slot="{ controlAttrs }" :label="t(policy.mode === 'auto' ? 'images.supplement' : 'images.model')" :error="policy.mode === 'selected' && !targets.length ? t('images.required') : null">
      <ImageModelsSelect v-bind="controlAttrs" :targets="targets" :candidates="candidates" :language="language" :placeholder="t(policy.mode === 'auto' ? 'images.optional' : 'images.choose')" :disabled="disabled" @change="changeTargets" />
    </DesktopSettingRow>
    <slot />
  </section>
</template>

<style scoped lang="scss">
.image-policy-mode {
  @container (max-width: 560px) {
    justify-self: start;
    max-width: 100%;
  }
}
</style>
