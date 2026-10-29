import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { LocalRunEvent } from '@buddy-shared/runs/runApi'

import { describe, expect, it } from 'vitest'
import { createChatContextUsage } from '../chatContextUsage'

describe('createChatContextUsage', () => {
  it('follows live snapshots through startup, stale events and pending compaction', () => {
    const model = runtimeModel()
    const events: LocalRunEvent[] = []
    const input = {
      events,
      models: [model],
      selectedModel: model,
      snapshot: {
        contextWindow: model.contextWindow,
        createdAt: '2026-08-20T00:00:02.000Z',
        mcpTokens: 30,
        messageTokens: 140,
        modelId: model.modelId,
        providerId: model.providerId,
        skillTokens: 15,
        status: 'ready' as const,
        systemPromptTokens: 50,
        toolTokens: 40,
        totalTokens: 275,
      },
    }
    expect(createChatContextUsage(input)).toMatchObject({
      contextWindow: 200_000,
      modelId: model.modelId,
      providerId: model.providerId,
      status: 'ready',
      totalTokens: 275,
    })
    events.push(contextUsageEvent(1, {
      mcpTokens: 0,
      messageTokens: 292_800,
      skillTokens: 0,
      systemPromptTokens: 78,
      toolTokens: 0,
      totalTokens: 292_878,
    }))
    expect(createChatContextUsage(input)?.percent).toBeCloseTo(0.1375)
    expect(createChatContextUsage({
      ...input,
      snapshot: {
        contextWindow: model.contextWindow,
        createdAt: '2026-08-20T00:00:03.000Z',
        modelId: model.modelId,
        providerId: model.providerId,
        status: 'pending',
      },
    })).toMatchObject({
      contextWindow: 200_000,
      percent: null,
      recordedAt: '2026-08-20T00:00:03.000Z',
      status: 'pending',
      totalTokens: null,
    })
  })

  it('projects attributed usage segments and retains the last nonempty snapshot', () => {
    const model = runtimeModel()
    const usage = createChatContextUsage({
      events: [
        contextUsageEvent(1, {
          mcpTokens: 30,
          messageTokens: 140,
          skillTokens: 15,
          systemPromptTokens: 50,
          toolTokens: 40,
          totalTokens: 275,
        }),
        contextUsageEvent(2, {
          mcpTokens: 0,
          messageTokens: 0,
          skillTokens: 0,
          systemPromptTokens: 0,
          toolTokens: 0,
          totalTokens: 0,
        }),
      ],
      models: [model],
      selectedModel: model,
    })
    expect(usage).toMatchObject({
      contextWindow: 200_000,
      modelId: model.modelId,
      providerId: model.providerId,
      status: 'ready',
      totalTokens: 275,
    })
    expect(usage?.percent).toBeCloseTo(0.1375)
    expect(usage?.segments).toEqual([
      { kind: 'systemPrompt', tokens: 50 },
      { kind: 'tools', tokens: 40 },
      { kind: 'skills', tokens: 15 },
      { kind: 'mcp', tokens: 30 },
      { kind: 'messages', tokens: 140 },
    ])
  })

  it('ignores a post-compaction local estimate until a later model response arrives', () => {
    const model = runtimeModel()
    const usage = createChatContextUsage({
      events: [
        contextUsageEvent(1, {
          mcpTokens: 0,
          messageTokens: 190_000,
          skillTokens: 1_000,
          systemPromptTokens: 2_000,
          toolTokens: 7_000,
          totalTokens: 200_000,
        }),
        {
          createdAt: '2026-08-20T00:00:02.000Z',
          payload: {
            estimatedTokensAfter: 24_000,
            reason: 'threshold',
            tokensBefore: 200_000,
            willRetry: false,
          },
          runId: 'run-compact',
          sequence: 1,
          type: 'context.compaction.completed',
        },
      ],
      models: [model],
      selectedModel: model,
      snapshot: {
        contextWindow: model.contextWindow,
        createdAt: '2026-08-20T00:00:03.000Z',
        mcpTokens: 0,
        messageTokens: 205_000,
        status: 'ready',
        modelId: model.modelId,
        providerId: model.providerId,
        skillTokens: 3_000,
        systemPromptTokens: 2_000,
        toolTokens: 10_000,
        totalTokens: 220_000,
      },
    })

    expect(usage).toMatchObject({
      contextWindow: 200_000,
      percent: null,
      status: 'pending',
      totalTokens: null,
    })
  })
})

function runtimeModel(): LocalRuntimeModelOption & { contextWindow: number, maxTokens: number } {
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
    contextWindow: 200_000,
    displayName: 'Model A',
    enabled: true,
    hasParameterOverride: false,
    lastSeenAt: null,
    maxTokens: 8192,
    modelId: 'model-a',
    overrideContextWindow: null,
    overrideMaxTokens: null,
    providerId: 'provider-a',
    reasoningOptions: ['off'],
    serviceTiers: [],
    source: 'builtin',
    sourceContextWindow: 200_000,
    sourceMaxTokens: 8192,
    sourceParametersUpdated: false,
  }
}

function contextUsageEvent(
  sequence: number,
  usage: {
    mcpTokens: number
    messageTokens: number
    skillTokens: number
    systemPromptTokens: number
    toolTokens: number
    totalTokens: number
  },
): LocalRunEvent {
  return {
    createdAt: `2026-08-20T00:00:0${sequence}.000Z`,
    payload: {
      mcpTokens: usage.mcpTokens,
      messageTokens: usage.messageTokens,
      model: 'model-a',
      provider: 'provider-a',
      skillTokens: usage.skillTokens,
      systemPromptTokens: usage.systemPromptTokens,
      toolTokens: usage.toolTokens,
      totalTokens: usage.totalTokens,
    },
    runId: 'run-a',
    sequence,
    type: 'context.usage.updated',
  }
}
