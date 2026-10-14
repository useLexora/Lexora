import type { CancellationToken } from 'electron-updater'
import type { ProxyAuthenticator } from '../network/requestThroughHost'
import type { DesktopUpdatePackage } from './DesktopUpdatePackage'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { autoUpdater } from 'electron'

export class MacUpdateInstaller {
  #updater: import('electron-updater').MacUpdater | null = null
  readonly #authenticateProxy: ProxyAuthenticator

  constructor(authenticateProxy: ProxyAuthenticator) {
    this.#authenticateProxy = authenticateProxy
  }

  async prepare(path: string, update: DesktopUpdatePackage, directory: string): Promise<() => void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('UPDATE_INSTALL_TIMEOUT')), 5 * 60_000)
    try {
      return await this.#prepare(path, update, directory, controller.signal)
    }
    finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }

  async #prepare(path: string, update: DesktopUpdatePackage, directory: string, signal: AbortSignal): Promise<() => void> {
    const hash = createHash('sha512')
    for await (const chunk of createReadStream(path, { signal }))
      hash.update(chunk)
    const token = randomUUID()
    const metadata = JSON.stringify({ version: update.version, files: [{ url: update.name, sha512: hash.digest('base64'), size: update.size }], releaseDate: new Date().toISOString() })
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      if (pathname === `/${token}/latest-mac.yml`) {
        response.setHeader('Content-Type', 'application/yaml')
        response.end(metadata)
      }
      else if (pathname === `/${token}/${update.name}`) {
        response.setHeader('Content-Length', update.size)
        const stream = createReadStream(path)
        stream.on('error', () => response.destroy())
        response.on('close', () => stream.destroy())
        stream.pipe(response)
      }
      else {
        response.writeHead(404).end()
      }
    })
    let cancellationToken: CancellationToken | undefined
    try {
      await waitFor(new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen({ port: 0, host: '127.0.0.1', signal }, () => {
          server.removeListener('error', reject)
          resolve()
        })
      }), signal)
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('UPDATE_INSTALL_UNAVAILABLE')
      if (!this.#updater) {
        const { default: library } = await waitFor(import('electron-updater'), signal)
        signal.throwIfAborted()
        const updater = new library.MacUpdater()
        updater.on('login', (authInfo, callback) => {
          if (!this.#authenticateProxy(authInfo, (username, password) => callback(username ?? '', password ?? '')))
            callback('', '')
        })
        updater.autoDownload = false
        updater.autoInstallOnAppQuit = false
        updater.disableDifferentialDownload = true
        updater.logger = null
        const config = join(directory, 'native-updater.yml')
        await writeFile(config, JSON.stringify({ updaterCacheDirName: relative(join(homedir(), 'Library', 'Caches'), join(directory, 'native')) }), { mode: 0o600, signal })
        updater.updateConfigPath = config
        this.#updater = updater
      }
      const updater = this.#updater
      updater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${address.port}/${token}/`, useMultipleRangeRequest: false })
      signal.throwIfAborted()
      const result = await waitFor(updater.checkForUpdates(), signal)
      if (result?.updateInfo.version !== update.version)
        throw new Error('UPDATE_INSTALL_UNAVAILABLE')
      signal.throwIfAborted()
      cancellationToken = result.cancellationToken
      await waitFor(updater.downloadUpdate(cancellationToken), signal)
      signal.throwIfAborted()
      await Promise.all([
        once(autoUpdater, 'update-downloaded', { signal }),
        Promise.resolve().then(() => {
          signal.throwIfAborted()
          autoUpdater.checkForUpdates()
        }),
      ])
      signal.throwIfAborted()
      return () => updater.quitAndInstall()
    }
    catch (error) {
      cancellationToken?.cancel()
      await this.#updater?.netSession.closeAllConnections().catch(() => {})
      throw signal.aborted ? signal.reason : error
    }
    finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}

async function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>()
  const abort = () => reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted)
    abort()
  try {
    return await Promise.race([pending, promise])
  }
  finally {
    signal.removeEventListener('abort', abort)
  }
}
