import type { AutomationTurnRepository, BindAutomationTurnInput } from '../storage/automationTurnRepository'
import type { AutomationCommit, AutomationFact } from './AutomationEvents'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { occurrenceFact } from './AutomationEvents'

export class AutomationTurnService implements AutomationTurnRepository {
  readonly #repository: AutomationTurnRepository
  readonly #committed: Emitter<AutomationCommit>
  readonly onDidCommit: Emitter<AutomationCommit>['event']
  #revision = 0
  #disposed = false

  constructor(repository: AutomationTurnRepository, onObserverError: (error: unknown) => void = () => {}) {
    this.#repository = repository
    this.#committed = new Emitter(onObserverError)
    this.onDidCommit = this.#committed.event
  }

  bind(input: BindAutomationTurnInput) {
    if (this.#disposed)
      throw new Error('Automation turn service is stopped')
    const binding = this.#repository.bind(input)
    const facts: AutomationFact[] = []
    if (binding.kind === 'bound') {
      const identity = { automationId: binding.occurrence.automationId, occurrenceId: binding.occurrence.id, conversationId: binding.conversation.id, branchId: binding.run.branchId, runId: binding.run.id }
      facts.push(
        { kind: 'occurrence.bound', ...identity },
        { kind: 'task.created', ...identity },
        { kind: 'branch.created', ...identity },
        { kind: 'message.created', ...identity, messageId: binding.run.triggeringMessageId },
        { kind: 'run.queued', ...identity },
      )
      if (binding.lastRunChanged)
        facts.push({ kind: 'definition.last_run_changed', automationId: identity.automationId, lastRunAt: input.boundAt })
    }
    else if (binding.kind === 'overlap_skipped') {
      facts.push(occurrenceFact(binding.occurrence))
    }
    if (facts.length)
      this.#committed.fire(copyEventSnapshot({ operationId: binding.kind === 'bound' ? binding.run.id : randomUUID(), revision: ++this.#revision, facts }))
    return binding
  }

  dispose(): void {
    this.#disposed = true
    this.#committed.dispose()
  }
}
