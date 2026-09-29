import type { BuddyServiceFailureCode } from '../../shared/runtime/runtimeProtocol'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { establishWindowsRuntimeGuard } from '../../platform/windows/runtimeGuard'
import { APPLICATION_DIAGNOSTIC_METHOD, readDiagnosticErrorCode } from '../../shared/diagnostics/applicationDiagnostic'
import { ServiceHost } from '../../shared/lifecycle/ServiceHost'
import { SERVICE_LIFECYCLE_METHOD } from '../../shared/lifecycle/serviceLifecycle'
import { ServiceLifecycleSource } from '../../shared/lifecycle/ServiceLifecycleSource'
import { ApplicationEvents } from '../../shared/observability/ApplicationEvents'
import { observeLifecycleDiagnostics } from '../../shared/observability/lifecycleDiagnostics'
import { OPERATING_SYSTEM } from '../../shared/platform/identifiers'
import { toPublicRunEvent } from '../../shared/runs/publicRunEvent'
import { runNotifications } from '../../shared/runs/runApi'
import { buddyServiceFailureCodeSchema } from '../../shared/runtime/runtimeProtocol'
import { startBuddyService } from './BuddyService'
import { DiagnosticForwarder } from './diagnostics/DiagnosticForwarder'
import { createRunEventLog } from './events/createRunEventLog'
import { RunEventLogFatalError } from './events/RunEventFailure'
import { startRuntimeNetwork } from './network/runtimeNetwork'
import {
  createBuddyService,
  notifyBuddyServiceFailure,
  notifyBuddyServiceReady,
} from './rpc/BuddyServiceRpcServer'
import { openBuddyDatabase, resolveBuddyDatabasePath } from './storage/database'

const parentPort = process.parentPort

if (!parentPort) {
  process.stderr.write('Buddy Local Service requires an Electron utility process parent\n')
  process.exitCode = 1
}
else {
  process.once('SIGINT', () => {})

  void runBuddyService().catch((error: unknown) => {
    const failureCode = readBuddyServiceFailureCode(error)
    process.stderr.write(
      `Buddy Local Service failed to start: ${failureCode} (${readErrorName(error)})\n`,
    )
    process.exit(1)
  })
}

