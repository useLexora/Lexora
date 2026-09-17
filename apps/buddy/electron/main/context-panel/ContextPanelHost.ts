import type { ContextPanelCommand, ContextPanelOperation, ContextPanelOperationRecord, ContextPanelState } from '../../../shared/context-panel/contextPanel'

export class ContextPanelHost {
  #state: ContextPanelState = { revision: 0, open: false, target: null }
  readonly #listeners = new Set<(state: ContextPanelState) => void>()
  readonly #recordOperation: (operation: ContextPanelOperationRecord) => Promise<void>

  constructor(recordOperation: (operation: ContextPanelOperationRecord) => Promise<void>) {
    this.#recordOperation = recordOperation
  }

  getState(): ContextPanelState {
    return structuredClone(this.#state)
  }

  async execute(command: ContextPanelCommand, actor: ContextPanelOperation['actor'] = 'user'): Promise<ContextPanelState> {
    const open = command.action === 'open'
    const visibilityChanged = open !== this.#state.open
    const target = command.action === 'open' ? command.target ?? null : null
    if (!visibilityChanged && target === null && this.#state.target === null) {
      return this.getState()
    }
    this.#state = {
      revision: this.#state.revision + 1,
      open,
      target,
    }
    const state = this.getState()
    for (const listener of this.#listeners)
      listener(this.getState())
    const source = target?.source ?? command.source
    if (visibilityChanged && source)
      await this.#recordOperation({ action: command.action, actor, source, createdAt: new Date().toISOString() })
    return state
  }

  subscribe(listener: (state: ContextPanelState) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}
