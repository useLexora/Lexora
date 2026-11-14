import type { BuddyServiceFailureCode } from '../../shared/runtime/runtimeProtocol'
import type { RunEventLogPort } from './events/RunEventPorts'
import type { RuntimeProxy } from './network/runtimeNetwork'
import type { RuntimePlatform } from './platform/RuntimePlatform'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { readOrCreateProductIdentity } from '../../platform/storage/productIdentity'
import { APPLICATION_DIAGNOSTIC_METHOD, readDiagnosticErrorCode } from '../../shared/diagnostics/applicationDiagnostic'
import { ServiceHost } from '../../shared/lifecycle/ServiceHost'
import { SERVICE_LIFECYCLE_METHOD } from '../../shared/lifecycle/serviceLifecycle'
import { ServiceLifecycleSource } from '../../shared/lifecycle/ServiceLifecycleSource'
import { ApplicationEvents } from '../../shared/observability/ApplicationEvents'
import { observeLifecycleDiagnostics } from '../../shared/observability/lifecycleDiagnostics'
import { buddyServiceFailureCodeSchema } from '../../shared/runtime/runtimeProtocol'
import { startBuddyService } from './BuddyService'
import { DiagnosticForwarder } from './diagnostics/DiagnosticForwarder'
import { createRunEventLog } from './events/createRunEventLog'
import { RunEventLogFatalError } from './events/RunEventFailure'
import { SqliteRunEventLog } from './events/SqliteRunEventLog'
import { RuntimeNetwork } from './network/runtimeNetwork'
import { openBuddyDatabase, openBuddySqliteDatabase, resolveBuddyDatabasePath } from './storage/database'
import { guardStorageDatabase, StorageIsolatedError } from './storage/StorageIsolation'

export interface ServiceRuntimeOptions {
  events?: ApplicationEvents
  buddyHome: string
  serviceInstanceId?: string
  builtinSkillsDirectories: readonly string[]
  proxy: RuntimeProxy
  forceEventRecovery?: boolean
  storageAuthority?: 'legacy_jsonl' | 'sqlite'
  platform: RuntimePlatform
  notify: (method: string, params: unknown) => void
  onFatalFailure: (error: unknown) => void
}

