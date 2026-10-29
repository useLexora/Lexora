import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'

import { describe, expect, it } from 'vitest'
import { resolveChatComposerModelInputIssue } from '../chatComposerModelCapability'

function model(capabilities: readonly string[]): LocalRuntimeModelOption {
  return {
    available: true,
    type: 'chat',
    sourceType: 'chat',
    typeOverride: null,
    catalogMatch: 'not_applicable',
    catalog: { source: null, selection: null, candidates: [] },
    metadataKnown: true,
    capabilityOverrides: null,
    fileInputMimeTypes: capabilities.includes('pdf') ? ['application/pdf'] : [],
    sourceCapabilities: { image: capabilities.includes('image'), reasoningOptions: ['off'] },
    api: 'openai-completions',
    capabilities: [...capabilities],
    contextWindow: 128_000,
    displayName: 'Fixture',
    enabled: true,
    hasParameterOverride: false,
    lastSeenAt: null,
    maxTokens: 4_096,
    modelId: 'fixture',
    overrideContextWindow: null,
    overrideMaxTokens: null,
    providerId: 'fixture',
    reasoningOptions: [],
    serviceTiers: [],
    source: 'builtin',
    sourceContextWindow: 128_000,
    sourceMaxTokens: 4_096,
    sourceParametersUpdated: false,
  }
}

describe('composer model capability', () => {
  it('allows audio files even when the native format is unsupported', () => {
    const audioModel: LocalRuntimeModelOption = { ...model(['text', 'audio']), fileInputMimeTypes: ['audio/wav', 'audio/mpeg'] }
    const resources = [{ resource: { resourceId: 'audio-1', kind: 'audio' as const, mimeType: 'audio/mp4' } }]
    expect(resolveChatComposerModelInputIssue({ model: audioModel, resources, resourceIds: ['audio-1'] })).toBeNull()
    expect(resolveChatComposerModelInputIssue({ model: { ...audioModel, fileInputMimeTypes: [...audioModel.fileInputMimeTypes, 'audio/mp4'] }, resources, resourceIds: ['audio-1'] })).toBeNull()
  })
  it('allows PDF files independently from native image capabilities', () => {
    const resources = [{ resource: { resourceId: 'pdf-1', kind: 'pdf' as const, mimeType: 'application/pdf' } }]
    expect(resolveChatComposerModelInputIssue({ model: model(['text', 'image']), resources, resourceIds: ['pdf-1'] })).toBeNull()
    expect(resolveChatComposerModelInputIssue({ model: model(['text', 'pdf']), resources, resourceIds: ['pdf-1'] })).toBeNull()
    expect(resolveChatComposerModelInputIssue({ model: model(['text']), resources, resourceIds: [] })).toBeNull()
  })

  it('allows image files on text-only models', () => {
    const input = {
      resourceIds: ['resource-1'],
      resources: [{ resource: { resourceId: 'resource-1', kind: 'image' as const, mimeType: 'image/png' } }],
    }

    expect(resolveChatComposerModelInputIssue({ ...input, model: model(['text']) })).toBeNull()
    expect(resolveChatComposerModelInputIssue({ ...input, model: model(['text', 'image']) })).toBeNull()
  })
})
