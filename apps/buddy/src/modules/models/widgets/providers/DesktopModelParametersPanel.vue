<script setup lang="ts">
import type { LocalCustomProviderModel, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'

import type { ModelParameterActions } from './typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NAlert, NButton, NInputNumber } from 'naive-ui'
import { computed, reactive, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopModelSectionHeader from './DesktopModelSectionHeader.vue'

const props = defineProps<{
  actions: ModelParameterActions
  language: BuddyLocale
  saving: boolean
  model: LocalRuntimeModelOption
  show: boolean
}>()
const { t } = useBuddyI18n(() => props.language)
const editing = shallowRef(false)
const form = reactive({ contextWindow: 1, maxTokens: 1 })
const valid = computed(() => (
  form.contextWindow > 0
  && form.maxTokens > 0
  && form.maxTokens <= form.contextWindow
))
const defaultParametersLabel = computed(() => t(
  !props.model.metadataKnown
    ? 'desktop.providers.unconfirmedParameters'
    : props.model.source === 'builtin'
      ? 'desktop.providers.catalogDefaultParameters'
      : 'desktop.providers.serviceDefaultParameters',
))

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
  form.contextWindow = props.model.contextWindow
  form.maxTokens = props.model.maxTokens
}

function startEditing() {
  resetForm()
  editing.value = true
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(props.language).format(value)
}

async function save() {
  if (!valid.value)
    return
  let succeeded: boolean
  if (props.model.source === 'manual' && !props.model.hasParameterOverride) {
    const input: LocalCustomProviderModel = {
      contextWindow: form.contextWindow,
      id: props.model.modelId,
      input: props.model.sourceCapabilities.image ? ['text', 'image'] : ['text'],
      maxTokens: form.maxTokens,
      name: props.model.displayName,
      reasoning: props.model.sourceCapabilities.reasoningOptions.some(level => level !== 'off'),
    }
    succeeded = await props.actions.saveManualModel(input)
  }
  else {
    succeeded = await props.actions.saveParameters({
      contextWindow: form.contextWindow,
      maxTokens: form.maxTokens,
    })
  }
  if (succeeded)
    editing.value = false
}

async function restoreDefaults() {
  if (await props.actions.restoreParameters())
    editing.value = false
}

async function keepCustomParameters() {
  await props.actions.acknowledgeSourceUpdate()
}
</script>

<template>
  <section class="desktop-model-parameters-panel overflow-hidden border border-solid border-border rounded-[0.65rem] bg-surface">
    <DesktopModelSectionHeader
      :label="t('desktop.providers.modelParameters')"
      :language="language"
      :editing="editing"
      :saving="saving"
      :valid="valid"
      @edit="startEditing"
      @cancel="editing = false"
      @save="save"
    />

    <NAlert
      v-if="model.sourceParametersUpdated && !editing"
      class="desktop-model-parameters-panel__notice"
      type="warning"
      :show-icon="false"
    >
      <div class="desktop-model-parameters-panel__notice-content">
        <div>
          <strong>{{ t('desktop.providers.sourceParametersUpdated') }}</strong>
          <span>{{ t('desktop.providers.sourceParametersUpdatedDescription') }}</span>
        </div>
        <div class="flex flex-none gap-[0.45rem]">
          <NButton size="small" :loading="saving" @click="keepCustomParameters">
            {{ t('desktop.providers.keepOverride') }}
          </NButton>
          <NButton size="small" type="primary" :loading="saving" @click="restoreDefaults">
            {{ t('desktop.providers.useUpdatedDefaultParameters') }}
          </NButton>
        </div>
      </div>
    </NAlert>

    <div v-if="editing" class="desktop-model-parameters-panel__form">
      <label>
        <span>{{ t('desktop.providers.contextWindow') }}</span>
        <NInputNumber v-model:value="form.contextWindow" :min="1" :precision="0" :disabled="saving" />
      </label>
      <label>
        <span>{{ t('desktop.providers.maxTokens') }}</span>
        <NInputNumber v-model:value="form.maxTokens" :min="1" :precision="0" :disabled="saving" />
      </label>
    </div>

    <dl v-else class="desktop-model-parameters-panel__metrics">
      <div>
        <dt>{{ t('desktop.providers.contextWindow') }}</dt>
        <dd>{{ formatTokens(model.contextWindow) }}</dd>
      </div>
      <div>
        <dt>{{ t('desktop.providers.maxTokens') }}</dt>
        <dd>{{ formatTokens(model.maxTokens) }}</dd>
      </div>
    </dl>

    <footer
      v-if="model.hasParameterOverride && !editing"
      class="desktop-model-parameters-panel__defaults border-t-1 border-t-solid border-t-border bg-subtle py-[0.65rem] px-4"
    >
      <div>
        <strong>{{ defaultParametersLabel }}</strong>
        <span>
          {{ t('desktop.providers.parameterPairSummary', {
            contextWindow: formatTokens(model.sourceContextWindow),
            maxTokens: formatTokens(model.sourceMaxTokens),
          }) }}
        </span>
      </div>
      <NButton size="small" @click="restoreDefaults">
        {{ t('desktop.providers.restoreDefaultParameters') }}
      </NButton>
    </footer>
  </section>
</template>

<style scoped lang="scss">
.desktop-model-parameters-panel__defaults,
.desktop-model-parameters-panel__notice-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.desktop-model-parameters-panel__defaults > div,
.desktop-model-parameters-panel__notice-content > div:first-child {
  display: grid;
  min-width: 0;
  gap: 0.18rem;
}

.desktop-model-parameters-panel__defaults strong,
.desktop-model-parameters-panel__notice-content strong {
  font-size: 0.76rem;
}

.desktop-model-parameters-panel__defaults span,
.desktop-model-parameters-panel__notice-content span {
  color: var(--buddy-text-secondary);
  font-size: 0.66rem;
  line-height: 1.5;
}

.desktop-model-parameters-panel__notice {
  margin: 0 1rem 0.9rem;
}

.desktop-model-parameters-panel__notice :deep(.n-alert-body),
.desktop-model-parameters-panel__notice :deep(.n-alert-body__content) {
  width: 100%;
}

.desktop-model-parameters-panel__metrics,
.desktop-model-parameters-panel__form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border-top: 1px solid var(--buddy-border-subtle);
  margin: 0;
}

