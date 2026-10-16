import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { AgentRuntimeTryLock } from './lock'
import type { AgentControlResultPublisher, AgentRuntimeControlCommand } from './typing'
import {
  AGENT_CHAT_THREAD_PREFIX,
  AGENT_RUNTIME_CONTROL_RESULT_TYPE,
  AGENT_RUNTIME_CONTROL_TYPE,
} from '@haohaoxue/lexora-contracts'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000
const DEFAULT_INITIAL_JITTER_MAX_MS = 60_000
const CHECKPOINT_RETENTION_LOCK_KEY = 'checkpoint-retention'

export interface CheckpointRetentionLogger {
  warn: (message: string) => void
}

export interface SweepExpiredCheckpointThreadsInput {
  checkpointer: BaseCheckpointSaver
  retentionDays: number
  now?: () => Date
  threadPrefix?: string
  lock?: AgentRuntimeTryLock
  logger?: CheckpointRetentionLogger
}

export interface CheckpointRetentionSweepResult {
  skipped: boolean
  skippedReason?: 'lock_not_acquired'
  startedAt: string
  completedAt: string
  cutoffAt: string
  scannedThreads: number
  retainedThreads: number
  deletedThreads: number
  failedThreads: number
}

export interface CreateCheckpointRetentionManagerInput {
  checkpointer: BaseCheckpointSaver
  retentionDays: number
  now?: () => Date
  sweepIntervalMs?: number
  initialJitterMs?: () => number
  lock?: AgentRuntimeTryLock
  threadLock?: AgentRuntimeTryLock
  controlResults?: AgentControlResultPublisher
  logger?: CheckpointRetentionLogger
}

export interface CheckpointRetentionManager {
  start: () => void
  stop: () => Promise<void>
  sweepOnce: () => Promise<CheckpointRetentionSweepResult>
  handleControl: (control: AgentRuntimeControlCommand) => Promise<void>
}

interface CheckpointThreadAccess {
  threadId: string
  lastAccessedAt: Date
}

export async function sweepExpiredCheckpointThreads(
  input: SweepExpiredCheckpointThreadsInput,
): Promise<CheckpointRetentionSweepResult> {
  if (input.lock) {
    const result = await input.lock.tryRunExclusive(
      CHECKPOINT_RETENTION_LOCK_KEY,
      async () => await sweepExpiredCheckpointThreadsWithoutLock(input),
    )

    return result ?? createSkippedSweepResult(input.now?.() ?? new Date(), 'lock_not_acquired')
  }

  return sweepExpiredCheckpointThreadsWithoutLock(input)
}

async function sweepExpiredCheckpointThreadsWithoutLock(
  input: SweepExpiredCheckpointThreadsInput,
): Promise<CheckpointRetentionSweepResult> {
  const now = input.now?.() ?? new Date()
  const startedAt = now.toISOString()
  const cutoffAt = new Date(now.getTime() - input.retentionDays * MS_PER_DAY)
  const threads = await listLatestCheckpointThreadAccess({
    checkpointer: input.checkpointer,
    threadPrefix: input.threadPrefix ?? AGENT_CHAT_THREAD_PREFIX,
  })
  let retainedThreads = 0
  let deletedThreads = 0
  let failedThreads = 0

  for (const thread of threads) {
    if (thread.lastAccessedAt >= cutoffAt) {
      retainedThreads += 1
      continue
    }

    try {
      await input.checkpointer.deleteThread(thread.threadId)
      deletedThreads += 1
    }
    catch (error) {
      failedThreads += 1
      input.logger?.warn(
        `checkpoint cleanup failed: thread=${thread.threadId} error=${getErrorMessage(error)}`,
      )
    }
  }

  return {
    skipped: false,
    startedAt,
    completedAt: (input.now?.() ?? new Date()).toISOString(),
    cutoffAt: cutoffAt.toISOString(),
    scannedThreads: threads.length,
    retainedThreads,
    deletedThreads,
    failedThreads,
  }
}

