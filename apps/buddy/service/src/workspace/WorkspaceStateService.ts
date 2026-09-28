import type { WorkspaceRepository, WorkspaceSettingRecord } from '../storage/workspaceRepository'
import { randomUUID } from 'node:crypto'
import { legacyWorkspaceStateValueSchema, LOCAL_WORKSPACE_STATE_KEY, localWorkspaceStateValueSchema } from '../../../shared/conversation/workspaceApi'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { BuddyServiceError } from '../rpc/runtimeRequest'

export interface WorkspaceStateChange {
  readonly revision: number
  readonly operationId: string
  readonly kind: 'committed' | 'normalized' | 'normalization-failed'
  readonly setting: 'chat-workspace'
}
export class WorkspaceStateService {
  readonly #repository: Pick<WorkspaceRepository, 'getRecord' | 'set'>
  readonly #normalize?: (value: unknown) => Promise<unknown>
  readonly #changes = new Emitter<WorkspaceStateChange>(() => console.error('WORKSPACE_STATE_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly #pending = new Set<Promise<unknown>>()
  #stopped = false
  #revision = 0

  constructor(options: { repository: Pick<WorkspaceRepository, 'getRecord' | 'set'>, normalize?: (value: unknown) => Promise<unknown> }) {
    this.#repository = options.repository
    this.#normalize = options.normalize
  }

  get snapshot() {
    return copyEventSnapshot({ revision: this.#revision, record: this.#repository.getRecord(LOCAL_WORKSPACE_STATE_KEY) })
  }

  read(): Promise<Readonly<WorkspaceSettingRecord> | null> {
    if (this.#stopped)
      return Promise.reject(new BuddyServiceError('RUNTIME_UNAVAILABLE'))
    const record = this.#repository.getRecord(LOCAL_WORKSPACE_STATE_KEY)
    if (!record || !this.#normalize)
      return Promise.resolve(copyEventSnapshot(record))
    const operationId = randomUUID()
    const normalize = this.#normalize
    const result = Promise.resolve().then(() => normalize(copyEventSnapshot(record.value))).then((value) => {
      if (JSON.stringify(value) !== JSON.stringify(record.value))
        this.#publish('normalized', operationId)
      return copyEventSnapshot({ ...record, value })
    }, (error: unknown) => {
      this.#publish('normalization-failed', operationId)
      throw error
    })
    this.#pending.add(result)
    void result.then(() => this.#pending.delete(result), () => this.#pending.delete(result))
    return result
  }

  write(value: unknown): Readonly<WorkspaceSettingRecord> {
    if (this.#stopped)
      throw new BuddyServiceError('RUNTIME_UNAVAILABLE')
    const parsed = localWorkspaceStateValueSchema.or(legacyWorkspaceStateValueSchema).parse(value)
    const previous = this.#repository.getRecord(LOCAL_WORKSPACE_STATE_KEY)
    if (previous && JSON.stringify(previous.value) === JSON.stringify(parsed))
      return copyEventSnapshot(previous)
    this.#repository.set(LOCAL_WORKSPACE_STATE_KEY, parsed, new Date().toISOString())
    const record = this.#repository.getRecord(LOCAL_WORKSPACE_STATE_KEY)
    if (!record)
      throw new BuddyServiceError('VALIDATION_FAILED')
    this.#publish('committed', randomUUID())
    return copyEventSnapshot(record)
  }

  async dispose(): Promise<void> {
    this.#stopped = true
    await Promise.allSettled([...this.#pending])
    this.#changes.dispose()
  }

  #publish(kind: WorkspaceStateChange['kind'], operationId: string): void {
    this.#changes.fire(Object.freeze({ revision: ++this.#revision, operationId, kind, setting: 'chat-workspace' }))
  }
}
