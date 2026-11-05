import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { ModelCapabilities, ModelCapabilityOverrides } from '@buddy-shared/providers/providerCapabilities'
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { useModelCapabilitiesForm } from '../useModelCapabilitiesForm'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))

describe('independent model capability editing', () => {
  it('shows effective inputs and prevents protocol-incompatible overrides from being edited', async () => {
    const { input, model } = createForms({ video: true })
    model.value = { ...model.value, api: 'openai-completions', capabilities: ['text', 'audio'] }
    input.startEditing()
    expect(input.form.video).toBe(false)
    expect(input.editableInputs.value).toEqual({ image: true, pdf: true, audio: true, video: false, toolCall: true })
    input.form.video = true
    input.form.image = true
    await input.save()
    expect(model.value.capabilityOverrides).toEqual({ image: true, video: true })
    await input.restore()
    expect(model.value.capabilityOverrides).toBeNull()
  })
  it('saves only changed inputs and tool support while keeping edits in the other open section', async () => {
    const { input, thinking, model, updateSource } = createForms()
    updateSource({ toolCall: false })
    input.startEditing()
    thinking.startEditing()
    expect(input.form.toolCall).toBe(false)
    input.form.image = true
    input.form.toolCall = true
    thinking.updateLevels(['high'])
    updateSource({ pdf: true })
    await input.save()
    expect(model.value.capabilityOverrides).toEqual({ image: true, toolCall: true })
    expect(thinking.hasOverride.value).toBe(false)
    await thinking.save()
    expect(model.value.capabilityOverrides).toEqual({ image: true, toolCall: true, reasoningOptions: ['high'] })
    input.startEditing()
    expect(input.form.pdf).toBe(true)
    expect(input.form.toolCall).toBe(true)
    await input.restore()
    expect(model.value.capabilityOverrides).toEqual({ reasoningOptions: ['high'] })
    expect(model.value.toolCalling).toBe(false)
  })

  it('restores inheritance for one section without discarding another section or legacy explicit values', async () => {
    const { input, thinking, model, updateSource } = createForms({ image: true, pdf: false, audio: false, video: false, toolCall: false, reasoningOptions: ['off', 'low', 'high'] })
    updateSource({ toolCall: true })
    expect(input.hasOverride.value).toBe(true)
    expect(thinking.hasOverride.value).toBe(true)
    input.startEditing()
    expect(input.form.toolCall).toBe(false)
    input.form.image = false
    await input.save()
    expect(model.value.capabilityOverrides).toEqual({ image: false, pdf: false, audio: false, video: false, toolCall: false, reasoningOptions: ['off', 'low', 'high'] })
    await thinking.restore()
    expect(model.value.capabilityOverrides).toEqual({ image: false, pdf: false, audio: false, video: false, toolCall: false })
    expect(thinking.hasOverride.value).toBe(false)
    updateSource({ reasoningOptions: ['off', 'high', 'max'] })
    thinking.startEditing()
    expect(thinking.form.levels).toEqual(['off', 'high', 'max'])
    await input.restore()
    expect(model.value.capabilityOverrides).toBeNull()
    expect(input.hasOverride.value).toBe(false)
    expect(model.value.toolCalling).toBe(true)
  })

  it('leaves source values unpinned when unchanged forms are saved', async () => {
    const { input, thinking, model, updateSource } = createForms()
    input.startEditing()
    await input.save()
    thinking.startEditing()
    await thinking.save()
    expect(model.value.capabilityOverrides).toBeNull()
    updateSource({ image: true, pdf: true, reasoningOptions: ['high'] })
    input.startEditing()
    thinking.startEditing()
    expect(input.form.image).toBe(true)
    expect(input.form.pdf).toBe(true)
    expect(thinking.form.levels).toEqual(['high'])
  })
})

function createForms(overrides: ModelCapabilityOverrides | null = null) {
  const model = shallowRef<LocalRuntimeModelOption>({
    providerId: 'fixture',
    modelId: 'model',
    displayName: 'Fixture model',
    api: 'openai-responses',
    available: true,
    enabled: true,
    capabilities: [],
    reasoningOptions: [],
    serviceTiers: [],
    capabilityOverrides: overrides,
    fileInputMimeTypes: [],
    sourceCapabilities: { image: false, pdf: false, audio: false, video: false, reasoningOptions: ['off', 'low', 'high'] },
    type: 'chat',
    sourceType: 'chat',
    typeOverride: null,
    catalogMatch: 'not_applicable',
    catalog: { source: null, selection: null, candidates: [] },
    metadataKnown: true,
    source: 'builtin',
    contextWindow: 16_000,
    maxTokens: 4000,
    sourceContextWindow: 16_000,
    sourceMaxTokens: 4000,
    hasParameterOverride: false,
    overrideContextWindow: null,
    overrideMaxTokens: null,
    sourceParametersUpdated: false,
    lastSeenAt: null,
  })
  const updateSource = (patch: Partial<ModelCapabilities> = {}) => {
    const sourceCapabilities = { ...model.value.sourceCapabilities, ...patch }
    const effective = { ...sourceCapabilities, ...model.value.capabilityOverrides }
    model.value = {
      ...model.value,
      sourceCapabilities,
      capabilities: ['text', ...(['image', 'pdf', 'audio', 'video'] as const).filter(key => effective[key])],
      reasoningOptions: effective.reasoningOptions,
      toolCalling: effective.toolCall,
    }
  }
  updateSource()
  const scope = effectScope()
  scopes.push(scope)
  const create = (section: 'input' | 'thinking') => scope.run(() => useModelCapabilitiesForm({
    section,
    model: () => model.value,
    show: () => true,
    disabled: () => false,
    save: async (capabilityOverrides) => {
      model.value = { ...model.value, capabilityOverrides }
      updateSource()
      return true
    },
  }))!
  return { input: create('input'), thinking: create('thinking'), model, updateSource }
}
