import type { LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'

export type ModelPickerOption = Pick<LocalRuntimeModelOption, 'providerId' | 'modelId' | 'displayName'> & {
  disabled?: boolean
}

export interface ModelGroup {
  models: ReadonlyArray<ModelPickerOption>
  providerId: string
  providerName: string
}

export function groupModelOptions(
  models: ReadonlyArray<ModelPickerOption>,
  providers: ReadonlyArray<Pick<LocalProvider, 'id' | 'displayName'>>,
  query: string,
): ReadonlyArray<ModelGroup> {
  const providerNames = new Map(providers.map(provider => [provider.id, provider.displayName]))
  const providerOrder = new Map(providers.map((provider, index) => [provider.id, index]))
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const groups = new Map<string, ModelPickerOption[]>()
  for (const model of models) {
    const providerName = providerNames.get(model.providerId) ?? model.providerId
    if (normalizedQuery && ![providerName, model.displayName, model.modelId]
      .some(value => value.toLocaleLowerCase().includes(normalizedQuery))) {
      continue
    }
    const group = groups.get(model.providerId) ?? []
    group.push(model)
    groups.set(model.providerId, group)
  }
  return [...groups].map(([providerId, models]) => ({
    models,
    providerId,
    providerName: providerNames.get(providerId) ?? providerId,
  })).sort((left, right) => (
    (providerOrder.get(left.providerId) ?? Number.MAX_SAFE_INTEGER)
    - (providerOrder.get(right.providerId) ?? Number.MAX_SAFE_INTEGER)
    || left.providerName.localeCompare(right.providerName)
  ))
}
