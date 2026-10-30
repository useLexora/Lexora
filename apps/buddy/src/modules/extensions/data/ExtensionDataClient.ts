import type {
  ExtensionDataQuery,
  ExtensionDataSnapshot,
  ExtensionDataSource,
} from '@buddy-shared/extensions/extensionData'
import { extensionDataQuerySchema } from '@buddy-shared/extensions/extensionData'

export interface ExtensionDataBinding {
  key: string
  read: () => Promise<ExtensionDataSnapshot>
}

export interface ExtensionDataClientOptions {
  sources: () => readonly ExtensionDataSource[]
  binding: (source: ExtensionDataSource) => ExtensionDataBinding | null
  publish: (update: { id: string, snapshot: ExtensionDataSnapshot | null }) => void
  observeChanges: (listener: () => void) => () => void
}

interface Observation {
  id: string
  query: ExtensionDataQuery
  pending?: symbol
}

type EmptyStatus = 'denied' | 'no_target' | 'unavailable'

interface ReadResult {
  snapshot: ExtensionDataSnapshot
  epoch: number
  revision: number
}

interface SourceState {
  status: 'ready' | EmptyStatus
  key: string | null
  epoch: number
  revision: number
  inFlight?: Promise<ReadResult>
}

function emptySnapshot(source: ExtensionDataSource, status: EmptyStatus): ExtensionDataSnapshot {
  return { source, status, value: null }
}

export class ExtensionDataClient {
  private readonly observations = new Map<string, Observation>()
  private readonly states = new Map<ExtensionDataSource, SourceState>()
  private stopObserving?: () => void
  private timer?: ReturnType<typeof setTimeout>
  private readers = 0
  private disposed = false

  constructor(private readonly options: ExtensionDataClientOptions) {}

  async read<Source extends ExtensionDataSource>(query: ExtensionDataQuery<Source>): Promise<ExtensionDataSnapshot<Source>> {
    this.validateQuery(query)
    if (this.disposed)
      return emptySnapshot(query.source, 'unavailable') as ExtensionDataSnapshot<Source>

    this.readers++
    try {
      this.ensureObserving()
      const result = await this.readSource(query.source)
      return this.currentSnapshot(query.source, result) as ExtensionDataSnapshot<Source>
    }
    finally {
      this.readers--
      this.releaseIfIdle()
    }
  }

  observe({ id, query }: { id: string, query: ExtensionDataQuery }): void {
    this.validateQuery(query)
    if (this.disposed)
      return

    const previous = this.observations.get(id)
    if (previous) {
      if (previous.query.source !== query.source || previous.query.scope !== query.scope)
        throw new Error('Extension data observation ID is already in use')
      return
    }
    if (this.observations.size >= 32)
      throw new Error('Extension data observation limit exceeded')

    const observation: Observation = { id, query: { ...query } }
    this.observations.set(id, observation)
    this.ensureObserving()
    void Promise.resolve().then(() => this.publishObservation(observation))
  }

  unobserve(id: string): void {
    if (!this.observations.delete(id))
      return
    this.options.publish({ id, snapshot: null })
    this.releaseIfIdle()
  }

