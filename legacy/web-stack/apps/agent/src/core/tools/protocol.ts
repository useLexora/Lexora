import type { AgentChatModel } from '../../integrations/model-providers/chat-model'
import type { AgentRuntimeModelTarget } from '../../runtime/typing'
import { AI_MODEL_CAPABILITY } from '@haohaoxue/lexora-contracts'

export type AgentToolProtocol
  = | { kind: 'native' }
    | { kind: 'structured-json' }
    | {
      kind: 'none'
      reason:
        | 'no-visible-tools'
        | 'native-tool-binding-unavailable'
        | 'safe-tool-protocol-unavailable'
    }

export function resolveAgentToolProtocol(input: {
  model: AgentChatModel
  modelTarget?: AgentRuntimeModelTarget | null
  visibleToolCount: number
}): AgentToolProtocol {
  if (input.visibleToolCount === 0) {
    return {
      kind: 'none',
      reason: 'no-visible-tools',
    }
  }

  const capabilities = new Set(input.modelTarget?.capabilities ?? [])
  if (capabilities.has(AI_MODEL_CAPABILITY.TOOL_CALL) && input.model.bindTools) {
    return { kind: 'native' }
  }

  if (
    capabilities.has(AI_MODEL_CAPABILITY.STRUCTURED_OUTPUT)
    || capabilities.has(AI_MODEL_CAPABILITY.JSON_MODE)
  ) {
    return { kind: 'structured-json' }
  }

  if (capabilities.has(AI_MODEL_CAPABILITY.TOOL_CALL)) {
    return {
      kind: 'none',
      reason: 'native-tool-binding-unavailable',
    }
  }

  return {
    kind: 'none',
    reason: 'safe-tool-protocol-unavailable',
  }
}
