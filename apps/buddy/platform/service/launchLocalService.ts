import type { ServiceLaunch } from '../../shared/service/localServiceProtocol'
import type { ReleaseFileSystem } from './releaseSet'
import { mkdir, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { serviceDiscoverySchema, serviceIdentitySchema, serviceLaunchSchema } from '../../shared/service/localServiceProtocol'
import { ensurePrivateDirectories } from '../filesystem/privateDirectories'
import { resolveBuddyPrivateDirectories, resolveBuddyProcessControl } from '../native/nativeHost'
import { storageBootstrapRoot } from '../storage/StorageLocationStore'
import { connectLocalService } from './connectLocalService'
import { readReleaseSet } from './releaseSet'
import { readPrivateServiceJson, writePrivateServiceJson } from './serviceFiles'
import { readServiceProcessIdentity, waitForServiceProcessExit } from './serviceProcessIdentity'
import { ServiceRpcChannel } from './ServiceRpcChannel'
import { readServiceSession, SessionServiceRegistration } from './SessionServiceRegistration'

export interface LocalServiceLaunchOptions {
  releaseSetPath: string
  releaseFileSystem?: ReleaseFileSystem
  profileRoot: string
  defaultRoot?: string
  profile: ServiceLaunch['profile']
  hostExecutable: string
  hostArguments: string[]
  leaseDirectory: string
  storageAuthority: ServiceLaunch['storageAuthority']
  startIfMissing?: boolean
}

export async function launchLocalService(options: LocalServiceLaunchOptions) {
  const release = await readReleaseSet(options.releaseSetPath, options.releaseFileSystem)
  const resourcesRoot = join(dirname(release.coreEntry), 'resources')
  const native = { appPath: resourcesRoot, resourcesPath: resourcesRoot, isPackaged: true }
  const launcher = resolveBuddyProcessControl(native)
  if (!launcher)
    throw new Error('SERVICE_LAUNCHER_UNAVAILABLE')
  const privateDirectoriesExecutable = resolveBuddyPrivateDirectories(native)
  await ensurePrivateDirectories([options.profileRoot], privateDirectoriesExecutable)
  const root = await realpath(options.profileRoot)
  const directory = join(root, '.runtime')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await ensurePrivateDirectories([directory], privateDirectoriesExecutable)
  const session = await readServiceSession()
  const config = serviceLaunchSchema.parse({
    version: 1,
    profileRoot: root,
    defaultRoot: await realpath(options.defaultRoot ?? root),
    profile: options.profile,
    ...session,
    resourcesRoot,
    nodeExecutable: release.nodeExecutable,
    coreEntry: release.coreEntry,
    releaseSetPath: await realpath(options.releaseSetPath),
    buildId: release.manifest.buildId,
    hostExecutable: await realpath(options.hostExecutable),
    hostArguments: options.hostArguments,
    storageAuthority: options.storageAuthority,
    leaseDirectory: options.leaseDirectory,
    privateDirectoriesExecutable,
  })
  const existing = await findLiveService(directory, config, launcher)
  if (existing || options.startIfMissing === false)
    return existing
  const launchDirectory = join(storageBootstrapRoot(config.defaultRoot!), 'service')
  await ensurePrivateDirectories([launchDirectory], privateDirectoriesExecutable)
  const path = join(launchDirectory, 'launch.json')
  await writePrivateServiceJson(path, config)
  await new SessionServiceRegistration(config, path, launcher).start()
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const connected = await findLiveService(directory, config, launcher)
    if (connected)
      return connected
    await delay(250)
  }
  throw new Error('SERVICE_START_TIMEOUT')
}

async function findLiveService(directory: string, config: ServiceLaunch, helper: string) {
  const discovery = await readPrivateServiceJson(join(directory, 'service.json')).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error))
  if (!discovery)
    return null
  const current = serviceDiscoverySchema.parse(discovery)
  const actual = await readServiceProcessIdentity(current.process.pid, helper).catch(error => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '') || (error as Error).message === 'SERVICE_PROCESS_CHANGED' ? null : Promise.reject(error))
  if (!actual || actual.startIdentity !== current.process.startIdentity || actual.executable !== current.process.executable)
    return null
  if (current.buildId !== config.buildId || current.sessionId !== config.sessionId || current.userId !== config.userId)
    throw new Error('SERVICE_RUNNING_DIFFERENT_RELEASE_OR_SESSION')
  if (current.phase === 'failed' || current.phase === 'stopping')
    throw new Error('SERVICE_REQUIRES_RECOVERY')
  if (current.phase !== 'ready')
    return null
  const credentials = z.object({ version: z.literal(1), serviceInstanceId: z.literal(current.serviceInstanceId), managementSecret: z.string().regex(/^[a-f0-9]{64}$/), productSecret: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await readPrivateServiceJson(join(directory, 'local-client.json')))
  const identity = serviceIdentitySchema.strip().parse(current)
  const connection = await connectLocalService(current.managementEndpoint, { ...identity, type: 'hello', role: 'management', secret: credentials.managementSecret })
  return { discovery: current, peer: new ServiceRpcChannel(connection.frames), waitForExit: () => waitForServiceProcessExit(current.process, helper) }
}