export function createCheckpointRetentionManager(
  input: CreateCheckpointRetentionManagerInput,
): CheckpointRetentionManager {
  const now = input.now ?? (() => new Date())
  const sweepIntervalMs = input.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
  const initialJitterMs = input.initialJitterMs ?? (() => Math.floor(Math.random() * DEFAULT_INITIAL_JITTER_MAX_MS))
  let initialTimeout: NodeJS.Timeout | null = null
  let interval: NodeJS.Timeout | null = null
  let currentSweep: Promise<CheckpointRetentionSweepResult> | null = null

  async function sweepOnce(): Promise<CheckpointRetentionSweepResult> {
    if (currentSweep) {
      return currentSweep
    }

    currentSweep = sweepExpiredCheckpointThreads({
      checkpointer: input.checkpointer,
      retentionDays: input.retentionDays,
      now,
      lock: input.lock,
      logger: input.logger,
    })
      .finally(() => {
        currentSweep = null
      })

    return currentSweep
  }

  function scheduleSweep(): void {
    void sweepOnce().catch(error => input.logger?.warn(
      `checkpoint retention sweep failed: ${getErrorMessage(error)}`,
    ))
  }

  return {
    start() {
      if (interval) {
        return
      }

      initialTimeout = setTimeout(scheduleSweep, initialJitterMs())
      initialTimeout.unref?.()
      interval = setInterval(scheduleSweep, sweepIntervalMs)
      interval.unref?.()
    },

    async stop() {
      if (initialTimeout) {
        clearTimeout(initialTimeout)
        initialTimeout = null
      }

      if (interval) {
        clearInterval(interval)
        interval = null
      }

      await currentSweep?.catch(error => input.logger?.warn(
        `checkpoint retention sweep shutdown wait failed: ${getErrorMessage(error)}`,
      ))
    },

    sweepOnce,

    async handleControl(control) {
      if (control.type !== AGENT_RUNTIME_CONTROL_TYPE.DELETE_CHECKPOINT_THREAD) {
        return
      }

      if (!control.threadId.startsWith(AGENT_CHAT_THREAD_PREFIX)) {
        input.logger?.warn(`checkpoint cleanup ignored unsupported thread: ${control.threadId}`)
        await publishCheckpointDeleteFailed(input.controlResults, control, '不支持的 checkpoint thread')
        return
      }

      try {
        const cleanup = async () => {
          await input.checkpointer.deleteThread(control.threadId)
          await publishCheckpointDeleteCompleted(input.controlResults, control)
        }

        if (input.threadLock) {
          const result = await input.threadLock.tryRunExclusive(control.threadId, cleanup)
          if (result === null) {
            await publishCheckpointDeleteFailed(input.controlResults, control, 'checkpoint thread 正在使用')
          }
          return
        }

        await input.checkpointer.deleteThread(control.threadId)
        await publishCheckpointDeleteCompleted(input.controlResults, control)
      }
      catch (error) {
        const message = getErrorMessage(error)
        await publishCheckpointDeleteFailed(input.controlResults, control, message)
        input.logger?.warn(
          `checkpoint cleanup control failed: thread=${control.threadId} error=${message}`,
        )
      }
    },

  }
}

async function publishCheckpointDeleteCompleted(
  publisher: AgentControlResultPublisher | undefined,
  control: AgentRuntimeControlCommand,
): Promise<void> {
  if (
    control.type !== AGENT_RUNTIME_CONTROL_TYPE.DELETE_CHECKPOINT_THREAD
    || !control.cleanupTaskId
  ) {
    return
  }

  await publisher?.publish({
    controlId: control.controlId,
    type: AGENT_RUNTIME_CONTROL_RESULT_TYPE.CHECKPOINT_THREAD_DELETE_COMPLETED,
    cleanupTaskId: control.cleanupTaskId,
    threadId: control.threadId,
  })
}

async function publishCheckpointDeleteFailed(
  publisher: AgentControlResultPublisher | undefined,
  control: AgentRuntimeControlCommand,
  errorMessage: string,
): Promise<void> {
  if (
    control.type !== AGENT_RUNTIME_CONTROL_TYPE.DELETE_CHECKPOINT_THREAD
    || !control.cleanupTaskId
  ) {
    return
  }

  await publisher?.publish({
    controlId: control.controlId,
    type: AGENT_RUNTIME_CONTROL_RESULT_TYPE.CHECKPOINT_THREAD_DELETE_FAILED,
    cleanupTaskId: control.cleanupTaskId,
    threadId: control.threadId,
    errorMessage,
  })
}

function createSkippedSweepResult(
  now: Date,
  skippedReason: NonNullable<CheckpointRetentionSweepResult['skippedReason']>,
): CheckpointRetentionSweepResult {
  const current = now.toISOString()

  return {
    skipped: true,
    skippedReason,
    startedAt: current,
    completedAt: current,
    cutoffAt: current,
    scannedThreads: 0,
    retainedThreads: 0,
    deletedThreads: 0,
    failedThreads: 0,
  }
}

async function listLatestCheckpointThreadAccess(input: {
  checkpointer: BaseCheckpointSaver
  threadPrefix: string
}): Promise<CheckpointThreadAccess[]> {
  const latestByThreadId = new Map<string, Date>()

  for await (const checkpoint of input.checkpointer.list({})) {
    const threadId = readThreadId(checkpoint.config.configurable?.thread_id)
    if (!threadId?.startsWith(input.threadPrefix)) {
      continue
    }

    const accessedAt = readCheckpointAccessedAt(checkpoint.checkpoint)
    if (!accessedAt) {
      continue
    }

    const previous = latestByThreadId.get(threadId)
    if (!previous || accessedAt > previous) {
      latestByThreadId.set(threadId, accessedAt)
    }
  }

  return Array.from(latestByThreadId.entries()).map(([threadId, lastAccessedAt]) => ({
    threadId,
    lastAccessedAt,
  }))
}

function readCheckpointAccessedAt(checkpoint: unknown): Date | null {
  if (!checkpoint || typeof checkpoint !== 'object' || !('ts' in checkpoint)) {
    return null
  }

  const value = checkpoint.ts
  const accessedAt = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null

  return accessedAt && Number.isFinite(accessedAt.getTime()) ? accessedAt : null
}

function readThreadId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}
