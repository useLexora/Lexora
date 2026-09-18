import type {
  AutomationModelTarget,
} from '../../../shared/automation'
import type { BuddyThinkingLevel } from '../../../shared/conversation/modelSelection'
import type { SpaceExecutionContext } from '../../../shared/conversation/space'
import type { BuddyTurnHandle } from '../agent/execution/turnTypes'
import type { AutomationOccurrenceRecord } from '../storage/automationOccurrenceRecord'
import type { AutomationTurnRepository } from '../storage/automationTurnRepository'
import type { AutomationActionExecutor } from './AutomationDispatcher'
import type { AutomationClock } from './AutomationScheduleEvaluator'
import type { AutomationService } from './AutomationService'
import { randomUUID } from 'node:crypto'
import { systemAutomationClock } from './AutomationScheduleEvaluator'

export const AUTOMATION_RUN_TIMEOUT_MS = 90 * 60 * 1_000

export interface ResolvedAutomationModel {
  contextWindow: number
  maxTokens: number
  modelId: string
  providerId: string
  reasoning: BuddyThinkingLevel | null
}

export interface ResolvedAutomationSpace {
  executionContext: SpaceExecutionContext
  id: string
  status: 'ready'
}

export interface ChangedAutomationSpace {
  status: 'context_changed'
}

export interface AgentTaskAutomationActionOptions {
  automationService: AutomationService
  cancelRun?: (runId: string, errorCode: string) => Promise<boolean>
  clock?: AutomationClock
  createId?: () => string
  launchTurn: (runId: string) => Promise<BuddyTurnHandle>
  resolveModel: (target: AutomationModelTarget) => Promise<ResolvedAutomationModel | null>
  resolveSpace: (
    spaceId: string,
    executionContext: SpaceExecutionContext,
  ) => Promise<ChangedAutomationSpace | ResolvedAutomationSpace | null>
    | ChangedAutomationSpace
    | ResolvedAutomationSpace
    | null
  runTimeoutMs?: number
  turns: AutomationTurnRepository
}

export class AgentTaskAutomationAction implements AutomationActionExecutor {
  readonly #automationService: AutomationService
  readonly #cancelRun: NonNullable<AgentTaskAutomationActionOptions['cancelRun']>
  readonly #clock: AutomationClock
  readonly #createId: () => string
  readonly #launchTurn: AgentTaskAutomationActionOptions['launchTurn']
  readonly #resolveModel: AgentTaskAutomationActionOptions['resolveModel']
  readonly #resolveSpace: AgentTaskAutomationActionOptions['resolveSpace']
  readonly #runTimeoutMs: number
  readonly #turns: AutomationTurnRepository

  constructor(options: AgentTaskAutomationActionOptions) {
    this.#automationService = options.automationService
    this.#cancelRun = options.cancelRun ?? (async () => false)
    this.#clock = options.clock ?? systemAutomationClock
    this.#createId = options.createId ?? randomUUID
    this.#launchTurn = options.launchTurn
    this.#resolveModel = options.resolveModel
    this.#resolveSpace = options.resolveSpace
    this.#runTimeoutMs = options.runTimeoutMs ?? AUTOMATION_RUN_TIMEOUT_MS
    this.#turns = options.turns
  }

  async execute(occurrence: AutomationOccurrenceRecord & { leaseOwner: string }): Promise<void> {
    const snapshot = occurrence.executionSnapshot
    const model = await this.#resolveModel(snapshot.model)
    if (!model) {
      const errorCode = snapshot.model.mode === 'pinned'
        ? 'AUTOMATION_PINNED_MODEL_UNAVAILABLE'
        : 'AUTOMATION_DEFAULT_MODEL_UNAVAILABLE'
      if (snapshot.model.mode === 'pinned') {
        this.#automationService.finishQueuedAndBlock({
          automationId: occurrence.automationId,
          expectedRevision: occurrence.automationRevision,
          id: occurrence.id,
          leaseOwner: occurrence.leaseOwner,
          reason: 'AUTOMATION_PINNED_MODEL_UNAVAILABLE',
        })
      }
      else {
        this.#automationService.finishQueued({
          errorCode,
          id: occurrence.id,
          leaseOwner: occurrence.leaseOwner,
          status: 'skipped',
        })
      }
      return
    }

    const spaceResolution = snapshot.spaceId && snapshot.spaceContext
      ? await this.#resolveSpace(snapshot.spaceId, snapshot.spaceContext)
      : null
    if (snapshot.spaceId && !spaceResolution) {
      this.#skipAndBlock(
        occurrence.id,
        occurrence.leaseOwner,
        occurrence.automationId,
        occurrence.automationRevision,
        'AUTOMATION_SPACE_UNAVAILABLE',
      )
      return
    }
    if (spaceResolution?.status === 'context_changed') {
      this.#automationService.finishQueued({
        errorCode: 'AUTOMATION_SPACE_UNAVAILABLE',
        id: occurrence.id,
        leaseOwner: occurrence.leaseOwner,
        status: 'skipped',
      })
      return
    }
    const space = spaceResolution?.status === 'ready' ? spaceResolution : null

    const branchId = this.#createId()
    const conversationId = this.#createId()
    const messageId = this.#createId()
    const runId = this.#createId()
    const boundAt = formatInstant(this.#clock.now())
    const binding = this.#turns.bind({
      boundAt,
      branchId,
      contextWindow: model.contextWindow,
      conversationId,
      leaseOwner: occurrence.leaseOwner,
      maxTokens: model.maxTokens,
      messageId,
      model: model.modelId,
      occurrenceId: occurrence.id,
      executionContext: space?.executionContext ?? null,
      spaceId: space?.id ?? null,
      provider: model.providerId,
      reasoning: model.reasoning,
      runId,
    })
    if (binding.kind === 'overlap_skipped')
      return
    if (binding.kind === 'space_context_changed') {
      this.#automationService.finishQueued({
        errorCode: 'AUTOMATION_SPACE_UNAVAILABLE',
        id: occurrence.id,
        leaseOwner: occurrence.leaseOwner,
        status: 'skipped',
      })
      return
    }
    if (binding.kind === 'space_unavailable') {
      this.#skipAndBlock(
        occurrence.id,
        occurrence.leaseOwner,
        occurrence.automationId,
        occurrence.automationRevision,
        'AUTOMATION_SPACE_UNAVAILABLE',
      )
      return
    }
    const bound = binding
    const turn = await this.#launchTurn(bound.run.id)
    await this.#waitForTurn(turn)
  }

  async #waitForTurn(turn: BuddyTurnHandle): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(resolve, this.#runTimeoutMs, 'timeout')
      timer.unref?.()
    })
    try {
      const result = await Promise.race([
        turn.completion.then(() => 'completed' as const),
        timeout,
      ])
      if (result === 'completed')
        return
      await this.#cancelRun(turn.runId, 'AUTOMATION_RUN_TIMEOUT')
      await turn.completion
    }
    finally {
      if (timer)
        clearTimeout(timer)
    }
  }

  #skipAndBlock(
    occurrenceId: string,
    leaseOwner: string,
    automationId: string,
    expectedRevision: number,
    reason: 'AUTOMATION_SPACE_UNAVAILABLE',
  ): void {
    this.#automationService.finishQueuedAndBlock({
      automationId,
      expectedRevision,
      id: occurrenceId,
      leaseOwner,
      reason,
    })
  }
}

function formatInstant(value: Temporal.Instant): string {
  return value.toString({ smallestUnit: 'millisecond' })
}
