import type { ServiceDiscovery, ServiceLaunch } from '../../shared/service/localServiceProtocol'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { serviceDiscoverySchema } from '../../shared/service/localServiceProtocol'
import { ensurePrivateDirectories } from '../filesystem/privateDirectories'
import { readOrCreateProductIdentity } from '../storage/productIdentity'
import { acquireStorageRootLease } from '../storage/StorageRootLease'
import { writePrivateServiceJson } from './serviceFiles'
import { readServiceProcessIdentity } from './serviceProcessIdentity'

export class ServiceProfileOwner {
  readonly discovery: ServiceDiscovery
  readonly managementSecret = randomBytes(32).toString('hex')
  readonly productSecret = randomBytes(32).toString('hex')
  readonly #release: () => void
  readonly #discoveryPath: string
  readonly #credentialsPath: string
  #disposed = false

  private constructor(discovery: ServiceDiscovery, directory: string, release: () => void) {
    this.discovery = discovery
    this.#discoveryPath = join(directory, 'service.json')
    this.#credentialsPath = join(directory, 'local-client.json')
    this.#release = release
  }

  static async acquire(config: ServiceLaunch, processControl?: string): Promise<ServiceProfileOwner> {
    await ensurePrivateDirectories([config.profileRoot], config.privateDirectoriesExecutable)
    const root = await realpath(config.profileRoot)
    const release = acquireStorageRootLease(root, config.leaseDirectory ?? join(homedir(), '.lexora-locations', 'locks'), config.privateDirectoriesExecutable)
    try {
      const directory = join(root, '.runtime')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const metadata = await lstat(directory)
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || (process.platform !== 'win32' && (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0)))
        throw new Error('SERVICE_PRIVATE_DIRECTORY_INVALID')
      await ensurePrivateDirectories([directory], config.privateDirectoriesExecutable)
      const sockets = process.platform === 'win32' ? directory : join('/tmp', `lexora-services-${process.getuid?.()}`, createHash('sha256').update(root).digest('hex').slice(0, 24))
      if (process.platform !== 'win32') {
        await ensurePrivateDirectories([dirname(sockets), sockets], config.privateDirectoriesExecutable)
        for (const path of [dirname(sockets), sockets]) {
          const metadata = await lstat(path)
          if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0)
            throw new Error('SERVICE_PRIVATE_DIRECTORY_INVALID')
        }
      }
      const product = await readOrCreateProductIdentity(root)
      const serviceInstanceId = randomUUID()
      const address = (role: string) => process.platform === 'win32'
        ? `\\\\.\\pipe\\lexora-${serviceInstanceId}-${role}`
        : join(sockets, `${serviceInstanceId.slice(0, 8)}-${role}.sock`)
      const owner = new ServiceProfileOwner(serviceDiscoverySchema.parse({
        protocol: 1,
        profileId: product.profileId,
        serviceInstanceId,
        buildId: config.buildId,
        sessionId: config.sessionId,
        userId: config.userId,
        process: await readServiceProcessIdentity(process.pid, processControl),
        managementEndpoint: address('management'),
        productEndpoint: address('product'),
        phase: 'starting',
      }), directory, release)
      await owner.publish('starting')
      await writePrivateServiceJson(owner.#credentialsPath, { version: 1, serviceInstanceId, managementSecret: owner.managementSecret, productSecret: owner.productSecret })
      return owner
    }
    catch (error) {
      release()
      throw error
    }
  }

  async publish(phase: ServiceDiscovery['phase']): Promise<void> {
    if (this.#disposed)
      throw new Error('SERVICE_OWNER_STOPPED')
    this.discovery.phase = phase
    await writePrivateServiceJson(this.#discoveryPath, this.discovery)
  }

  async dispose(): Promise<void> {
    if (this.#disposed)
      return
    this.#disposed = true
    try {
      for (const path of [this.#discoveryPath, this.#credentialsPath]) {
        const current = await readFile(path, 'utf8').catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error))
        if (current !== null && JSON.parse(current).serviceInstanceId === this.discovery.serviceInstanceId)
          await unlink(path)
      }
    }
    finally { this.#release() }
  }
}
