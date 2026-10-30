import type { LocalProvider } from '@buddy-shared/providers/providerApi'
import type { ModelPickerOption } from '../../model/modelCatalog'
import { computed, shallowRef } from 'vue'
import { groupModelOptions } from '../../model/modelCatalog'
import { modelKey } from '../../model/modelSelection'

interface ModelPickerInput {
  models: ReadonlyArray<ModelPickerOption>
  providers: ReadonlyArray<Pick<LocalProvider, 'id' | 'displayName'>>
  selectedModelId?: string | null
  selectedModelIds?: readonly string[]
}

export function useModelPicker(props: ModelPickerInput) {
  const query = shallowRef('')
  const activeProviderId = shallowRef(resolveSelectedProviderId() ?? props.models[0]?.providerId ?? null)

  const visibleGroups = computed(() => groupModelOptions(props.models, props.providers, query.value))
  const activeGroup = computed(() => (
    visibleGroups.value.find(group => group.providerId === activeProviderId.value)
    ?? visibleGroups.value.find(group => group.providerId === resolveSelectedProviderId())
    ?? visibleGroups.value[0]
    ?? null
  ))

  function resolveSelectedProviderId(): string | null {
    const selected = props.selectedModelIds?.[0] ?? props.selectedModelId
    return props.models.find(model => modelKey(model) === selected)?.providerId ?? null
  }

  return { query, activeProviderId, visibleGroups, activeGroup }
}