export async function startServiceRuntime(options: ServiceRuntimeOptions) {
  const { buddyHome } = options
  const serviceInstanceId = options.serviceInstanceId ?? randomUUID()
  const network = new RuntimeNetwork()
  let database: ReturnType<typeof openBuddyDatabase> | null = null
  const events = options.events ?? new ApplicationEvents()
  const diagnostics = new DiagnosticForwarder(event => options.notify(APPLICATION_DIAGNOSTIC_METHOD, event))
  events.subscribe(event => diagnostics.record(event))
  const record = events.publish
  const lifecycle = new ServiceLifecycleSource(() => record({ event: 'observer.failed', component: 'runtime.lifecycle', level: 'warn' }))
  const host = new ServiceHost(lifecycle)
  const stopLifecycleDiagnostics = observeLifecycleDiagnostics(host.lifecycle, events)
  const lifecycleDelivery = host.lifecycle.onDidChange(change => options.notify(SERVICE_LIFECYCLE_METHOD, change))
  let isDatabaseClosed = false
  const closeDatabase = () => {
    if (isDatabaseClosed || !database)
      return
    isDatabaseClosed = true
    database.close()
  }
  let serviceHandle: Awaited<ReturnType<typeof startBuddyService>> | null = null
  let eventLog: RunEventLogPort | null = null
  let stopping: Promise<void> | undefined
  const dispose = () => stopping ??= (async () => {
    record({ event: 'service.stopping', level: 'info', component: 'local_service' })
    try {
      await host.stop()
      record({ event: 'service.stopped', level: 'info', component: 'runtime.service' })
    }
    catch (error) {
      record({ event: 'service.stop_failed', level: 'error', component: 'runtime.service' })
      throw error
    }
    finally {
      lifecycleDelivery.dispose()
      stopLifecycleDiagnostics()
      diagnostics.dispose()
      closeDatabase()
    }
  })()
  try {
    await host.start('runtime.network', async ({ defer }) => {
      defer(() => network.dispose())
      await network.replace(options.proxy)
    })
    const openedDatabase = await host.start('runtime.database', ({ defer }) => {
      database = (options.storageAuthority === 'sqlite' ? openBuddySqliteDatabase : openBuddyDatabase)({ databasePath: resolveBuddyDatabasePath(buddyHome) })
      defer(closeDatabase)
      const isolation = guardStorageDatabase(database)
      const subscription = isolation.onDidIsolate(error => options.onFatalFailure(error))
      defer(() => subscription.dispose())
      return database
    })
    eventLog = await host.start('runtime.event_log', ({ defer }) => {
      if (options.storageAuthority === 'sqlite') {
        const log = new SqliteRunEventLog({ database: openedDatabase, onFatalFailure: options.onFatalFailure, onObserverError: () => record({ event: 'run.observer_failed', level: 'warn' }) })
        defer(() => log.close())
        return log
      }
      const log = createRunEventLog({
        conversationsDirectory: join(buddyHome, 'conversations'),
        database: openedDatabase,
        onObserverError: error => record({ event: 'run.observer_failed', level: 'warn', errorCode: readDiagnosticErrorCode(error) }),
        onMaintenance: (summary) => {
          if (!summary.checked && !summary.failed)
            return
          record({ event: 'run.maintenance.checked', level: 'info', durationMs: summary.durationMs, count: summary.checked })
          record({ event: 'run.maintenance.removed', level: 'info', count: summary.removed })
          if (summary.failed)
            record({ event: 'run.maintenance.failed', level: 'warn', count: summary.failed })
        },
        onRecovery: (summary) => {
          record({ event: 'run.recovery.enumerated', level: 'info', durationMs: summary.enumerationMs, count: summary.scanned })
          record({ event: 'run.recovery.inspected', level: 'info', durationMs: summary.inspectionMs, count: summary.scanned })
          record({ event: 'run.recovery.read', level: 'info', durationMs: summary.readMs, count: summary.events })
          record({ event: 'run.recovery.projected', level: 'info', durationMs: summary.projectionMs, count: summary.rebuilt })
          record({ event: 'run.recovery.skipped', level: 'info', count: summary.skipped })
          record({ event: 'run.recovery.finished', level: summary.failed ? 'error' : 'info', durationMs: summary.durationMs, count: summary.failed })
        },
        onRunQuarantined: failure => record({ event: 'run.recovery.quarantined', level: 'error', runId: failure.runId, ...(failure.conversationId ? { conversationId: failure.conversationId } : {}), errorCode: failure.code }),
        onFatalFailure: (error) => {
          record({ event: 'run.storage_failed', level: 'error', runId: error.runId, errorCode: error.code })
          options.onFatalFailure(error)
        },
      })
      defer(() => log.close())
      return log
    }, ['runtime.database'])
    await host.step('runtime.event_replay', ({ reportProgress }) => eventLog!.recoverAll({
      force: options.forceEventRecovery,
      onProgress: reportProgress,
    }))
    await host.start('runtime.services', async ({ defer }) => {
      serviceHandle = await startBuddyService({
        buddyHome,
        serviceInstanceId,
        ...(options.storageAuthority === 'sqlite' ? { productIdentity: await readOrCreateProductIdentity(dirname(buddyHome)) } : {}),
        builtinSkillsDirectories: options.builtinSkillsDirectories,
        database: openedDatabase,
        eventLog: eventLog!,
        platform: options.platform,
        events,
        lifecycle,
      })
      defer(() => serviceHandle!.dispose())
    })
    return {
      ...serviceHandle!,
      async suspendPlatform(reason?: string) {
        const cleanup = serviceHandle!.suspendPlatform(reason)
        await Promise.all([network.invalidate(), cleanup])
      },
      async resumePlatform(proxy: RuntimeProxy) {
        await network.replace(proxy)
        await serviceHandle!.resumePlatform()
      },
      dispose,
    }
  }
  catch (error) {
    await dispose().catch(() => {})
    throw error
  }
}

export function readBuddyServiceFailureCode(error: unknown): BuddyServiceFailureCode {
  if (error instanceof StorageIsolatedError)
    return 'EVENT_STORAGE_FAILED'
  if (error instanceof RunEventLogFatalError) {
    const parsed = buddyServiceFailureCodeSchema.safeParse(error.code)
    if (parsed.success)
      return parsed.data
  }
  return 'RUNTIME_START_FAILED'
}
