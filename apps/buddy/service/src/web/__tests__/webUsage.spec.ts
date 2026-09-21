import type { Api, JsonValue, Model } from '@earendil-works/pi-ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'
import { describe, expect, it } from 'vitest'
import { DEFAULT_WEB_SETTINGS } from '../../../../shared/network/webProtocol'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { UsageService } from '../../usage/UsageService'
import { NativeSearchResultCollector } from '../NativeWebSearch'
import { WebCapabilityService } from '../WebCapabilityService'
import { createWebExtension } from '../webExtension'

const model = { api: 'openai-responses', provider: 'fixture', id: 'fixture', baseUrl: 'https://example.com', cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 } } as Model<Api>

describe('native search usage projection', () => {
  it.each(['sources', 'incomplete'] as const)('projects confirmed tokens even when native search returns %s', async (mode) => {
    const settings = structuredClone(DEFAULT_WEB_SETTINGS)
    const service = new WebCapabilityService({
      paths: new BuddyDataPaths('/tmp/buddy-web-usage-fixture'),
      models: { getAuth: async () => ({ auth: { apiKey: 'fixture-only-key' } }) },
      settings: { get: () => settings, getTavilyKey: async () => null },
      host: {
        authorize: async () => {},
        render: async () => ({ ok: false, code: 'WEB_RENDER_REQUIRED' }),
        get: async url => ({ url, status: 200, headers: new Headers({ 'content-type': 'text/html' }), bytes: new TextEncoder().encode('<html><body><ol id="b_results"><li class="b_algo"><h2><a href="https://example.com/fallback">Fallback source</a></h2></li></ol></body></html>') }),
        providerFetch: async () => new Response(`data: ${JSON.stringify({ type: mode === 'incomplete' ? 'response.incomplete' : 'response.completed', response: {
          status: mode === 'incomplete' ? 'incomplete' : 'completed',
          output: [{ type: 'web_search_call', status: 'completed', action: { sources: mode === 'sources' ? [{ url: 'https://example.com/source' }] : [] } }],
          usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } },
        } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
      },
    })
    const tools: ToolDefinition<TSchema, JsonValue>[] = []
    await createWebExtension({ service, conversationId: 'fixture' }).factory({ registerTool: (tool: ToolDefinition<TSchema, JsonValue>) => tools.push(tool), on: () => {} } as never)
    const result = await tools[0]!.execute('search-1', { query: 'fixture' }, new AbortController().signal, undefined, { model } as never)
    const events: unknown[] = []
    const usageService = new UsageService({
      repository: { findBySource: () => null, listRecent: () => [], listForRun: () => [], summarize: () => { throw new Error('Unused') } },
      eventLog: { append: async (event) => {
        events.push(event)
        return event as never
      } },
    })
    const projected = await usageService.recordMessage({
      message: { ...result, role: 'toolResult', toolCallId: 'search-1', toolName: 'lexora_web_search', isError: false, timestamp: 0 },
      createdAt: '2026-09-05T00:00:00.000Z',
      runId: 'run-1',
      sourceMessageId: 'search-1',
      fallbackModel: model.id,
      fallbackProvider: model.provider,
    })
    expect(result.details).toMatchObject({ ok: true, provider: mode === 'sources' ? 'fixture-native' : 'bing' })
    expect(projected).toMatchObject({ purpose: 'tool', provider: 'fixture', model: 'fixture', inputTokens: 10, outputTokens: 8, cacheReadTokens: 2, reasoningTokens: 3, totalTokens: 20 })
    expect(events).toEqual([expect.objectContaining({ type: 'usage.recorded' })])
    expect(projected?.totalCost).toBeCloseTo(0.000027)
    service.dispose()
  })

  it('preserves Anthropic cache usage across partial usage events', () => {
    const collector = new NativeSearchResultCollector('anthropic')
    expect(collector.modelUsage(model)).toBeUndefined()
    collector.accept({ type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 4 } } } })
    collector.accept({ type: 'message_delta', usage: { output_tokens: 8 } })
    expect(collector.modelUsage(model)).toMatchObject({ input: 12, output: 8, cacheRead: 20, cacheWrite: 10, cacheWrite1h: 4, totalTokens: 50 })
    expect(collector.modelUsage(model)?.cost.total).toBeCloseTo(0.000052)
  })
})
