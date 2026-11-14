import type { ServiceLaunch } from '../../shared/service/localServiceProtocol'
import { realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { readReleaseSet } from '../../platform/service/releaseSet'
import { readServiceSession } from '../../platform/service/SessionServiceRegistration'

export async function validateServiceRelease(config: ServiceLaunch): Promise<void> {
  const session = await readServiceSession()
  if (session.sessionId !== config.sessionId || session.userId !== config.userId)
    throw new Error('SERVICE_SESSION_CHANGED')
  const release = await readReleaseSet(config.releaseSetPath)
  if (release.manifest.buildId !== config.buildId || await realpath(config.coreEntry) !== release.coreEntry || await realpath(config.nodeExecutable) !== release.nodeExecutable || await realpath(process.execPath) !== release.nodeExecutable || process.versions.node !== release.manifest.node.version || await realpath(config.resourcesRoot) !== await realpath(join(dirname(release.coreEntry), 'resources')))
    throw new Error('SERVICE_RELEASE_IDENTITY_CHANGED')
}
