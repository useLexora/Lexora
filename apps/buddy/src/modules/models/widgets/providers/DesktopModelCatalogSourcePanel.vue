<script setup lang="ts">
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { ModelCatalogReference } from '@buddy-shared/providers/providerCatalog'
import type { ModelParameterActions } from './typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NTag } from 'naive-ui'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{
  model: LocalRuntimeModelOption
  actions: ModelParameterActions
  language: BuddyLocale
  disabled: boolean
  saving: boolean
  show: boolean
}>()
const { t } = useBuddyI18n(() => props.language)
const choosing = shallowRef(false)
const candidatesVisible = computed(() => choosing.value || props.model.catalogMatch !== 'matched')
const candidates = computed(() => props.model.catalog.candidates.map(candidate => ({
  ...candidate,
  key: JSON.stringify([candidate.providerId, candidate.modelId]),
  thinking: candidate.reasoningOptions.filter(level => level !== 'off').join(' / '),
  selected: candidate.providerId === props.model.catalog.selection?.providerId
    && candidate.modelId === props.model.catalog.selection?.modelId,
})))
let generation = 0

watch([() => props.show, () => props.model.providerId, () => props.model.modelId], () => {
  generation += 1
  choosing.value = false
}, { flush: 'sync' })
onScopeDispose(() => {
  generation += 1
})

async function selectSource(source: ModelCatalogReference | null) {
  if (props.disabled || props.saving)
    return
  const requestGeneration = generation
  const saved = await props.actions.selectCatalogSource(source)
  if (saved && generation === requestGeneration)
    choosing.value = false
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(props.language).format(value)
}
</script>

<template>
  <section class="desktop-model-catalog-source grid gap-[0.7rem] border border-solid border-border rounded-[0.6rem] p-3">
    <header class="desktop-model-catalog-source__header">
      <div>
        <strong>{{ t('desktop.providers.catalogSource') }}</strong>
        <p class="m-0 text-muted text-[0.72rem]">
          {{ t('desktop.providers.catalogSourceDescription') }}
        </p>
      </div>
      <NButton v-if="!candidatesVisible" size="small" quaternary @click="choosing = true">
        {{ t('desktop.providers.changeCatalogSource') }}
      </NButton>
    </header>
    <div v-if="model.catalog.source" class="desktop-model-catalog-source__current [overflow-wrap:anywhere] text-[0.75rem]">
      <strong>{{ model.catalog.source.providerName }}</strong>
      <span>{{ model.catalog.source.providerId }} / {{ model.catalog.source.modelId }}</span>
      <NTag size="small" :bordered="false">
        {{ t(model.catalog.selection ? 'desktop.providers.catalogSourceSelected' : 'desktop.providers.catalogSourceAutomatic') }}
      </NTag>
    </div>
    <p v-if="model.catalog.selection && model.catalogMatch !== 'matched'" class="m-0 text-muted text-[0.72rem]">
      {{ t('desktop.providers.catalogSelectionUnavailable') }}
      {{ model.catalog.selection.providerId }} / {{ model.catalog.selection.modelId }}
    </p>
    <p v-else-if="model.catalogMatch === 'ambiguous'" class="m-0 text-muted text-[0.72rem]">
      {{ t('desktop.providers.catalogSourceConflict') }}
    </p>
    <p v-else-if="!model.metadataKnown" class="m-0 text-muted text-[0.72rem]">
      {{ t('desktop.providers.catalogSourceUnknown') }}
    </p>
    <div v-if="candidatesVisible" class="desktop-model-catalog-source__candidates">
      <article v-for="candidate in candidates" :key="candidate.key" class="desktop-model-catalog-source__candidate border-t-1 border-t-solid border-t-border pt-[0.65rem] text-[0.75rem] [overflow-wrap:anywhere]">
        <div class="desktop-model-catalog-source__candidate-heading">
          <div>
            <strong>{{ candidate.providerName }} · {{ candidate.displayName }}</strong>
            <small>{{ candidate.providerId }} / {{ candidate.modelId }}</small>
          </div>
          <NButton
            size="small"
            :disabled="disabled || saving || candidate.selected"
            @click="selectSource({ providerId: candidate.providerId, modelId: candidate.modelId })"
          >
            {{ t(candidate.selected ? 'desktop.providers.catalogSourceSelected' : 'desktop.providers.useCatalogSource') }}
          </NButton>
        </div>
        <small>{{ t('desktop.providers.compactParameters', {
          contextWindow: formatTokens(candidate.contextWindow),
          maxTokens: formatTokens(candidate.maxTokens),
        }) }}</small>
        <div class="desktop-model-catalog-source__tags flex flex-wrap gap-[0.3rem]">
          <NTag size="small" :bordered="false">
            {{ t(candidate.input.includes('image') ? 'desktop.providers.imageAttachment' : 'desktop.providers.imageUnsupported') }}
          </NTag>
          <NTag size="small" :bordered="false">
            {{ candidate.thinking
              ? t('desktop.providers.thinkingLevelSummary', { levels: candidate.thinking })
              : t('desktop.providers.thinkingUnsupported') }}
          </NTag>
        </div>
        <details v-if="candidate.compatibility" class="desktop-model-catalog-source__compatibility">
          <summary>{{ t('desktop.providers.catalogCompatibility') }}</summary>
          <pre>{{ candidate.compatibility }}</pre>
        </details>
      </article>
    </div>
    <NButton v-if="model.catalog.selection" size="small" :disabled="disabled || saving" @click="selectSource(null)">
      {{ t('desktop.providers.restoreCatalogAutomatic') }}
    </NButton>
  </section>
</template>

<style scoped lang="scss">
.desktop-model-catalog-source__header,
.desktop-model-catalog-source__candidate-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
}

.desktop-model-catalog-source__header > div,
.desktop-model-catalog-source__candidate-heading > div,
.desktop-model-catalog-source__current {
  display: grid;
  min-width: 0;
  gap: 0.25rem;
}

.desktop-model-catalog-source__candidates,
.desktop-model-catalog-source__candidate {
  display: grid;
  min-width: 0;
  gap: 0.5rem;
}

.desktop-model-catalog-source__current {
  justify-items: start;
}

.desktop-model-catalog-source__tags :deep(.n-tag) {
  height: auto;
  min-height: 1.4rem;
}

.desktop-model-catalog-source__tags :deep(.n-tag__content) {
  white-space: normal;
}

.desktop-model-catalog-source__compatibility pre {
  overflow: auto;
  max-height: 10rem;
  font-size: 0.68rem;
}
</style>
