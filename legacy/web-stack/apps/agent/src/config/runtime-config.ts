import process from 'node:process'
import { validateAgentEnv } from './env.schema'

const DEFAULT_AGENT_HOST = '0.0.0.0'
const DEFAULT_AGENT_PORT = 4200
const DEFAULT_AGENT_RUN_TIMEOUT_MS = 60_000

/** apps/agent 运行配置。 */
export interface AgentConfig {
  host: string
  port: number
  logger: AgentLoggerConfig
  apiInternalUrl: string
  appInternalKey: string
  redisUrl: string
  runTimeoutMs: number
  maxConcurrentRuns: number
  checkpointer: AgentCheckpointerConfig
}

/** apps/agent 日志配置。 */
export interface AgentLoggerConfig {
  level: string
  pretty: boolean
}

export interface AgentCheckpointerConfig {
  databaseUrl: string
  retentionDays: number
}

type EnvSource = Record<string, string | undefined>

export function loadAgentConfig(env: EnvSource = process.env): AgentConfig {
  const agentEnv = validateAgentEnv(env)

  return {
    host: DEFAULT_AGENT_HOST,
    port: DEFAULT_AGENT_PORT,
    logger: readLoggerConfig(env),
    apiInternalUrl: agentEnv.API_INTERNAL_URL,
    appInternalKey: agentEnv.APP_INTERNAL_KEY,
    redisUrl: agentEnv.REDIS_URL,
    runTimeoutMs: DEFAULT_AGENT_RUN_TIMEOUT_MS,
    maxConcurrentRuns: agentEnv.AGENT_MAX_CONCURRENT_RUNS,
    checkpointer: readCheckpointerConfig(agentEnv),
  }
}

function readLoggerConfig(env: EnvSource): AgentLoggerConfig {
  const isProduction = env.NODE_ENV === 'production'

  return {
    level: isProduction ? 'info' : 'debug',
    pretty: !isProduction,
  }
}

function readCheckpointerConfig(agentEnv: ReturnType<typeof validateAgentEnv>): AgentCheckpointerConfig {
  return {
    databaseUrl: agentEnv.AGENT_CHECKPOINTER_DATABASE_URL,
    retentionDays: agentEnv.AGENT_CHECKPOINT_RETENTION_DAYS,
  }
}
