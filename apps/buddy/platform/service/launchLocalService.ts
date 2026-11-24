import type { ApplicationDiagnostic } from '../../shared/diagnostics/applicationDiagnostic'
import type { ServiceLaunch } from '../../shared/service/localServiceProtocol'
import type { ReleaseFileSystem } from './releaseSet'
import type { ServiceSession } from './SessionServiceRegistration'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { serviceDiscoverySchema, serviceIdentitySchema, serviceLaunchSchema } from '../../shared/service/localServiceProtocol'
import { ensurePrivateDirectories } from '../filesystem/privateDirectories'
import { resolveBuddyProcessControl } from '../native/nativeHost'
import { storageBootstrapRoot } from '../storage/StorageLocationStore'
import { connectLocalService } from './connectLocalService'
import { activateRuntimeRelease, readRuntimeRelease } from './releaseActivation'
import { assertReleaseGeneration } from './releaseSet'
import { readPrivateServiceJson, writePrivateServiceJson } from './serviceFiles'
import { readServiceProcessIdentity, waitForServiceProcessExit } from './serviceProcessIdentity'
import { ServiceRpcChannel } from './ServiceRpcChannel'
import { measureServiceStartupStep } from './serviceStartupStep'
import { readServiceSession, SessionServiceRegistration } from './SessionServiceRegistration'

export interface LocalServiceLaunchOptions {
  profileRoot: string
  defaultRoot?: string
  profile: ServiceLaunch['profile']
  hostExecutable: string
  hostArguments: string[]
  leaseDirectory: string
  storageAuthority: ServiceLaunch['storageAuthority']
  connectDuringStartup?: boolean
}

interface Installation { release: Awaited<ReturnType<typeof readRuntimeRelease>>, session: ServiceSession }

export async function prepareLocalServiceLauncher(releasePath: string, defaultRoot: string, intent: 'launch' | 'quit_for_install', fileSystem: ReleaseFileSystem) {
  const inspect = async (): Promise<Installation> => {
    const [release, session] = await Promise.all([readRuntimeRelease(releasePath, fileSystem), readServiceSession()])
    return { release, session }
  }
  if (intent === 'quit_for_install') {
    const installation = await inspect()
    return { connect: (options: LocalServiceLaunchOptions) => launchLocalService(options, installation, 'connect') }
  }
  const { value, record } = await measureServiceStartupStep('launcher.installation_gate', randomUUID(), async () => {
    const installation = await inspect()
    const releaseCheck = await activateRuntimeRelease(installation.release, defaultRoot, installation.session.userId, fileSystem)
    return { ...installation, releaseCheck }
  }, ({ releaseCheck }) => ({ releaseCheck }))
  return { buildId: value.release.manifest.buildId, connect: (options: LocalServiceLaunchOptions) => launchLocalService(options, value, 'connect'), start: (options: LocalServiceLaunchOptions) => launchLocalService(options, value, 'start', record) }
}

async function launchLocalService(options: LocalServiceLaunchOptions, { release, session }: Installation, action: 'connect' | 'start', launcherVerification?: ApplicationDiagnostic) {
  const { serviceResources: resourcesRoot, privateDirectoriesExecutable } = release
  await assertReleaseGeneration(release)
  const native = { serviceResourcesRoot: resourcesRoot }
  const launcher = resolveBuddyProcessControl(native)
  if (!launcher)
    throw new Error('SERVICE_LAUNCHER_UNAVAILABLE')
  await ensurePrivateDirectories([options.profileRoot], privateDirectoriesExecutable)
  const root = await realpath(options.profileRoot)
  const directory = join(root, '.runtime')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await ensurePrivateDirectories([directory], privateDirectoriesExecutable)
  const config = serviceLaunchSchema.parse({
    version: 1,
    profileRoot: root,
    defaultRoot: await realpath(options.defaultRoot ?? root),
    profile: options.profile,
    ...session,
    resourcesRoot,
    nodeExecutable: release.nodeExecutable,
    coreEntry: release.coreEntry,
    releaseSetPath: release.file,
    buildId: release.manifest.buildId,
    hostExecutable: await realpath(options.hostExecutable),
    hostArguments: options.hostArguments,
    storageAuthority: options.storageAuthority,
    leaseDirectory: options.leaseDirectory,
    privateDirectoriesExecutable,
  })
  const existing = await findLiveService(directory, config, launcher, options.connectDuringStartup)
  if (existing || action === 'connect')
    return existing
  const launchDirectory = join(storageBootstrapRoot(config.defaultRoot!), 'service')
  await ensurePrivateDirectories([launchDirectory], privateDirectoriesExecutable)
  const path = join(launchDirectory, 'launch.json')
  await writePrivateServiceJson(path, { ...config, launcherVerification })
  await new SessionServiceRegistration(config, path, launcher).start()
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const connected = await findLiveService(directory, config, launcher, options.connectDuringStartup)
    if (connected)
      return connected
    await delay(250)
  }
  throw new Error('SERVICE_START_TIMEOUT')
}

async function findLiveService(directory: string, config: ServiceLaunch, helper: string, connectDuringStartup = false) {
  const discovery = await readPrivateServiceJson(join(directory, 'service.json')).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error))
  if (!discovery)
    return null
  const current = serviceDiscoverySchema.parse(discovery)
  const actual = await readServiceProcessIdentity(current.process.pid, helper).catch(error => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '') || (error as Error).message === 'SERVICE_PROCESS_CHANGED' ? null : Promise.reject(error))
  if (!actual || actual.startIdentity !== current.process.startIdentity || actual.executable !== current.process.executable)
    return null
  if (current.buildId !== config.buildId || current.sessionId !== config.sessionId || current.userId !== config.userId || actual.executable !== config.nodeExecutable)
    throw new Error('SERVICE_RUNNING_DIFFERENT_RELEASE_OR_SESSION')
  if (current.phase === 'failed' || current.phase === 'stopping')
    throw new Error('SERVICE_REQUIRES_RECOVERY')
  if (current.phase !== 'ready' && !(connectDuringStartup && current.phase === 'starting'))
    return null
  const credentials = z.object({ version: z.literal(1), serviceInstanceId: z.literal(current.serviceInstanceId), managementSecret: z.string().regex(/^[a-f0-9]{64}$/), productSecret: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await readPrivateServiceJson(join(directory, 'local-client.json')))
  const identity = serviceIdentitySchema.strip().parse(current)
  const connection = await connectLocalService(current.managementEndpoint, { ...identity, type: 'hello', role: 'management', secret: credentials.managementSecret })
  return { discovery: current, peer: new ServiceRpcChannel(connection.frames), waitForExit: () => waitForServiceProcessExit(current.process, helper) }
}
