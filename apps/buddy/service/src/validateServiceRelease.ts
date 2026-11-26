import type { ServiceLaunch } from '../../shared/service/localServiceProtocol'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { activateRuntimeRelease, assertCurrentCore, readRuntimeRelease } from '../../platform/service/releaseActivation'
import { verifyReleaseSet } from '../../platform/service/releaseSet'
import { readServiceLaunch } from '../../platform/service/serviceFiles'
import { measureServiceStartupStep } from '../../platform/service/serviceStartupStep'
import { readServiceSession } from '../../platform/service/SessionServiceRegistration'

async function currentRelease() {
  const directory = dirname(await realpath(process.argv[1]!))
  const root = basename(directory) === 'service' && basename(dirname(directory)) === 'build' ? dirname(dirname(directory)) : dirname(directory)
  const release = await readRuntimeRelease(join(root, 'release-set.json'))
  await assertCurrentCore(release)
  return release
}

export async function verifyInstalledRelease(options: { inventory?: boolean } = { inventory: false }) {
  const release = await currentRelease()
  await verifyReleaseSet(release, undefined, options)
  return release.manifest.buildId
}

export async function readValidatedServiceLaunch(path: string) {
  const config = await readServiceLaunch(path)
  const parent = config.launcherVerification?.parentOperationId ?? randomUUID()
  const { record: validation } = await measureServiceStartupStep('runtime.process_installation_gate', parent, () => validateServiceRelease(config), releaseCheck => ({ releaseCheck }))
  return { config, parent, validation }
}

export async function validateServiceRelease(config: ServiceLaunch) {
  const [session, release] = await Promise.all([readServiceSession(), currentRelease()])
  if (session.sessionId !== config.sessionId || session.userId !== config.userId)
    throw new Error('SERVICE_SESSION_CHANGED')
  if (config.releaseSetPath !== release.file || release.manifest.buildId !== config.buildId || config.coreEntry !== release.coreEntry || config.nodeExecutable !== release.nodeExecutable || config.resourcesRoot !== release.serviceResources || config.privateDirectoriesExecutable !== release.privateDirectoriesExecutable)
    throw new Error('SERVICE_RELEASE_IDENTITY_CHANGED')
  return activateRuntimeRelease(release, config.defaultRoot ?? config.profileRoot, session.userId)
}
