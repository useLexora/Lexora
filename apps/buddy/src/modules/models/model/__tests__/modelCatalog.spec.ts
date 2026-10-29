import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import { useModelPicker } from '../../widgets/model-selector/useModelPicker'
import { groupModelOptions } from '../modelCatalog'
import { modelKey, resolveConcreteEffort, resolveModelConfigurationIssue } from '../modelSelection'

const providers = [
  { id: 'beta', displayName: 'Beta Service' },
  { id: 'alpha', displayName: 'Alpha Service' },
]
const models = [model('alpha', 'shared-id'), model('beta', 'shared-id'), model('beta', 'other-id')]

describe('model catalog selection', () => {
  it('uses provider identity and configured order while retaining model order', () => {
    const groups = groupModelOptions([...models, model('unknown', 'fallback')], providers, '')
    expect(groups.map(group => [group.providerId, group.providerName])).toEqual([
      ['beta', 'Beta Service'],
      ['alpha', 'Alpha Service'],
      ['unknown', 'unknown'],
    ])
    expect(groups[0]?.models.map(modelKey)).toEqual(['beta:shared-id', 'beta:other-id'])
  })

  it('matches trimmed search against provider name, model name and model ID', () => {
    expect(groupModelOptions(models, providers, '  ALPHA SERVICE ').map(group => group.providerId)).toEqual(['alpha'])
    expect(groupModelOptions(models, providers, 'OTHER-ID')[0]?.models.map(modelKey)).toEqual(['beta:other-id'])
    expect(groupModelOptions([model('alpha', 'opaque', 'Human friendly')], providers, 'friendly')[0]?.models[0]?.modelId).toBe('opaque')
    expect(groupModelOptions(models, providers, 'missing')).toEqual([])
  })

  it('falls back within visible groups without losing the explicitly browsed provider', () => {
    const input = reactive({
      models,
      providers,
      selectedModelId: 'alpha:shared-id' as string | null,
    })
    const picker = useModelPicker(input)
    expect(picker.activeGroup.value?.providerId).toBe('alpha')
    picker.activeProviderId.value = 'beta'
    picker.query.value = 'alpha'
    expect(picker.activeGroup.value?.providerId).toBe('alpha')
    picker.query.value = ''
    expect(picker.activeGroup.value?.providerId).toBe('beta')
    input.models = [models[0]!]
    expect(picker.activeGroup.value?.providerId).toBe('alpha')
    input.models = []
    expect(picker.activeGroup.value).toBeNull()
  })

  it('reports unsupported explicit settings while preserving nullable defaults', () => {
    const option = { ...models[0]!, reasoningOptions: ['off', 'low'] as const }
    expect(resolveModelConfigurationIssue(option, { reasoning: null, serviceTier: null })).toBeNull()
    expect(resolveModelConfigurationIssue(option, { reasoning: 'xhigh', serviceTier: null })).toBe('reasoning_unsupported')
    expect(resolveModelConfigurationIssue(option, { reasoning: 'low', serviceTier: 'priority' })).toBe('service_tier_unsupported')
    expect(resolveModelConfigurationIssue({ ...option, serviceTiers: [{ id: 'priority', displayName: 'Fast' }] }, { reasoning: 'low', serviceTier: 'priority' })).toBeNull()
  })

  it('resolves valid reasoning with the same fallback used by the selector and default model', () => {
    const option = { ...models[0]!, reasoningOptions: ['off', 'low', 'high'] as const }
    expect(resolveConcreteEffort(option, 'high')).toBe('high')
    expect(resolveConcreteEffort(option, 'xhigh')).toBe('low')
    expect(resolveConcreteEffort({ ...option, reasoningOptions: ['off'] }, null)).toBe('off')
    expect(resolveConcreteEffort({ ...option, reasoningOptions: [] }, null)).toBeNull()
  })
})

function model(providerId: string, modelId: string, displayName = modelId): LocalRuntimeModelOption {
  return {
    available: true,
    type: 'chat',
    sourceType: 'chat',
    typeOverride: null,
    catalogMatch: 'not_applicable',
    catalog: { source: null, selection: null, candidates: [] },
    metadataKnown: true,
    capabilityOverrides: null,
    fileInputMimeTypes: [],
    sourceCapabilities: { image: false, reasoningOptions: ['off'] },
    api: 'openai-completions',
    capabilities: ['text'],
    contextWindow: 4096,
    displayName,
    enabled: true,
    hasParameterOverride: false,
    lastSeenAt: null,
    maxTokens: 1024,
    modelId,
    overrideContextWindow: null,
    overrideMaxTokens: null,
    providerId,
    reasoningOptions: [],
    serviceTiers: [],
    source: 'builtin',
    sourceContextWindow: 4096,
    sourceMaxTokens: 1024,
    sourceParametersUpdated: false,
  }
}
