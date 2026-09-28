import type { LocalTaskMarkState, TaskMarkClearInput, TaskMarkInput, TaskMarkReadInput } from '../../../shared/conversation/taskMarkApi'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { TaskMarkRepository } from '../storage/taskMarkRepository'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { BuddyServiceError } from '../rpc/runtimeRequest'

export type TaskMarkCommit = EventSnapshot<{ commitId: string } & (
  | { kind: 'created' | 'updated', markId: string }
  | { kind: 'deleted', markId: string, conversationIds: string[] }
  | { kind: 'attention', conversationId: string, assignmentChanged: boolean, readChanged: boolean, state: LocalTaskMarkState }
)>

export class TaskMarkService {
  readonly #repository: TaskMarkRepository
  readonly #committed: Emitter<TaskMarkCommit>
  readonly onDidCommit: Emitter<TaskMarkCommit>['event']
  #disposed = false

  constructor(repository: TaskMarkRepository, onObserverError: (error: unknown) => void = () => {}) {
    this.#repository = repository
    this.#committed = new Emitter(onObserverError)
    this.onDidCommit = this.#committed.event
  }

  create(input: TaskMarkInput) {
    this.#requireActive()
    const mark = this.#repository.create(input)
    this.#committed.fire(copyEventSnapshot({ commitId: randomUUID(), kind: 'created', markId: mark.id }))
    return mark
  }

  update(id: string, input: TaskMarkInput) {
    this.#requireActive()
    const current = this.#repository.list().find(mark => mark.id === id)
    if (current?.name === input.name && current.description === input.description && current.color === input.color)
      return current
    const mark = this.#repository.update(id, input)
    this.#committed.fire(copyEventSnapshot({ commitId: randomUUID(), kind: 'updated', markId: mark.id }))
    return mark
  }

  delete(id: string): boolean {
    this.#requireActive()
    const result = this.#repository.deleteWithReceipt(id)
    if (result.deleted)
      this.#committed.fire(copyEventSnapshot({ commitId: randomUUID(), kind: 'deleted', markId: id, conversationIds: result.conversationIds }))
    return result.deleted
  }

  assign(conversationId: string, markId: string | null): LocalTaskMarkState {
    this.#requireActive()
    const before = this.#repository.getState(conversationId)
    if (before.markId === markId)
      return before
    const state = this.#repository.assign(conversationId, markId)
    this.#publishAttention(before, state)
    return state
  }

  setRead(input: TaskMarkReadInput): LocalTaskMarkState {
    this.#requireActive()
    const before = this.#repository.getState(input.conversationId)
    const state = this.#repository.setRead(input)
    this.#publishAttention(before, state)
    return state
  }

  clear(input: TaskMarkClearInput): LocalTaskMarkState {
    this.#requireActive()
    const before = this.#repository.getState(input.conversationId)
    const state = this.#repository.clear(input)
    this.#publishAttention(before, state)
    return state
  }

  dispose(): void {
    this.#disposed = true
    this.#committed.dispose()
  }

  #requireActive(): void {
    if (this.#disposed)
      throw new BuddyServiceError('VALIDATION_FAILED')
  }

  #publishAttention(before: LocalTaskMarkState, state: LocalTaskMarkState): void {
    const assignmentChanged = before.markId !== state.markId
    const readChanged = before.readRevision !== state.readRevision
    if (assignmentChanged || readChanged)
      this.#committed.fire(copyEventSnapshot({ commitId: randomUUID(), kind: 'attention', conversationId: state.conversationId, assignmentChanged, readChanged, state }))
  }
}
