import type { DesktopUpdatePackage } from '../DesktopUpdatePackage'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { describe, expect, it } from 'vitest'
import { downloadDesktopUpdatePackage, selectDesktopUpdatePackage, verifyDesktopUpdatePackage } from '../DesktopUpdatePackage'

const body = Buffer.from('isolated installer fixture')
const update: DesktopUpdatePackage = {
  version: '1.2.3',
  name: 'Lexora-Buddy-1.2.3-windows-x64.exe',
  url: 'https://github.com/useLexora/Lexora/releases/download/v1.2.3/Lexora-Buddy-1.2.3-windows-x64.exe',
  size: body.length,
  sha256: createHash('sha256').update(body).digest('hex'),
}

describe('desktop update packages', () => {
  it('selects only the matching architecture with a complete immutable release identity', () => {
    const asset = { name: update.name, browser_download_url: update.url, digest: `sha256:${update.sha256}`, size: update.size, state: 'uploaded' }
    const release = { draft: false, prerelease: false, tag_name: 'v1.2.3', html_url: 'https://github.com/useLexora/Lexora/releases/tag/v1.2.3', assets: [asset] }
    expect(selectDesktopUpdatePackage(release, '1.2.3', 'x64', 'nsis')).toEqual(update)
    expect(selectDesktopUpdatePackage(release, '1.2.3', 'arm64', 'nsis')).toBeNull()
    expect(selectDesktopUpdatePackage({ ...release, assets: [asset, asset] }, '1.2.3', 'x64', 'nsis')).toBeNull()
    expect(selectDesktopUpdatePackage({ ...release, assets: [{ ...asset, browser_download_url: update.url.replace('useLexora', 'untrusted') }] }, '1.2.3', 'x64', 'nsis')).toBeNull()
    expect(selectDesktopUpdatePackage({ ...release, assets: [{ ...asset, digest: null }] }, '1.2.3', 'x64', 'nsis')).toBeNull()
  })

  it('commits only verified bytes and revalidates cache before reuse', async () => {
    const root = await createTemporaryDirectory('lexora-update-')
    let requests = 0
    const options = { directory: root, update, signal: new AbortController().signal, progress: () => {}, get: async () => {
      requests++
      return new Response(body)
    } }
    const file = await downloadDesktopUpdatePackage(options)
    expect(await readFile(file)).toEqual(body)
    expect(await verifyDesktopUpdatePackage(file, update)).toBe(true)
    expect(await downloadDesktopUpdatePackage(options)).toBe(file)
    expect(requests).toBe(1)
    await writeFile(file, Buffer.alloc(body.length))
    expect(await verifyDesktopUpdatePackage(file, update)).toBe(false)
    await downloadDesktopUpdatePackage(options)
    expect(requests).toBe(2)
    expect(await readdir(join(root, 'pending'))).toEqual([update.name])
  })

  it.each([Buffer.alloc(body.length), Buffer.alloc(body.length + 1), body.subarray(0, 2)])('rejects corrupt, oversized or truncated content without leaving an executable', async (content) => {
    const root = await createTemporaryDirectory('lexora-update-')
    await expect(downloadDesktopUpdatePackage({ directory: root, update, signal: new AbortController().signal, progress: () => {}, get: async () => new Response(content) })).rejects.toThrow('UPDATE_PACKAGE_INVALID')
    expect(await readdir(join(root, 'pending'))).toEqual([])
  })

  it('follows only trusted HTTPS asset redirects', async () => {
    const root = await createTemporaryDirectory('lexora-update-')
    await expect(downloadDesktopUpdatePackage({ directory: root, update, signal: new AbortController().signal, progress: () => {}, get: async () => new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/update.exe' } }) })).rejects.toThrow('UPDATE_DOWNLOAD_URL_INVALID')
    expect(await readdir(join(root, 'pending'))).toEqual([])
  })

  it('removes interrupted staging without leaving an executable', async () => {
    const root = await createTemporaryDirectory('lexora-update-')
    const controller = new AbortController()
    await expect(downloadDesktopUpdatePackage({ directory: root, update, signal: controller.signal, progress: () => controller.abort(), get: async () => new Response(body) })).rejects.toThrow()
    expect(await readdir(join(root, 'pending'))).toEqual([])
  })
})
