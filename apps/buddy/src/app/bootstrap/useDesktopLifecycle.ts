import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { useDesktopShellState } from '../shell/useDesktopShellState'
import type { DesktopAppState } from './useDesktopAppState'
import type { AutomationCapability } from '@/modules/automations'
import type { TaskIndexController } from '@/modules/tasks'
import { ServiceHost } from '@buddy-shared/lifecycle/ServiceHost'
import { ApplicationEvents } from '@buddy-shared/observability/ApplicationEvents'
import { computed, nextTick, onScopeDispose, shallowRef, watch } from 'vue'
import { useApplicationLifecycle } from '@/platform/runtime/useApplicationLifecycle'
import { requireInitialState } from './requireInitialState'

interface DesktopLifecycleOptions {
  api: LexoraDesktopApi
  appState: DesktopAppState
  automations: AutomationCapability
  shell: ReturnType<typeof useDesktopShellState>
  taskIndex: TaskIndexController
  prepareSurface?: () => Promise<void>
  flushSurface?: () => Promise<boolean>
  refreshSurface?: () => Promise<void>
}

export function useDesktopLifecycle(options: DesktopLifecycleOptions) {
  const { api, appState, automations, shell, taskIndex } = options
  const { state, loaded, refresh } = useApplicationLifecycle(api.app.startup)
  const dataReady = shallowRef(false)
  const failed = shallowRef(false)
  let disposed = false
  let indexInitialized = false
  let initialAttemptSettled = false
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  let tail = Promise.resolve()
  let requestedGeneration: string | null = null
  const runtimeReady = computed(() => state.value.stages.some(stage => stage.stage === 'runtime.connection' && stage.status === 'completed'))
  const loading = computed(() => !dataReady.value && !failed.value && state.value.status !== 'failed')
  const hasFailed = computed(() => failed.value || state.value.status === 'failed')

  const preparation = Promise.all([appState.initialize(), shell.initialize()])
  void preparation.catch(() => {
    failed.value = true
  })
  void loaded.catch(() => {
    failed.value = true
  })

  function scheduleRefresh(force = false): Promise<void> {
    const generation = state.value.generation
    if (!generation || !runtimeReady.value || (!force && generation === requestedGeneration))
      return tail
    requestedGeneration = generation
    dataReady.value = false
    failed.value = false
    tail = tail.then(async () => {
      if (disposed || generation !== state.value.generation || !runtimeReady.value)
        return
      const events = new ApplicationEvents({ generation })
      const reports: Promise<void>[] = []
      const stop = events.subscribe((event) => {
        const report = api.app.startup.reportEvent(event)
        void report.catch(() => {})
        reports.push(report)
      })
      const host = new ServiceHost(events)
      const assertActive = () => {
        if (disposed || generation !== state.value.generation || !runtimeReady.value)
          throw new DOMException('Startup superseded', 'AbortError')
      }
      try {
        await host.start('renderer', async () => {
          await preparation.catch(() => {})
          assertActive()
          await host.step('renderer.settings', async () => requireInitialState(await appState.initialize()))
          await host.step('renderer.shell', () => shell.initialize())
          assertActive()
          await appState.refreshRuntimeDependentState(host)
          assertActive()
          const results = await Promise.allSettled([
            host.step('renderer.tasks', async () => {
              if (indexInitialized) {
                await taskIndex.refresh()
                await options.refreshSurface?.()
              }
              else {
                await taskIndex.initialize()
                indexInitialized = true
              }
            }),
            host.step('renderer.automations', async () => requireInitialState(await (initialAttemptSettled ? automations.refresh() : automations.initialize()))),
          ])
          const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
          if (failures.length)
            throw new AggregateError(failures, 'Workspace restoration failed')
          assertActive()
          await host.step('renderer.surface', async () => {
            await options.prepareSurface?.()
            await nextTick()
            await globalThis.document?.fonts?.ready
            assertActive()
          })
        })
        await Promise.all(reports)
        if (!disposed && generation === state.value.generation && runtimeReady.value)
          dataReady.value = true
      }
      catch {
        await Promise.allSettled(reports)
        if (!disposed && generation === state.value.generation)
          failed.value = true
      }
      finally {
        stop()
        initialAttemptSettled = true
        resolveReady()
      }
    })
    return tail
  }

  const stopRuntimeWatch = watch([() => state.value.generation, runtimeReady], () => {
    if (!runtimeReady.value) {
      dataReady.value = false
      return
    }
    void scheduleRefresh()
  }, { immediate: true, flush: 'sync' })

  async function retry(): Promise<void> {
    failed.value = false
    try {
      await refresh()
    }
    catch {
      failed.value = true
      return
    }
    if (runtimeReady.value)
      await scheduleRefresh(true)
    else if (!(await appState.stores.runtimeSupervisor.restartRuntime()))
      failed.value = true
  }

  const stopHiddenListener = api.app.onHidden(() => {
    if (indexInitialized && !disposed)
      void Promise.resolve(options.flushSurface?.()).catch(() => undefined)
  })
  const stopBeforeQuitListener = api.app.onBeforeQuit(async () => {
    if (!indexInitialized)
      return true
    try {
      await tail
      return !disposed && (await options.flushSurface?.() ?? true)
    }
    catch {
      return false
    }
  })

  onScopeDispose(() => {
    disposed = true
    stopHiddenListener()
    stopBeforeQuitListener()
    stopRuntimeWatch()
    resolveReady()
    automations.dispose()
    taskIndex.dispose()
    appState.dispose()
  })

  return { ready, state, loading, failed: hasFailed, dataReady, retry }
}
