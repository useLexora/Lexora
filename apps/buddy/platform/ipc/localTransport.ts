import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, isAbsolute } from 'node:path'
import process from 'node:process'
import { isLocalNamedPipe } from '../../shared/platform/localEndpoint'

export interface LocalEndpoint {
  address: string
  prepare: () => Promise<void>
  secure: () => Promise<void>
  dispose: () => Promise<void>
}

export const localTransports = {
  unix: createUnixEndpoint,
  namedPipe: createNamedPipeEndpoint,
}

interface LocalEndpointOptions {
  ownsProfileLease?: () => boolean
}

function createNamedPipeEndpoint(address: string, _options?: LocalEndpointOptions): LocalEndpoint {
  if (!isLocalNamedPipe(address))
    throw new Error('Expected a local named pipe endpoint')
  return { address, prepare: async () => {}, secure: async () => {}, dispose: async () => {} }
}

function createUnixEndpoint(address: string, options: LocalEndpointOptions = {}): LocalEndpoint {
  let owned: { dev: number, ino: number } | undefined
  if (!isAbsolute(address))
    throw new Error('Expected an absolute Unix socket endpoint')
  return {
    address,
    async prepare() {
      const parent = dirname(address)
      await mkdir(parent, { mode: 0o700, recursive: true })
      const directory = await lstat(parent)
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)
        throw new Error('Local socket parent must be a private directory owned by the current user')
      const metadata = await socketMetadata(address)
      if (!metadata)
        return
      if (!metadata.isSocket())
        throw new Error('Local socket path is occupied by a non-socket file')
      if (!options.ownsProfileLease?.() || metadata.uid !== process.getuid?.() || await socketAcceptsConnections(address))
        throw new Error('Local socket endpoint is already owned')
      const current = await socketMetadata(address)
      if (current?.dev !== metadata.dev || current.ino !== metadata.ino)
        throw new Error('Local socket endpoint changed')
      await unlink(address)
    },
    async secure() {
      const metadata = await socketMetadata(address)
      if (!metadata?.isSocket() || metadata.uid !== process.getuid?.())
        throw new Error('Local socket endpoint is not owned')
      owned = { dev: metadata.dev, ino: metadata.ino }
      await chmod(address, 0o600)
    },
    async dispose() {
      const metadata = await socketMetadata(address)
      if (owned && metadata?.isSocket() && metadata.dev === owned.dev && metadata.ino === owned.ino)
        await unlink(address)
      owned = undefined
    },
  }
}

async function socketMetadata(address: string) {
  try {
    return await lstat(address)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return null
    throw error
  }
}

async function socketAcceptsConnections(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(address)
    let timeout: ReturnType<typeof setTimeout>
    const finish = (active: boolean) => {
      clearTimeout(timeout)
      socket.destroy()
      resolve(active)
    }
    timeout = setTimeout(finish, 500, true)
    socket.once('connect', () => finish(true))
    socket.once('error', error => finish((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED'))
  })
}
