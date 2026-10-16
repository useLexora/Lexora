import type { GraphNode } from '@langchain/langgraph'
import type { AgentGraphContext, AgentGraphState } from '../state'
import { resolveBudgetForState } from './budget'

export function createPrepareContextNode(): GraphNode<typeof AgentGraphState, AgentGraphContext> {
  return async (state, config) => {
    return {
      contextBudget: resolveBudgetForState(state, config.context),
    }
  }
}
