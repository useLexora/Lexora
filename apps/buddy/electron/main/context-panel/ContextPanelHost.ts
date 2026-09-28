import type { ContextPanelCommand, ContextPanelOperation, ContextPanelOperationRecord, ContextPanelState } from '../../../shared/context-panel/contextPanel'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'

export type ContextPanelChange = {
  readonly operationId: string
  readonly revision: number
  readonly state: Readonly<ContextPanelState>
} & ({ readonly kind: 'state', readonly actor: ContextPanelOperation['actor'] } | { readonly kind: 'record', readonly status: 'recorded' | 'failed' })

export class ContextPanelHost {
  #state: ContextPanelState = { revision: 0, open: false, target: null }
  readonly #changes = new Emitter<ContextPanelChange>(() => console.error('CONTEXT_PANEL_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly #pending = new Set<Promise<ContextPanelState>>()
  #revision = 0
  #disposing: Promise<void> | undefined
  readonly #recordOperation: (operation: ContextPanelOperationRecord) => Promise<void>

  constructor(recordOperation: (operation: ContextPanelOperationRecord) => Promise<void>) {
    this.#recordOperation = recordOperation
  }

  getState(): ContextPanelState {
    return structuredClone(this.#state)
  }

  get snapshot() { return copyEventSnapshot({ revision: this.#revision, state: this.#state }) }

  execute(command: ContextPanelCommand, actor: ContextPanelOperation['actor'] = 'user'): Promise<ContextPanelState> {
    if (this.#disposing)
      return Promise.reject(new Error('CONTEXT_PANEL_CLOSED'))
    const input = structuredClone(command)
    const accepted = Promise.withResolvers<ContextPanelState>()
    this.#pending.add(accepted.promise)
    void this.#execute(input, actor).then(accepted.resolve, accepted.reject).finally(() => this.#pending.delete(accepted.promise))
    return accepted.promise
  }

  async #execute(command: ContextPanelCommand, actor: ContextPanelOperation['actor']): Promise<ContextPanelState> {
    const open = command.action === 'open'
    const visibilityChanged = open !== this.#state.open
    const target = command.action === 'open' ? command.target ?? null : null
    if (!visibilityChanged && JSON.stringify(target) === JSON.stringify(this.#state.target)) {
      return this.getState()
    }
    this.#state = {
      revision: this.#state.revision + 1,
      open,
      target,
    }
    const state = this.getState()
    const operationId = randomUUID()
    this.#changes.fire(copyEventSnapshot({ kind: 'state', operationId, state, actor, revision: ++this.#revision }))
    const source = target?.source ?? command.source
    if (visibilityChanged && source) {
      let status: 'recorded' | 'failed' = 'recorded'
      try {
        await this.#recordOperation({ action: command.action, actor, source, createdAt: new Date().toISOString() })
      }
      catch {
        status = 'failed'
      }
      this.#changes.fire(copyEventSnapshot({ kind: 'record', operationId, state, status, revision: ++this.#revision }))
    }
    return state
  }

  dispose(): Promise<void> {
    this.#disposing ??= Promise.allSettled([...this.#pending]).then(() => this.#changes.dispose())
    return this.#disposing
  }
}
