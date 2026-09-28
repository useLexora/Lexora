import type { ApplicationStartupState } from '../../../shared/diagnostics/applicationStartup'
import type { Event, ListenerErrorHandler } from '../../../shared/events/Emitter'
import type { LifecycleFailure } from '../../../shared/lifecycle/lifecycleFailure'
import type { RuntimeLifecycleReader, RuntimeLifecycleSnapshot } from '../../../shared/lifecycle/runtimeLifecycle'
import type { RendererLifecycleReport, ServiceLifecycleReader, ServiceLifecycleSnapshot } from '../../../shared/lifecycle/serviceLifecycle'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { readLifecycleFailure } from '../../../shared/lifecycle/lifecycleFailure'

type StartupTransition = 'ready' | 'recovered' | 'start_failed' | 'degraded' | 'start_cancelled' | 'stopped' | 'stop_failed'
export interface StartupChange {
  readonly state: ApplicationStartupState
  readonly transition?: StartupTransition
  readonly component?: string
  readonly operationId?: string
  readonly durationMs?: number
  readonly failure?: LifecycleFailure
}

const REQUIRED_HOSTS = ['desktop', 'runtime.connection', 'renderer'] as const
const COMPONENT_STATUSES = {
  registered: 'pending',
  starting: 'running',
  ready: 'completed',
  start_failed: 'failed',
  stopping: 'stopping',
  stopped: 'stopped',
  stop_failed: 'failed',
} as const

