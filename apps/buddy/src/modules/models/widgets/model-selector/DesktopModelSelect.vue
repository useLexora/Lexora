<script setup lang="ts">
import type { LocalProvider } from '@buddy-shared/providers/providerApi'
import type { ModelPickerOption } from '../../model/modelCatalog'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronDown16Regular, Dismiss16Regular } from '@vicons/fluent'
import { useEventListener } from '@vueuse/core'
import { NButton, NPopover, NTooltip } from 'naive-ui'
import { computed, nextTick, shallowRef, useAttrs, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { modelKey } from '../../model/modelSelection'
import DesktopModelPicker from './DesktopModelPicker.vue'
import DesktopModelSelectionList from './DesktopModelSelectionList.vue'

defineOptions({ inheritAttrs: false })
const props = defineProps<{
  models: readonly ModelPickerOption[]
  providers: readonly Pick<LocalProvider, 'id' | 'displayName'>[]
  language: BuddyLocale
  multiple?: boolean
  disabled?: boolean
  placeholder?: string
  max?: number
  searchPlaceholder?: string
  emptyText?: string
  selectionLabel?: string
}>()
const value = defineModel<string[]>({ required: true })
const attrs = useAttrs()
const { t } = useBuddyI18n(() => props.language)
const show = shallowRef(false)
const trigger = useTemplateRef<InstanceType<typeof NButton>>('trigger')
const modelsById = computed(() => new Map(props.models.map(model => [modelKey(model), model])))
const providersById = computed(() => new Map(props.providers.map(provider => [provider.id, provider.displayName])))
const selected = computed(() => value.value.map((id) => {
  const model = modelsById.value.get(id)
  return {
    id,
    label: model?.displayName ?? id,
    source: model ? providersById.value.get(model.providerId) ?? model.providerId : '',
    unavailable: !model || Boolean(model.disabled),
  }
}))
const label = computed(() => selected.value[0]?.label ?? props.placeholder ?? t('desktop.models.selection.placeholder'))

useEventListener(document, 'keydown', (event) => {
  if (!show.value || event.key !== 'Escape' || event.defaultPrevented)
    return
  event.preventDefault()
  event.stopPropagation()
  show.value = false
  void nextTick(() => {
    const element = trigger.value?.$el
    if (!show.value && !props.disabled && element instanceof HTMLElement)
      element.focus({ preventScroll: true })
  })
}, { capture: true })

watch(() => props.disabled, (disabled) => {
  if (disabled)
    show.value = false
})
function remove(id: string) {
  if (!props.disabled)
    value.value = value.value.filter(selected => selected !== id)
}
function select(id: string) {
  if (props.disabled)
    return
  if (props.multiple && value.value.includes(id)) {
    remove(id)
    return
  }
  const model = modelsById.value.get(id)
  if (!model || model.disabled || (props.multiple && props.max !== undefined && value.value.length >= props.max))
    return
  value.value = props.multiple ? [...value.value, id] : [id]
  if (!props.multiple)
    show.value = false
}
function move(index: number, direction: -1 | 1) {
  const nextIndex = index + direction
  if (props.disabled || index < 0 || index >= value.value.length || nextIndex < 0 || nextIndex >= value.value.length)
    return
  const next = [...value.value]
  const [id] = next.splice(index, 1)
  next.splice(nextIndex, 0, id!)
  value.value = next
}
function clear() {
  if (!props.disabled)
    value.value = []
}
</script>

<template>
  <div class="desktop-model-select flex min-w-0 items-center gap-1">
    <NPopover v-model:show="show" class="buddy-raw-popover" trigger="click" placement="bottom-end" raw :show-arrow="false" :animated="false" :disabled="disabled" to=".buddy-app">
      <template #trigger>
        <NButton ref="trigger" v-bind="attrs" class="desktop-model-select__trigger min-w-0 flex-1" :disabled="disabled" aria-haspopup="menu" :aria-expanded="show">
          <span class="min-w-0 flex-1 truncate text-left" :class="disabled ? 'text-disabled' : selected.length ? 'text-fg' : 'text-muted'">{{ label }}</span>
          <span v-if="selected.length > 1" class="shrink-0 rounded-micro bg-subtle px-1.5 py-0.5 text-xs" :class="disabled ? 'text-disabled' : 'text-muted'">+{{ selected.length - 1 }}</span>
          <DesktopIcon :component="ChevronDown16Regular" class="shrink-0" :class="disabled ? 'text-disabled' : 'text-muted'" />
        </NButton>
      </template>
      <DesktopModelPicker
        :language="language" :models="models" :providers="providers" :selected-model-id="value[0] ?? null"
        :search-placeholder="searchPlaceholder" :empty-text="emptyText"
        :selected-model-ids="value" :multiple="multiple" :disabled="disabled" :max="max"
        @select="select"
      >
        <template v-if="selected.length" #selection>
          <DesktopModelSelectionList :label="selectionLabel" :items="selected" :language="language" :disabled="disabled" :ordered="Boolean(multiple)" @remove="remove" @move="move" />
        </template>
      </DesktopModelPicker>
    </NPopover>
    <NTooltip v-if="selected.length">
      <template #trigger>
        <NButton quaternary class="buddy-icon-button shrink-0" :disabled="disabled" :aria-label="t('desktop.models.selection.clear')" @click="clear">
          <template #icon>
            <DesktopIcon :component="Dismiss16Regular" />
          </template>
        </NButton>
      </template>
      {{ t('desktop.models.selection.clear') }}
    </NTooltip>
  </div>
</template>

<style scoped lang="scss">
.desktop-model-select__trigger :deep(.n-button__content) {
  width: 100%;
  min-width: 0;
  gap: 0.5rem;
  justify-content: space-between;
}
</style>
