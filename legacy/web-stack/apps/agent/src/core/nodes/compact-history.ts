import type { GraphNode } from '@langchain/langgraph'
import type { AgentGraphContext, AgentGraphState } from '../state'
import { Overwrite } from '@langchain/langgraph'
import { compactAgentHistory } from '../context/history-compaction'
import { resolveBudgetForState } from './budget'

export function createCompactHistoryNode(): GraphNode<typeof AgentGraphState, AgentGraphContext> {
  return async (state, config) => {
    const contextBudget = config.context?.contextBudget ?? state.contextBudget
    const triggerUserMessageId = config.context?.triggerUserMessageId

    if (!contextBudget || !triggerUserMessageId) {
      return {}
    }

    const result = await compactAgentHistory({
      sessionHistoryVersion: state.sessionHistoryVersion,
      triggerUserMessageId,
      messages: state.messages,
      budget: contextBudget,
      historyDigest: state.historyDigest,
    })
    const nextContextBudget = resolveBudgetForState({
      ...state,
      messages: result.messages,
      historyDigest: result.historyDigest,
    }, config.context)

    return {
      messages: new Overwrite(result.messages),
      historyDigest: result.historyDigest,
      contextBudget: nextContextBudget,
    }
  }
}
