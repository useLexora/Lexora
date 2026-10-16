import { positiveIntegerWithDefault, requiredEnvString } from '@haohaoxue/lexora-shared'
import { z } from 'zod'

const agentEnvSchema = z.object({
  API_INTERNAL_URL: requiredEnvString('API_INTERNAL_URL'),
  APP_INTERNAL_KEY: requiredEnvString('APP_INTERNAL_KEY'),
  REDIS_URL: requiredEnvString('REDIS_URL'),
  AGENT_CHECKPOINTER_DATABASE_URL: requiredEnvString('AGENT_CHECKPOINTER_DATABASE_URL'),
  AGENT_CHECKPOINT_RETENTION_DAYS: positiveIntegerWithDefault(7),
  AGENT_MAX_CONCURRENT_RUNS: positiveIntegerWithDefault(10),
})

export type AgentEnv = z.infer<typeof agentEnvSchema>

export function validateAgentEnv(config: Record<string, unknown>): AgentEnv {
  return agentEnvSchema.parse(config)
}
