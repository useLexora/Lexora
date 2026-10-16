import type { AgentModelTextStreamResult, AgentModelTokenUsage } from '../../integrations/model-providers/stream-text'
import type { AggregatedModelCallMetrics } from './types'

export function createAggregatedModelCallMetrics(): AggregatedModelCallMetrics {
  return {
    providerUsage: null,
    elapsedMs: 0,
  }
}

export function addModelCallMetrics(
  metrics: AggregatedModelCallMetrics,
  result: AgentModelTextStreamResult,
): void {
  const elapsedBeforeCall = metrics.elapsedMs
  metrics.providerUsage = sumTokenUsage(metrics.providerUsage, result.providerUsage)
  metrics.elapsedMs += result.elapsedMs

  if (metrics.firstTokenLatencyMs === undefined && result.firstTokenLatencyMs !== undefined) {
    metrics.firstTokenLatencyMs = elapsedBeforeCall + result.firstTokenLatencyMs
  }
}

function sumTokenUsage(
  current: AgentModelTokenUsage | null,
  next: AgentModelTokenUsage | null,
): AgentModelTokenUsage | null {
  if (!next) {
    return current
  }

  if (!current) {
    return next
  }

  return {
    inputTokens: sumOptionalTokenCount(current.inputTokens, next.inputTokens),
    outputTokens: sumOptionalTokenCount(current.outputTokens, next.outputTokens),
    totalTokens: sumOptionalTokenCount(current.totalTokens, next.totalTokens),
    reasoningTokens: sumOptionalTokenCount(current.reasoningTokens, next.reasoningTokens),
  }
}

function sumOptionalTokenCount(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined
  }

  return (left ?? 0) + (right ?? 0)
}
