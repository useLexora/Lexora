import type { ServiceLaunch } from '../../shared/service/localServiceProtocol'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { createBuddyNativeEnvironment, resolveBuddyProcessControl } from '../../platform/native/nativeHost'
import { ServiceChildProcess } from '../../platform/service/ServiceChildProcess'
import { readServiceLaunch, writePrivateServiceJson } from '../../platform/service/serviceFiles'
import { assertStorageIdentity, storageBootstrapRoot, StorageLocationStore } from '../../platform/storage/StorageLocationStore'
import { startLocalServiceDaemon } from './LocalServiceDaemon'
import { validateServiceRelease } from './validateServiceRelease'

export function startLocalServiceSupervisor(path: string) {
  let active: Awaited<ReturnType<typeof startLocalServiceDaemon>> | undefined
  let transition: Promise<void> | undefined
  let maintenance: ServiceChildProcess | undefined
  let stopping = false
  async function boot(openDesktop: boolean) {
    const config = await readServiceLaunch(path)
    await validateServiceRelease(config)
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
    await writePrivateServiceJson(path, { ...config, profileRoot, defaultRoot })
    active = await startLocalServiceDaemon(path, { restartDesktop })
    if (stopping)
      await active.stop()
    else if (openDesktop)
      await active.openDesktop()
  }
  async function migrate(config: ServiceLaunch, defaultRoot: string) {
    const native = { appPath: config.resourcesRoot, resourcesPath: config.resourcesRoot, isPackaged: true }
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
  const ready = boot(false)
  return {
    ready,
    async stop() {
      stopping = true
      await maintenance?.stopAndVerify()
      await Promise.allSettled([ready, transition])
      await active?.stop()
    },
  }
}
