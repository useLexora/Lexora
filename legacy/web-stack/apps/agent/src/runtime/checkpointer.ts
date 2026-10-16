import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { AgentCheckpointerConfig } from '../config/runtime-config'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'

export type AgentCheckpointer = BaseCheckpointSaver & {
  end?: () => Promise<void>
}

export async function createAgentCheckpointer(config: AgentCheckpointerConfig): Promise<AgentCheckpointer> {
  const checkpointer = PostgresSaver.fromConnString(config.databaseUrl)
  await checkpointer.setup()

  return checkpointer
}

export async function closeAgentCheckpointer(checkpointer: AgentCheckpointer | null | undefined): Promise<void> {
  await checkpointer?.end?.()
}
