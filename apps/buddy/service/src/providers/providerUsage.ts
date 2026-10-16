import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import type { ProviderRequestDiagnostic } from '../../../shared/diagnostics/providerRequestDiagnostic'
import { calculateCost } from '@earendil-works/pi-ai'

type UsageDiagnostic = NonNullable<ProviderRequestDiagnostic['usage']>
type ReportedUsage = UsageDiagnostic['reported']

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function readOpenAiUsage(event: unknown): ReportedUsage | undefined {
  const chunk = object(event)
  const choice = Array.isArray(chunk?.choices) ? object(chunk.choices[0]) : undefined
  const usage = object(chunk?.usage ?? choice?.usage)
  if (!usage)
    return undefined
  const prompt = object(usage.prompt_tokens_details)
  return {
    promptTokens: tokenCount(usage.prompt_tokens),
    completionTokens: tokenCount(usage.completion_tokens),
    reasoningTokens: tokenCount(object(usage.completion_tokens_details)?.reasoning_tokens),
    cacheReadTokens: tokenCount(prompt?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens),
    cacheWriteTokens: tokenCount(prompt?.cache_write_tokens),
    totalTokens: tokenCount(usage.total_tokens),
  }
}

export function reconcileOpenAiUsage(model: Model<Api>, message: AssistantMessage, reported: ReportedUsage): { message: AssistantMessage, diagnostic: UsageDiagnostic } {
  const { promptTokens, completionTokens, reasoningTokens, totalTokens } = reported
  let usage = message.usage
  let reconciliation: UsageDiagnostic['reconciliation'] = 'unchanged'
  if (
    promptTokens !== undefined && completionTokens !== undefined && reasoningTokens !== undefined && reasoningTokens > 0 && totalTokens !== undefined
    && totalTokens === promptTokens + completionTokens + reasoningTokens
    && usage.input + usage.cacheRead + usage.cacheWrite === promptTokens
    && usage.output === completionTokens && usage.reasoning === reasoningTokens
  ) {
    usage = { ...usage, output: completionTokens + reasoningTokens, totalTokens, cost: { ...usage.cost } }
    calculateCost(model, usage)
    message = { ...message, usage }
    reconciliation = 'reasoning_included'
  }
  else if ((totalTokens !== undefined && usage.totalTokens !== totalTokens) || (usage.reasoning ?? 0) > usage.output) {
    reconciliation = 'inconsistent'
  }
  return {
    message,
    diagnostic: {
      reported,
      normalized: {
        inputTokens: tokenCount(usage.input),
        outputTokens: tokenCount(usage.output),
        reasoningTokens: tokenCount(usage.reasoning),
        cacheReadTokens: tokenCount(usage.cacheRead),
        cacheWriteTokens: tokenCount(usage.cacheWrite),
        totalTokens: tokenCount(usage.totalTokens),
      },
      reconciliation,
    },
  }
}
