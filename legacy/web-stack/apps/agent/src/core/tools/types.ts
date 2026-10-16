import type { ChatMemoryOperationProjection } from '@haohaoxue/lexora-contracts'
import type {
  AgentModelTextStreamResult,
  AgentModelTokenUsage,
} from '../../integrations/model-providers/stream-text'

export interface AgentModelCallResult extends AgentModelTextStreamResult {
  memoryOperations: ChatMemoryOperationProjection[]
}

export interface AggregatedModelCallMetrics {
  providerUsage: AgentModelTokenUsage | null
  firstTokenLatencyMs?: number
  elapsedMs: number
}
