import type { ControlProposal, ControlSnapshot } from '@buddy-shared/workbench/workbenchUi'
import { shallowRef } from 'vue'

export class ControlBinding {
  readonly snapshot = shallowRef<ControlSnapshot>({ revision: crypto.randomUUID(), value: null, options: [], disabled: true })
  readonly #visible: () => boolean
  readonly #change: (value: string) => void
  #context = ''

  constructor(visible: () => boolean, change: (value: string) => void) {
    this.#visible = visible
    this.#change = change
  }

  update(context: string, state: Omit<ControlSnapshot, 'revision'>): void {
    const previous = this.snapshot.value
    if (context === this.#context && previous.value === state.value && previous.disabled === state.disabled && JSON.stringify(previous.options) === JSON.stringify(state.options))
      return
    this.#context = context
    this.snapshot.value = { revision: crypto.randomUUID(), value: state.value, disabled: state.disabled, options: state.options.map(option => ({ ...option })) }
  }

  propose(proposal: ControlProposal): boolean {
    const current = this.snapshot.value
    if (!this.#visible() || current.disabled || current.revision !== proposal.revision || !current.options.some(option => option.value === proposal.value))
      return false
    this.snapshot.value = { ...current, revision: crypto.randomUUID() }
    this.#change(proposal.value)
    return true
  }
}