.desktop-model-parameters-panel__metrics > div,
.desktop-model-parameters-panel__form > label {
  display: grid;
  min-width: 0;
  gap: 0.3rem;
  padding: 0.85rem 1rem;
}

.desktop-model-parameters-panel__metrics > div + div,
.desktop-model-parameters-panel__form > label + label {
  border-left: 1px solid var(--buddy-border-subtle);
}

.desktop-model-parameters-panel__metrics dt,
.desktop-model-parameters-panel__form label > span {
  color: var(--buddy-text-secondary);
  font-size: 0.65rem;
}

.desktop-model-parameters-panel__metrics dd {
  margin: 0;
  color: var(--buddy-text-strong);
  font-size: 0.9rem;
  font-variant-numeric: tabular-nums;
  font-weight: 620;
}

.desktop-model-parameters-panel__form :deep(.n-input-number) {
  width: 100%;
}

@media (max-width: 620px) {
  .desktop-model-parameters-panel__defaults,
  .desktop-model-parameters-panel__notice-content {
    align-items: stretch;
    flex-direction: column;
  }

  .desktop-model-parameters-panel__metrics,
  .desktop-model-parameters-panel__form {
    grid-template-columns: minmax(0, 1fr);
  }

  .desktop-model-parameters-panel__metrics > div + div,
  .desktop-model-parameters-panel__form > label + label {
    border-top: 1px solid var(--buddy-border-subtle);
    border-left: 0;
  }
}
</style>
