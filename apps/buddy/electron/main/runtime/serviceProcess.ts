import { isAbsolute } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { establishWindowsRuntimeGuard } from '../../../platform/windows/runtimeGuard'
import { readRuntimeProxy } from '../../../service/src/network/runtimeNetwork'
import { createRpcRuntimePlatform } from '../../../service/src/platform/createRpcRuntimePlatform'
import { prepareRuntimeEnvironment } from '../../../service/src/platform/prepareRuntimeEnvironment'
import { createBuddyService, notifyBuddyServiceFailure, notifyBuddyServiceReady } from '../../../service/src/rpc/BuddyServiceRpcServer'
import { readBuddyServiceFailureCode, startServiceRuntime } from '../../../service/src/startServiceRuntime'
import { ApplicationEvents } from '../../../shared/observability/ApplicationEvents'

const port = process.parentPort
if (!port) {
  process.stderr.write('Buddy Local Service requires an Electron utility process parent\n')
  process.exitCode = 1
}
else {
  process.once('SIGINT', () => {})
  const events = new ApplicationEvents()
  let service: Awaited<ReturnType<typeof startServiceRuntime>> | undefined
  const peer = createBuddyService({ recordDiagnostic: events.publish, port, announceReady: false, prepareIdleShutdown: () => service?.prepareIdleShutdown() ?? false, scheduleShutdown: () => {
    void shutdown(0)
  }, onFatalError: () => {
    void shutdown(1)
  } })
  let stopping: Promise<void> | undefined
  const started = start()
  void started.catch((error: unknown) => {
    notifyBuddyServiceFailure(peer, readBuddyServiceFailureCode(error))
    process.stderr.write(`Buddy Local Service failed to start: ${readBuddyServiceFailureCode(error)}\n`)
    void shutdown(1)
  })

  async function start() {
    const buddyHome = z.string().refine(isAbsolute).parse(process.env.LEXORA_BUDDY_HOME)
    const builtinSkillsDirectories = z.array(z.string().refine(isAbsolute)).parse(JSON.parse(process.env.LEXORA_BUDDY_SKILLS_DIRS ?? '[]'))
    if (process.platform === 'win32')
      await establishWindowsRuntimeGuard()
    await prepareRuntimeEnvironment()
    const runtime = await startServiceRuntime({
      events,
      buddyHome,
      builtinSkillsDirectories,
      proxy: readRuntimeProxy(process.env),
      forceEventRecovery: process.env.LEXORA_BUDDY_EVENT_RECOVERY === 'full',
      storageAuthority: z.enum(['legacy_jsonl', 'sqlite']).optional().parse(process.env.LEXORA_BUDDY_STORAGE_AUTHORITY),
      platform: createRpcRuntimePlatform(peer),
      notify: (method, params) => peer.notify(method, params),
      onFatalFailure(error) {
        notifyBuddyServiceFailure(peer, readBuddyServiceFailureCode(error))
        void shutdown(1)
      },
    })
    try {
      service = runtime
      runtime.connectClient('product', peer)
      runtime.connectClient('management', peer)
      notifyBuddyServiceReady(peer)
      runtime.startMaintenance()
      return runtime
    }
    catch (error) {
      await runtime.dispose()
      throw error
    }
  }

  function shutdown(code: number): Promise<void> {
    return stopping ??= (async () => {
      const runtime = await started.catch(() => null)
      try {
        await runtime?.dispose()
      }
      catch {
        code = 1
      }
      peer.close(new Error('Buddy Local Service is shutting down'))
      process.exit(code)
    })()
  }
}