async function runBuddyService(): Promise<void> {
  if (!parentPort)
    return

  const buddyHome = z.string().refine(isAbsolute).parse(process.env.LEXORA_BUDDY_HOME)
  let database: ReturnType<typeof openBuddyDatabase> | null = null
  let serviceServer: ReturnType<typeof createBuddyService> | null = null
  const events = new ApplicationEvents()
  const diagnostics = new DiagnosticForwarder(event => serviceServer?.notify(APPLICATION_DIAGNOSTIC_METHOD, event))
  events.subscribe(event => diagnostics.record(event))
  const record = events.publish
  const lifecycle = new ServiceLifecycleSource(() => record({ event: 'observer.failed', component: 'runtime.lifecycle', level: 'warn' }))
  const host = new ServiceHost(lifecycle)
  const stopLifecycleDiagnostics = observeLifecycleDiagnostics(host.lifecycle, events)
  const lifecycleDelivery = host.lifecycle.onDidChange(change => serviceServer?.notify(SERVICE_LIFECYCLE_METHOD, change))
  let serviceFailureNotified = false
  let isDatabaseClosed = false
  const closeDatabase = () => {
    if (isDatabaseClosed || !database)
      return
    isDatabaseClosed = true
    database.close()
  }
  let serviceHandle: Awaited<ReturnType<typeof startBuddyService>> | null = null
  let eventLog: ReturnType<typeof createRunEventLog> | null = null
  let isShuttingDown = false
  const notifyFailure = (code: BuddyServiceFailureCode) => {
    if (!serviceServer || serviceFailureNotified)
      return
    serviceFailureNotified = true
    try {
      notifyBuddyServiceFailure(serviceServer, code)
    }
    catch {}
  }
  const shutdown = async (exitCode: number) => {
    if (isShuttingDown)
      return
    isShuttingDown = true
    record({ event: 'service.stopping', level: 'info', component: 'local_service' })
    let failed = false
    try {
      await host.stop()
    }
    catch {
      failed = true
    }
    record({ event: failed ? 'service.stop_failed' : 'service.stopped', level: failed ? 'error' : 'info', component: 'runtime.service' })
    lifecycleDelivery.dispose()
    stopLifecycleDiagnostics()
    diagnostics.dispose()
    serviceServer?.close(new Error('Buddy Local Service is shutting down'))
    process.exit(failed ? 1 : exitCode)
  }
  serviceServer = createBuddyService({
    recordDiagnostic: record,
    announceReady: false,
    port: parentPort,
    scheduleShutdown() {
      void shutdown(0)
    },
    onFatalError(error) {
      process.stderr.write(`Buddy Local Service protocol failure: ${error.name}\n`)
      void shutdown(1)
    },
  })
  process.once('exit', closeDatabase)
  try {
    const builtinSkillsDirectories = await host.step('runtime.guard', async () => {
      if (process.platform === OPERATING_SYSTEM.Windows)
        await establishWindowsRuntimeGuard()
      return z.array(z.string().min(1)).parse(JSON.parse(process.env.LEXORA_BUDDY_SKILLS_DIRS ?? '[]'))
    })
    await host.start('runtime.network', ({ defer }) => {
      defer(startRuntimeNetwork())
    })
    const openedDatabase = await host.start('runtime.database', ({ defer }) => {
      database = openBuddyDatabase({ databasePath: resolveBuddyDatabasePath(buddyHome) })
      defer(closeDatabase)
      return database
    })
    eventLog = await host.start('runtime.event_log', ({ defer }) => {
      const log = createRunEventLog({
        conversationsDirectory: join(buddyHome, 'conversations'),
        database: openedDatabase,
        onObserverError: error => record({ event: 'run.observer_failed', level: 'warn', errorCode: readDiagnosticErrorCode(error) }),
        onFatalFailure: (error) => {
          record({ event: 'run.storage_failed', level: 'error', runId: error.runId, errorCode: error.code })
          notifyFailure(readBuddyServiceFailureCode(error))
          const operation = 'operation' in error ? ` ${error.operation}` : ''
          const stage = 'stage' in error ? ` ${error.stage}` : ''
          const range = error.firstSequence === null || error.lastSequence === null
            ? error.runId
            : `${error.runId}#${error.firstSequence}-${error.lastSequence}`
          process.stderr.write(
            `Lexora Buddy event log fatal failure: ${error.code} ${error.commitState}${operation}${stage} ${range}\n`,
          )
          void shutdown(1)
        },
      })
      const delivery = log.onDidCommit((event) => {
        try {
          serviceServer?.notify(runNotifications.event.method, toPublicRunEvent(event))
        }
        catch (error) {
          record({ event: 'run.notification_failed', level: 'warn', runId: event.runId, errorCode: readDiagnosticErrorCode(error) })
        }
      })
      defer(async () => {
        await log.close()
        delivery.dispose()
      })
      return log
    }, ['runtime.database'])
    await host.step('runtime.event_replay', () => eventLog!.replayAll())
    await host.start('runtime.services', async ({ defer }) => {
      serviceHandle = await startBuddyService({
        buddyHome,
        builtinSkillsDirectories,
        database: openedDatabase,
        eventLog: eventLog!,
        rpc: serviceServer,
        events,
        lifecycle,
      })
      defer(() => serviceHandle!.dispose())
    })
    notifyBuddyServiceReady(serviceServer)
  }
  catch (error) {
    notifyFailure(readBuddyServiceFailureCode(error))
    await host.stop().catch(() => {})
    lifecycleDelivery.dispose()
    stopLifecycleDiagnostics()
    diagnostics.dispose()
    serviceServer.close(new Error('Buddy Local Service startup failed'))
    closeDatabase()
    throw error
  }
}

function readBuddyServiceFailureCode(error: unknown): BuddyServiceFailureCode {
  if (error instanceof RunEventLogFatalError) {
    const parsed = buddyServiceFailureCodeSchema.safeParse(error.code)
    if (parsed.success)
      return parsed.data
  }
  return 'RUNTIME_START_FAILED'
}

function readErrorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'unknown error'
}
