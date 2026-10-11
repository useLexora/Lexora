<script setup lang="ts">
import type { LocalCustomProviderModel, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'

import type { ManualModelEditorActions } from './typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NInput } from 'naive-ui'
import { computed, reactive, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopModelSectionHeader from './DesktopModelSectionHeader.vue'

const props = defineProps<{
  actions: ManualModelEditorActions
  language: BuddyLocale
  saving: boolean
  model: LocalRuntimeModelOption
  show: boolean
}>()
const { t } = useBuddyI18n(() => props.language)
const editing = shallowRef(false)
const form = reactive({ name: '' })
const valid = computed(() => form.name.trim().length > 0)

watch([
  () => props.show,
  () => props.model.providerId,
  () => props.model.modelId,
], ([show]) => {
  if (!show)
    return
  editing.value = false
  resetForm()
}, { immediate: true })

function resetForm() {
  form.name = props.model.displayName
}

function startEditing() {
  resetForm()
  editing.value = true
}

async function save() {
  if (!valid.value)
    return
  const input: LocalCustomProviderModel = {
    contextWindow: props.model.sourceContextWindow,
    id: props.model.modelId,
    input: props.model.sourceCapabilities.image ? ['text', 'image'] : ['text'],
    maxTokens: props.model.sourceMaxTokens,
    name: form.name.trim(),
    reasoning: props.model.sourceCapabilities.reasoningOptions.some(level => level !== 'off'),
  }
  if (await props.actions.saveManualModel(input))
    editing.value = false
}
</script>

<template>
  <section class="desktop-manual-model-info-panel overflow-hidden border border-solid border-border rounded-[0.65rem] bg-surface">
    <DesktopModelSectionHeader
      :label="t('desktop.providers.modelInformation')"
      :language="language"
      :editing="editing"
      :saving="saving"
      :valid="valid"
      @edit="startEditing"
      @cancel="editing = false"
      @save="save"
    />

    <div v-if="editing" class="desktop-manual-model-info-panel__form">
      <label>
        <span>{{ t('desktop.providers.modelName') }}</span>
        <NInput v-model:value="form.name" :disabled="saving" />
      </label>
    </div>

    <dl v-else class="desktop-manual-model-info-panel__values">
      <div>
        <dt>{{ t('desktop.providers.displayName') }}</dt>
        <dd>{{ model.displayName }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped lang="scss">
.desktop-manual-model-info-panel__values,
.desktop-manual-model-info-panel__form {
  display: grid;
  border-top: 1px solid var(--buddy-border-subtle);
  margin: 0;
}

.desktop-manual-model-info-panel__values > div,
.desktop-manual-model-info-panel__form > label {
  display: grid;
  gap: 0.3rem;
  padding: 0.7rem 1rem;
}

.desktop-manual-model-info-panel__values > div + div {
  border-top: 1px solid var(--buddy-border-subtle);
}

.desktop-manual-model-info-panel__values dt,
.desktop-manual-model-info-panel__form label > span {
  color: var(--buddy-text-secondary);
  font-size: 0.65rem;
}

.desktop-manual-model-info-panel__values dd {
  overflow: hidden;
  margin: 0;
  color: var(--buddy-text-strong);
  font-size: 0.72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-manual-model-info-panel__form :deep(.n-input) {
  width: 100%;
}
</style>
