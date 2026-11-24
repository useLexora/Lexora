import type { ApplicationDiagnostic } from '../../shared/diagnostics/applicationDiagnostic'
import type { ServiceLaunch } from '../../shared/service/localServiceProtocol'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { createBuddyNativeEnvironment, resolveBuddyProcessControl } from '../../platform/native/nativeHost'
import { ServiceChildProcess } from '../../platform/service/ServiceChildProcess'
import { readServiceLaunch, writePrivateServiceJson } from '../../platform/service/serviceFiles'
import { measureServiceStartupStep } from '../../platform/service/serviceStartupStep'
import { assertStorageIdentity, storageBootstrapRoot, StorageLocationStore } from '../../platform/storage/StorageLocationStore'
import { CancelledServiceStartup, startLocalServiceDaemon } from './LocalServiceDaemon'
import { validateServiceRelease } from './validateServiceRelease'

export function startLocalServiceSupervisor(path: string, initial: { config: ServiceLaunch, validation: ApplicationDiagnostic, parent: string }) {
  let active: Awaited<ReturnType<typeof startLocalServiceDaemon>> | undefined
  let transition: Promise<void> | undefined
  let maintenance: ServiceChildProcess | undefined
  const shutdown = new AbortController()
  let stopping = false
  async function boot(openDesktop: boolean, cold?: typeof initial) {
    const { launcherVerification, ...config } = cold?.config ?? await readServiceLaunch(path)
    const parentOperationId = cold?.parent ?? randomUUID()
    const validation = cold?.validation ?? (await measureServiceStartupStep('runtime.process_installation_gate', parentOperationId, () => validateServiceRelease(config), releaseCheck => ({ releaseCheck }))).record
    if (stopping)
      return
    const defaultRoot = config.defaultRoot ?? config.profileRoot
    const store = new StorageLocationStore(join(storageBootstrapRoot(defaultRoot), 'location.json'), defaultRoot)
    if ((await store.read()).pending)
      await migrate(config, defaultRoot)
    if (stopping)
      return
    const state = await store.read()
    if (state.pending)
      throw new Error('SERVICE_STORAGE_MAINTENANCE_PENDING')
    await assertStorageIdentity(state)
    const profileRoot = await realpath(state.activeRoot)
    const activeConfig = { ...config, profileRoot, defaultRoot }
    await writePrivateServiceJson(path, activeConfig)
    const startupSteps = [validation]
    if (cold && launcherVerification)
      startupSteps.unshift(launcherVerification)
    try {
      active = await startLocalServiceDaemon(activeConfig, { restartDesktop, foreground: openDesktop, startupSteps, parentOperationId, signal: shutdown.signal })
    }
    catch (error) {
      if (error instanceof CancelledServiceStartup)
        return
      throw error
    }
    if (stopping)
      await active.stop()
  }
  async function migrate(config: ServiceLaunch, defaultRoot: string) {
    const native = { serviceResourcesRoot: config.resourcesRoot }
    const environment = createBuddyNativeEnvironment(native)
    const child = new ServiceChildProcess({ executable: config.hostExecutable, args: [...config.hostArguments, '--lexora-storage-maintenance'], env: { ...process.env, ...environment, LEXORA_HOME: defaultRoot, LEXORA_BUDDY_PROFILE: config.profile, LEXORA_BUDDY_SERVICE_MODE: 'utility' }, processControl: resolveBuddyProcessControl(native), runtimeGuard: environment.LEXORA_BUDDY_RUNTIME_GUARD, output: (_stream, value) => process.stderr.write(value) })
    maintenance = child
    try {
      await child.ready({})
      const result = await child.exited
      await child.stopAndVerify()
      if (!stopping && result.code !== 0)
        throw new Error('SERVICE_STORAGE_MAINTENANCE_FAILED')
    }
    finally { maintenance = undefined }
  }
  function restartDesktop() {
    if (stopping || transition)
      return
    transition = (async () => {
      await active?.stop()
      active = undefined
      await boot(true)
    })().catch((error: unknown) => {
      const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SERVICE_RESTART_FAILED'
      process.stderr.write(`${code}\n`)
      if (!active && code !== 'SERVICE_STORAGE_MAINTENANCE_PENDING')
        process.exitCode = 1
    }).finally(() => { transition = undefined })
  }
  const ready = boot(false, initial)
  return {
    ready,
    async stop() {
      stopping = true
      shutdown.abort()
      await maintenance?.stopAndVerify()
      await Promise.allSettled([ready, transition])
      await active?.stop()
    },
  }
}