  refresh(): void {
    if (this.disposed)
      return
    for (const source of this.states.keys()) {
      const { state } = this.inspect(source)
      state.revision++
    }
    this.scheduleRefresh()
  }

  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    this.observations.clear()
    this.clearTimer()
    this.stopObserving?.()
    this.stopObserving = undefined
    this.invalidateReads()
  }

  private validateQuery(query: ExtensionDataQuery): void {
    if (!extensionDataQuerySchema.safeParse(query).success)
      throw new Error('Invalid extension data query')
  }

  private inspect(source: ExtensionDataSource): { state: SourceState, binding: ExtensionDataBinding | null } {
    const allowed = this.options.sources().includes(source)
    const binding = allowed ? this.options.binding(source) : null
    const status = !allowed ? 'denied' : binding ? 'ready' : 'no_target'
    const key = binding?.key ?? null
    let state = this.states.get(source)
    if (!state) {
      state = { status, key, epoch: 0, revision: 0 }
      this.states.set(source, state)
    }
    else if (state.status !== status || state.key !== key) {
      state.status = status
      state.key = key
      state.epoch++
      state.revision++
      state.inFlight = undefined
      const snapshot = emptySnapshot(source, status === 'ready' ? 'unavailable' : status)
      for (const observation of this.observations.values()) {
        if (observation.query.source !== source)
          continue
        observation.pending = undefined
        this.options.publish({ id: observation.id, snapshot })
      }
      this.scheduleRefresh()
    }
    return { state, binding }
  }

  private async readSource(source: ExtensionDataSource): Promise<ReadResult> {
    if (this.disposed)
      return { snapshot: emptySnapshot(source, 'unavailable'), epoch: -1, revision: -1 }

    const { state, binding } = this.inspect(source)
    const { epoch, revision } = state
    if (!binding)
      return { snapshot: emptySnapshot(source, state.status as EmptyStatus), epoch, revision }
    if (state.inFlight)
      return state.inFlight

    const pending = Promise.resolve().then(async (): Promise<ReadResult> => {
      if (this.disposed)
        return { snapshot: emptySnapshot(source, 'unavailable'), epoch, revision }
      const current = this.inspect(source)
      if (current.state.epoch !== epoch || !current.binding)
        return { snapshot: this.emptyCurrent(source, current.state), epoch, revision }

      let snapshot: ExtensionDataSnapshot
      try {
        snapshot = await current.binding.read()
      }
      catch {
        snapshot = emptySnapshot(source, 'unavailable')
      }
      return { snapshot: this.currentSnapshot(source, { snapshot, epoch, revision }), epoch, revision }
    })
    state.inFlight = pending
    try {
      return await pending
    }
    finally {
      if (state.inFlight === pending)
        state.inFlight = undefined
    }
  }

  private emptyCurrent(source: ExtensionDataSource, state: SourceState): ExtensionDataSnapshot {
    return emptySnapshot(source, state.status === 'ready' ? 'unavailable' : state.status)
  }

  private currentSnapshot(source: ExtensionDataSource, result: ReadResult): ExtensionDataSnapshot {
    if (this.disposed)
      return emptySnapshot(source, 'unavailable')
    const { state } = this.inspect(source)
    if (state.epoch !== result.epoch || result.snapshot.source !== source)
      return this.emptyCurrent(source, state)
    return result.snapshot
  }

  private async publishObservation(observation: Observation): Promise<void> {
    if (this.disposed || observation.pending || this.observations.get(observation.id) !== observation)
      return
    const pending = Symbol('observation read')
    observation.pending = pending
    try {
      const result = await this.readSource(observation.query.source)
      if (this.disposed || observation.pending !== pending || this.observations.get(observation.id) !== observation)
        return

      const { state } = this.inspect(observation.query.source)
      if (state.epoch !== result.epoch || state.revision !== result.revision) {
        this.scheduleRefresh()
        return
      }
      this.options.publish({ id: observation.id, snapshot: result.snapshot })
    }
    finally {
      if (observation.pending === pending)
        observation.pending = undefined
    }
  }

  private scheduleRefresh(): void {
    if (this.timer !== undefined || this.observations.size === 0 || this.disposed)
      return
    this.timer = setTimeout(() => {
      this.timer = undefined
      for (const observation of this.observations.values())
        void this.publishObservation(observation)
    }, 120)
  }

  private ensureObserving(): void {
    this.stopObserving ??= this.options.observeChanges(() => this.refresh())
  }

  private clearTimer(): void {
    if (this.timer === undefined)
      return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private invalidateReads(): void {
    for (const state of this.states.values()) {
      state.epoch++
      state.revision++
      state.inFlight = undefined
    }
  }

  private releaseIfIdle(): void {
    if (this.observations.size > 0 || this.readers > 0)
      return
    this.clearTimer()
    this.stopObserving?.()
    this.stopObserving = undefined
    this.invalidateReads()
  }
}
