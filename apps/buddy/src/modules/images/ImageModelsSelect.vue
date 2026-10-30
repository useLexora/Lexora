<script setup lang="ts">
import type { ImageCandidate, ImageReadingCandidate, ImageTarget } from '@buddy-shared/images/imagePreferences'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ModelPickerOption } from '@/modules/models/ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { modelKey } from '@/modules/models'
import { DesktopModelSelect } from '@/modules/models/ui'

defineOptions({ inheritAttrs: false })
const props = defineProps<{
  targets: readonly ImageTarget[]
  candidates: readonly (ImageCandidate | ImageReadingCandidate)[]
  language: BuddyLocale
  disabled?: boolean
  placeholder: string
}>()
const emit = defineEmits<{ change: [targets: ImageTarget[]] }>()
const { t } = useBuddyI18n(() => props.language)
function identity(target: ImageTarget) {
  return { providerId: target.kind === 'plugin' ? `plugin:${target.extensionId}` : target.providerId, modelId: target.modelId }
}
const catalog = computed(() => {
  const models = new Map<string, ModelPickerOption>()
  const providers = new Map<string, { id: string, displayName: string }>()
  const targets = new Map<string, ImageTarget>()
  for (const candidate of props.candidates) {
    const item = identity(candidate.target)
    const id = modelKey(item)
    models.set(id, { ...item, displayName: candidate.title, disabled: !candidate.available })
    providers.set(item.providerId, { id: item.providerId, displayName: candidate.owner })
    targets.set(id, candidate.target)
  }
  for (const target of props.targets) {
    const item = identity(target)
    const id = modelKey(item)
    if (!models.has(id))
      models.set(id, { ...item, displayName: target.modelId, disabled: true })
    if (!providers.has(item.providerId))
      providers.set(item.providerId, { id: item.providerId, displayName: t('images.unavailable') })
    targets.set(id, target)
  }
  return { models: [...models.values()], providers: [...providers.values()], targets }
})
const selected = computed(() => props.targets.map(target => modelKey(identity(target))))
function change(ids: readonly string[]) {
  emit('change', ids.flatMap(id => catalog.value.targets.get(id) ?? []))
}
</script>

<template>
  <DesktopModelSelect
    v-bind="$attrs"
    :model-value="selected"
    :models="catalog.models"
    :providers="catalog.providers"
    :language="language"
    :disabled="disabled"
    :placeholder="placeholder"
    :max="5"
    multiple
    @update:model-value="change"
  />
</template>
