<script setup lang="ts">
import type { SpeechKind } from '@buddy-shared/speech/speechApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronDown16Regular } from '@vicons/fluent'
import { NButton, NPopover } from 'naive-ui'
import { computed, shallowRef, useAttrs, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { modelKey } from '@/modules/models'
import { DesktopModelPicker } from '@/modules/models/ui'
import { useSpeechCatalog } from '@/modules/speech'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ language: BuddyLocale, kind: SpeechKind, value: string | null, disabled: boolean, loading: boolean }>()
const emit = defineEmits<{ select: [id: string] }>()
const attrs = useAttrs()
const { t } = useBuddyI18n(() => props.language)
const { catalog } = useSpeechCatalog()
const show = shallowRef(false)
const models = computed(() => catalog.value.providers.filter(item => item.kind === props.kind && item.supported).map(model => ({
  speechId: model.id,
  providerId: model.providerId ?? model.id,
  modelId: model.modelId ?? model.id,
  displayName: model.title,
  providerName: model.source ?? model.providerId ?? model.title,
})))
const providers = computed(() => [...new Map(models.value.map(model => [model.providerId, { id: model.providerId, displayName: model.providerName }])).values()])
const selected = computed(() => models.value.find(model => model.speechId === props.value))
const label = computed(() => selected.value ? `${selected.value.providerName} / ${selected.value.displayName}` : t(props.kind === 'speech.synthesize' ? 'speech.selectOutput' : 'speech.selectInput'))
watch(() => props.disabled || props.loading, (disabled) => {
  if (disabled)
    show.value = false
})
function select(key: string) {
  const model = models.value.find(model => modelKey(model) === key)
  if (props.disabled || props.loading || !model)
    return
  show.value = false
  emit('select', model.speechId)
}
</script>

<template>
  <div class="desktop-speech-model-select grid min-w-0 gap-2" :aria-busy="loading">
    <NPopover v-model:show="show" class="buddy-raw-popover" trigger="click" placement="bottom-end" raw :show-arrow="false" :animated="false" :disabled="disabled || loading" to=".buddy-app">
      <template #trigger>
        <NButton v-bind="attrs" class="desktop-speech-model-select__trigger w-full min-w-0" :disabled="disabled" :loading="loading" aria-haspopup="menu" :aria-expanded="show" @keydown.esc.stop.prevent="show = false">
          <span class="min-w-0 flex-1 truncate text-left" :class="selected ? 'text-fg' : 'text-muted'">{{ label }}</span>
          <DesktopIcon :component="ChevronDown16Regular" class="shrink-0 text-muted" />
        </NButton>
      </template>
      <DesktopModelPicker :language="language" :models="models" :providers="providers" :selected-model-id="selected ? modelKey(selected) : null" :disabled="disabled || loading" @select="select" @keydown.esc.stop.prevent="show = false" />
    </NPopover>
  </div>
</template>

<style scoped lang="scss">
.desktop-speech-model-select__trigger :deep(.n-button__content) {
  width: 100%;
  min-width: 0;
  gap: 0.5rem;
  justify-content: space-between;
}
</style>