export class DesktopStartup {
  readonly #changes: Emitter<StartupChange>
  readonly #rendererReports: Emitter<RendererLifecycleReport>
  readonly onDidChange: Event<StartupChange>
  readonly onDidReportRenderer: Event<RendererLifecycleReport>
  readonly #rendererRevisions = new Map<string, number>()
  readonly #startedAt = performance.now()
  readonly #retiredRenderers = new Set<string>()
  #desktopSource: ServiceLifecycleReader | null = null
  #runtimeSource: RuntimeLifecycleReader | null = null
  #desktop: ServiceLifecycleSnapshot | null = null
  #runtime: RuntimeLifecycleSnapshot | null = null
  #renderer: ServiceLifecycleSnapshot | null = null
  #terminalStatus: 'stopping' | 'stopped' | null = null
  #failure: LifecycleFailure | null = null
  #state: ApplicationStartupState = {
    revision: 0,
    generation: null,
    hasBeenReady: false,
    status: 'starting',
    stages: REQUIRED_HOSTS.map(stage => ({ stage, status: 'pending' })),
  }

  constructor(onListenerError: ListenerErrorHandler = () => {}) {
    this.#changes = new Emitter(onListenerError)
    this.#rendererReports = new Emitter(onListenerError)
    this.onDidChange = this.#changes.event
    this.onDidReportRenderer = this.#rendererReports.event
  }

  get state(): ApplicationStartupState {
    return structuredClone(this.#state)
  }

  onStateChange(listener: (state: ApplicationStartupState) => void): () => void {
    const subscription = this.onDidChange(change => listener(structuredClone(change.state)))
    return () => subscription.dispose()
  }

  bindDesktop(source: ServiceLifecycleReader): () => void {
    this.#desktopSource = source
    const subscription = source.onDidChange(() => this.reconcile())
    this.reconcile()
    return () => {
      subscription.dispose()
      if (this.#desktopSource === source)
        this.#desktopSource = null
    }
  }

  bindRuntime(source: RuntimeLifecycleReader): () => void {
    this.#runtimeSource = source
    const subscription = source.onDidChangeLifecycle(() => this.reconcile())
    this.reconcile()
    return () => {
      subscription.dispose()
      if (this.#runtimeSource === source)
        this.#runtimeSource = null
    }
  }

  reconcile(): ApplicationStartupState {
    if (this.#desktopSource)
      this.#desktop = this.#desktopSource.snapshot
    if (this.#runtimeSource) {
      const runtime = this.#runtimeSource.lifecycleState
      if (runtime.generation !== this.#runtime?.generation) {
        this.#renderer = null
        this.#retiredRenderers.clear()
      }
      this.#runtime = runtime
    }
    this.#update()
    return this.state
  }

  acceptRenderer(report: RendererLifecycleReport): boolean {
    const snapshot = report.change.snapshot
    if (snapshot.revision <= (this.#rendererRevisions.get(snapshot.sourceId) ?? -1))
      return false
    this.#rendererRevisions.set(snapshot.sourceId, snapshot.revision)
    if (this.#rendererRevisions.size > 256)
      this.#rendererRevisions.delete(this.#rendererRevisions.keys().next().value!)
    this.#rendererReports.fire(copyEventSnapshot(report))
    if (report.generation !== this.#runtime?.generation || this.#terminalStatus)
      return false
    if (this.#retiredRenderers.has(snapshot.sourceId))
      return false
    if (this.#renderer?.sourceId === snapshot.sourceId && snapshot.revision <= this.#renderer.revision)
      return false
    if (this.#renderer && this.#renderer.sourceId !== snapshot.sourceId) {
      const root = snapshot.components.find(component => component.component === 'renderer')
      if (!root || !['registered', 'starting'].includes(root.status))
        return false
      this.#retiredRenderers.add(this.#renderer.sourceId)
    }
    this.#renderer = copyEventSnapshot(snapshot)
    this.#update()
    return true
  }

  stopping(): void {
    if (this.#terminalStatus)
      return
    const cancelled = this.#state.status === 'starting' && !this.#state.hasBeenReady
    this.#terminalStatus = 'stopping'
    this.#publish({ ...this.#state, status: 'stopping' }, cancelled ? { transition: 'start_cancelled' } : {})
  }

  failed(error: unknown): void {
    if (this.#terminalStatus || this.#state.status === 'failed')
      return
    this.#failure = readLifecycleFailure(error)
    this.#update()
  }

  stopped(error?: unknown): void {
    if (this.#terminalStatus === 'stopped')
      return
    this.#terminalStatus = 'stopped'
    this.#publish({ ...this.#state, status: 'stopped' }, error === undefined ? { transition: 'stopped' } : { transition: 'stop_failed', failure: readLifecycleFailure(error) })
  }

  #update(): void {
    if (this.#terminalStatus)
      return
    const components = [
      ...this.#desktop?.components ?? [],
      ...this.#runtime?.services?.components ?? [],
      ...this.#renderer?.components ?? [],
    ]
    const connection = this.#runtime?.connection
    if (connection)
      components.push(connection)
    const stages: ApplicationStartupState['stages'][number][] = components.map(component => ({
      stage: component.component,
      status: COMPONENT_STATUSES[component.status],
      operationId: component.operationId,
      ...(component.durationMs === undefined ? {} : { durationMs: component.durationMs }),
      ...(component.failure?.errorCode ? { errorCode: component.failure.errorCode } : {}),
    }))
    for (const required of REQUIRED_HOSTS) {
      if (!stages.some(stage => stage.stage === required))
        stages.push({ stage: required, status: 'pending' })
    }
    const runtime = this.#runtime
    if (runtime && runtime.status !== 'ready') {
      const stage = stages.find(stage => stage.stage === 'runtime.connection')!
      stage.status = runtime.status === 'offline' ? 'failed' : runtime.status === 'stopped' ? 'pending' : 'running'
      if (runtime.errorCode)
        stage.errorCode = runtime.errorCode
    }
    const failedComponent = components.find(component => component.status === 'start_failed' || component.status === 'stop_failed')
    const failed = this.#failure !== null || stages.some(stage => stage.status === 'failed')
    const ready = !failed && REQUIRED_HOSTS.every(id => stages.some(stage => stage.stage === id && stage.status === 'completed'))
    const status = failed ? 'failed' : ready ? 'ready' : 'starting'
    const next: ApplicationStartupState = { ...this.#state, generation: runtime?.generation ?? null, stages, status, hasBeenReady: this.#state.hasBeenReady || ready }
    const transition: Omit<StartupChange, 'state'> = {}
    if (ready && this.#state.status !== 'ready') {
      Object.assign(transition, { transition: this.#state.hasBeenReady ? 'recovered' : 'ready', durationMs: Math.round(performance.now() - this.#startedAt) })
    }
    else if (failed && this.#state.status !== 'failed') {
      const component = failedComponent ?? (runtime?.status === 'offline' ? connection : null)
      Object.assign(transition, {
        transition: this.#state.hasBeenReady ? 'degraded' : 'start_failed',
        ...(component ? { component: component.component, operationId: component.operationId } : {}),
        failure: this.#failure ?? component?.failure ?? (runtime?.errorCode ? { errorCode: runtime.errorCode } : {}),
      })
    }
    this.#publish(next, transition)
  }

  #publish(state: ApplicationStartupState, change: Omit<StartupChange, 'state'> = {}): void {
    if (JSON.stringify(state) === JSON.stringify(this.#state))
      return
    this.#state = { ...state, revision: this.#state.revision + 1 }
    this.#changes.fire(copyEventSnapshot({ state: this.#state, ...change }))
  }
}
