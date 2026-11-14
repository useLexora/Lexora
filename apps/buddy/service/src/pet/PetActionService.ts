import type { PetExecuteSequenceResult } from '../../../shared/runtime/petProtocol'
import type { AppendBuddyRunEventInput } from '../events/BuddyRunEvent'
import type { RuntimePlatform } from '../platform/RuntimePlatform'
import type { PetMacroId } from './petMacroCatalog'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import {
  petExecuteSequenceParamsSchema,
  petExecuteSequenceResultSchema,
} from '../../../shared/runtime/petProtocol'
import { compilePetMacro } from './petMacroCatalog'
import { createPetToolPresentation, PET_TOOL_NAME } from './petToolContract'

export interface PetActionEventSink {
  (event: AppendBuddyRunEventInput): Promise<unknown> | unknown
}

export interface PetActionServiceOptions {
  eventSink?: PetActionEventSink
  executeSequence: RuntimePlatform['executePetSequence']
}

export interface ExecutePetActionInput {
  macro: PetMacroId
  runId?: string
  toolCallId?: string
}

export type PetActionChange = Readonly<ExecutePetActionInput> & {
  readonly operationId: string
  readonly revision: number
} & (
  | { readonly phase: 'requested' | 'transport-unknown' }
  | { readonly phase: 'host-confirmed', readonly result: Readonly<PetExecuteSequenceResult> }
  | { readonly phase: 'progress-recorded' | 'progress-failed', readonly result: Readonly<PetExecuteSequenceResult> | null }
)

export class PetActionService {
  readonly #changes = new Emitter<PetActionChange>(() => console.error('PET_ACTION_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly #pending = new Set<Promise<PetExecuteSequenceResult>>()
  #revision = 0
  #disposing: Promise<void> | undefined
  readonly #eventSink?: PetActionEventSink
  readonly #executeSequence: RuntimePlatform['executePetSequence']

  constructor(options: PetActionServiceOptions) {
    this.#eventSink = options.eventSink
    this.#executeSequence = options.executeSequence
  }

  execute(input: ExecutePetActionInput): Promise<PetExecuteSequenceResult> {
    if (this.#disposing)
      return Promise.reject(new Error('PET_SERVICE_STOPPED'))
    const accepted = { ...input }
    const pending = Promise.resolve().then(() => this.#execute(accepted)).finally(() => this.#pending.delete(pending))
    this.#pending.add(pending)
    return pending
  }

  async #execute(input: ExecutePetActionInput): Promise<PetExecuteSequenceResult> {
    const identity = { ...input, operationId: randomUUID() }
    const request = petExecuteSequenceParamsSchema.parse(compilePetMacro(
      input.macro,
      `pet_${randomUUID()}`,
    ))
    let result: PetExecuteSequenceResult
    let confirmed: PetExecuteSequenceResult | null = null
    this.#changes.fire(copyEventSnapshot({ ...identity, phase: 'requested', revision: ++this.#revision }))
    try {
      result = await this.#executeSequence(request)
      confirmed = result
      this.#changes.fire(copyEventSnapshot({ ...identity, phase: 'host-confirmed', result, revision: ++this.#revision }))
    }
    catch {
      this.#changes.fire(copyEventSnapshot({ ...identity, phase: 'transport-unknown', revision: ++this.#revision }))
      result = petExecuteSequenceResultSchema.parse({
        code: 'PET_UNAVAILABLE',
        completedSteps: 0,
        status: 'failed',
      })
    }

    if (input.runId && input.toolCallId && this.#eventSink) {
      try {
        await this.#eventSink({
          payload: {
            macro: input.macro,
            presentation: createPetToolPresentation({
              arguments: { macro: input.macro },
              result: { details: { macro: input.macro, status: result.status } },
              toolName: PET_TOOL_NAME,
            }),
            status: result.status,
            toolCallId: input.toolCallId,
            toolName: PET_TOOL_NAME,
          },
          runId: input.runId,
          type: 'tool.updated',
        })
        this.#changes.fire(copyEventSnapshot({ ...identity, phase: 'progress-recorded', result: confirmed, revision: ++this.#revision }))
      }
      catch (error) {
        this.#changes.fire(copyEventSnapshot({ ...identity, phase: 'progress-failed', result: confirmed, revision: ++this.#revision }))
        throw error
      }
    }
    return result
  }

  dispose(): Promise<void> {
    this.#disposing ??= Promise.allSettled([...this.#pending]).then(() => this.#changes.dispose())
    return this.#disposing
  }
}
