import type { DownloadSettings } from '../../../shared/network/downloadSettings'
import type { DesktopDistribution, DesktopPackageFormat } from '../../shared/desktopDistribution'
import type { GithubRelease } from '../desktopUpdateService'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { downloadBytes, DownloadRouteError } from '../../../platform/network/downloadBytes'
import { downloadRoutes } from '../../../shared/network/downloadMirrors'
import { desktopUpdateArtifactName } from '../../shared/desktopDistribution'
import { desktopVersionSchema, isDesktopBetaVersion } from '../../shared/desktopUpdates'
import { isLexoraReleaseUrl } from '../../shared/productLinks'

const assetSchema = z.object({
  name: z.string(),
  browser_download_url: z.url(),
  digest: z.string().regex(/^sha256:[a-f\d]{64}$/),
  size: z.number().int().positive().max(1_000_000_000),
  state: z.literal('uploaded'),
})

export const desktopUpdatePackageSchema = z.object({
  version: desktopVersionSchema,
  name: z.string().max(255),
  url: z.url().max(2048),
  sha256: z.string().regex(/^[a-f\d]{64}$/),
  size: z.number().int().positive().max(1_000_000_000),
}).strict()

export type DesktopUpdatePackage = z.infer<typeof desktopUpdatePackageSchema>

export function selectDesktopUpdatePackage(release: GithubRelease, version: string, architecture: DesktopDistribution['architecture'], format: DesktopPackageFormat): DesktopUpdatePackage | null {
  desktopVersionSchema.parse(version)
  if (!['x64', 'arm64'].includes(architecture) || !Array.isArray(release.assets) || release.draft || release.prerelease !== isDesktopBetaVersion(version) || release.tag_name !== `v${version}`)
    return null
  const name = desktopUpdateArtifactName(format, architecture, version)
  const matches = release.assets.filter(asset => asset && typeof asset === 'object' && asset.name === name)
  if (matches.length !== 1)
    return null
  const parsed = assetSchema.safeParse(matches[0])
  if (!parsed.success)
    return null
  const asset = parsed.data
  const url = new URL(asset.browser_download_url)
  const releaseUrl = new URL(release.html_url)
  if (!isLexoraReleaseUrl(url.href) || releaseUrl.href !== `https://github.com/useLexora/Lexora/releases/tag/v${version}` || url.search || url.hash
    || url.href !== `${releaseUrl.origin}${releaseUrl.pathname.replace(/\/tag\/[^/]+$/, '')}/download/v${version}/${name}`) {
    return null
  }
  return { version, name, url: url.href, size: asset.size, sha256: asset.digest.slice(7) }
}

export async function verifyDesktopUpdatePackage(path: string, update: DesktopUpdatePackage): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== update.size)
      return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path))
      hash.update(chunk)
    return hash.digest('hex') === update.sha256
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return false
    throw error
  }
}

export async function downloadDesktopUpdatePackage(options: {
  directory: string
  update: DesktopUpdatePackage
  get: (url: string, init: { signal: AbortSignal }) => Promise<Response>
  settings?: DownloadSettings
  signal: AbortSignal
  progress: (percent: number, received: number) => void
}): Promise<string> {
  const { directory, update, get, signal, progress } = options
  const pending = join(directory, 'pending')
  await mkdir(pending, { recursive: true })
  if ((await lstat(directory)).isSymbolicLink() || (await lstat(pending)).isSymbolicLink())
    throw new Error('UPDATE_CACHE_INVALID')
  const destination = join(pending, update.name)
  if (await verifyDesktopUpdatePackage(destination, update)) {
    signal.throwIfAborted()
    return destination
  }
  const routes = downloadRoutes(update.url, options.settings)
  let failure: unknown
  for (const [index, route] of routes.entries()) {
    signal.throwIfAborted()
    try {
      return await downloadFromRoute({ destination, route, update, get, signal, progress, direct: index === routes.length - 1 })
    }
    catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof DownloadRouteError))
        throw error
      const code = error.kind === 'integrity' ? 'UPDATE_PACKAGE_INVALID' : error.kind === 'url' ? 'UPDATE_DOWNLOAD_URL_INVALID' : 'UPDATE_DOWNLOAD_FAILED'
      failure = error.kind === 'network' ? error.cause : error.kind === 'timeout' ? new DOMException('UPDATE_DOWNLOAD_TIMEOUT', 'TimeoutError') : new Error(code, { cause: error })
    }
  }
  throw failure
}

async function downloadFromRoute(options: {
  destination: string
  route: string
  direct: boolean
  update: DesktopUpdatePackage
  get: (url: string, init: { signal: AbortSignal }) => Promise<Response>
  signal: AbortSignal
  progress: (percent: number, received: number) => void
}): Promise<string> {
  const { destination, route, direct, update, get, signal, progress } = options
  const temporary = `${destination}.download`
  await rm(temporary, { force: true })
  const file = await open(temporary, 'wx', 0o600)
  try {
    const allowedOrigins = new Set(['https://github.com', 'https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com', new URL(route).origin])
    const hash = createHash('sha256')
    let received = 0
    let previousPercent = 0
    progress(0, 0)
    for await (const value of downloadBytes({
      url: route,
      get,
      signal,
      timeoutMs: direct ? 30_000 : 15_000,
      validateUrl: (raw) => {
        const target = new URL(raw)
        if (target.protocol !== 'https:' || target.username || target.password || !allowedOrigins.has(target.origin))
          throw new Error('UPDATE_DOWNLOAD_URL_INVALID')
      },
    })) {
      received += value.byteLength
      if (received > update.size)
        throw new DownloadRouteError('integrity')
      hash.update(value)
      await file.writeFile(value)
      const percent = Math.min(99, Math.floor(received * 100 / update.size))
      if (percent !== previousPercent) {
        previousPercent = percent
        progress(percent, received)
      }
    }
    if (received !== update.size || hash.digest('hex') !== update.sha256)
      throw new DownloadRouteError('integrity')
    signal.throwIfAborted()
    await file.sync()
    await file.close()
    await rename(temporary, destination)
    return destination
  }
  finally {
    await file.close()
    await rm(temporary, { force: true })
  }
}
