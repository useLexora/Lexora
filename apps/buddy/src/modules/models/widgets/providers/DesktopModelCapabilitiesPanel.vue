<script setup lang="ts">
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { ModelParameterActions } from './typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NCheckbox } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopModelCapabilityTags from './DesktopModelCapabilityTags.vue'
import DesktopModelSectionHeader from './DesktopModelSectionHeader.vue'
import { useModelCapabilitiesForm } from './useModelCapabilitiesForm'

const props = defineProps<{
  model: LocalRuntimeModelOption
  actions: ModelParameterActions
  language: BuddyLocale
  saving: boolean
  disabled: boolean
  show: boolean
}>()
const { t } = useBuddyI18n(() => props.language)
const { editing, form, editableInputs, hasOverride, submitting, startEditing, save, restore } = useModelCapabilitiesForm({
  section: 'input',
  model: () => props.model,
  show: () => props.show,
  disabled: () => props.disabled || props.saving,
  save: capabilities => props.actions.saveCapabilities(capabilities),
})
const locked = computed(() => props.disabled || props.saving || submitting.value)
</script>

<template>
  <section class="desktop-model-capabilities-panel overflow-hidden border border-solid border-border rounded-[0.65rem] bg-surface">
    <DesktopModelSectionHeader
      :label="t('desktop.providers.modelCapabilities')"
      :language="language"
      :editing="editing"
      :saving="saving || submitting"
      :disabled="disabled"
      :can-restore="hasOverride"
      @edit="startEditing"
      @cancel="editing = false"
      @save="save"
      @restore="restore"
    />
    <div v-if="editing" class="desktop-model-capabilities-panel__form">
      <NCheckbox v-model:checked="form.image" size="small" :disabled="locked">
        {{ t('desktop.providers.imageAttachment') }}
      </NCheckbox>
      <NCheckbox v-model:checked="form.pdf" size="small" :disabled="locked || !editableInputs.pdf">
        {{ t('desktop.providers.pdfAttachment') }}
      </NCheckbox>
      <NCheckbox v-model:checked="form.audio" size="small" :disabled="locked || !editableInputs.audio">
        {{ t('desktop.providers.audioAttachment') }}
      </NCheckbox>
      <NCheckbox v-model:checked="form.video" size="small" :disabled="locked || !editableInputs.video">
        {{ t('desktop.providers.videoAttachment') }}
      </NCheckbox>
    </div>
    <div v-else class="desktop-model-capabilities-panel__summary">
      <DesktopModelCapabilityTags :model="model" :language="language" :compact="false" />
    </div>
  </section>
</template>

<style scoped lang="scss">
.desktop-model-capabilities-panel__form,
.desktop-model-capabilities-panel__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem 1rem;
  border-top: 1px solid var(--buddy-border-subtle);
  padding: 0.85rem 1rem;
}
</style>
