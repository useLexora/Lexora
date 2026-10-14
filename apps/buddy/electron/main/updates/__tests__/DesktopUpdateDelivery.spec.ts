import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deferred } from '@buddy-tests/deferred'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { describe, expect, it } from 'vitest'
import { DesktopUpdateDelivery } from '../DesktopUpdateDelivery'

const body = Buffer.from('delivery fixture')
const update = { version: '1.2.3', name: 'Lexora-Buddy-1.2.3-windows-x64.exe', url: 'https://github.com/useLexora/Lexora/releases/download/v1.2.3/Lexora-Buddy-1.2.3-windows-x64.exe', size: body.length, sha256: createHash('sha256').update(body).digest('hex') }

async function setup(allowed = true, launchFailure = false) {
  const directory = await createTemporaryDirectory('lexora-delivery-')
  const operations: string[] = []
  let permit = allowed
  const delivery = new DesktopUpdateDelivery({ directory, get: async () => new Response(body), requestInstall: async (prepare) => {
    operations.push('confirm')
    if (!permit)
      return false
    await prepare()
    operations.push('shutdown')
    return true
  }, launchInstaller: async () => {
    operations.push('installer')
    if (launchFailure)
      throw new Error('Signature rejected')
  }, openPackage: async () => {}, reportFailure: () => {} })
  delivery.discover({ mode: 'restart', reason: null, update, fallback: null })
  return { directory, delivery, operations, allow: () => {
    permit = true
  } }
}

describe('update delivery', () => {
  it.each([true, false])('stops only automatic downloads when background downloading is disabled (automatic=%s)', async (automatic) => {
    const directory = await createTemporaryDirectory('lexora-delivery-')
    const started = deferred<void>()
    const finish = deferred<void>()
    const delivery = new DesktopUpdateDelivery({
      directory,
      get: async (_url, { signal }) => new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
          controller.enqueue(body.subarray(0, 4))
          started.resolve()
          void finish.promise.then(() => {
            if (!signal.aborted) {
              controller.enqueue(body.subarray(4))
              controller.close()
            }
          })
        },
      })),
      requestInstall: async () => false,
      launchInstaller: async () => {},
      openPackage: async () => {},
      reportFailure: () => {},
    })
    delivery.discover({ mode: 'restart', reason: null, update, fallback: null })
    if (automatic)
      delivery.reconcile(true, true)
    const download = delivery.download(automatic)
    await started.promise
    delivery.reconcile(true, false)
    if (!automatic)
      expect(delivery.state.status).toBe('downloading')
    finish.resolve()
    await download
    if (automatic) {
      expect(delivery.state.status).toBe('available')
      await expect(readFile(join(directory, 'pending', `${update.name}.download`))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    else {
      expect(delivery.state.status).toBe('ready')
      expect(await readFile(join(directory, 'pending', update.name))).toEqual(body)
    }
    await delivery.dispose()
  })

  it('restores automatic downloading only for the version whose skip was cleared', async () => {
    const { delivery, directory } = await setup()
    delivery.cancel()
    delivery.resumeAutomaticDownload('1.2.2')
    delivery.reconcile(true, true)
    expect(delivery.state.status).toBe('available')
    delivery.resumeAutomaticDownload(update.version)
    delivery.reconcile(true, true)
    await delivery.download(true)
    expect(delivery.state.status).toBe('ready')
    expect(await readFile(join(directory, 'pending', update.name))).toEqual(body)
    await delivery.dispose()
  })

  it.each(['disabled', 'ineligible', 'cancelled', 'changed'] as const)('revalidates a queued automatic download after the old transfer settles (%s)', async (decision) => {
    const directory = await createTemporaryDirectory('lexora-delivery-')
    const started = deferred<void>()
    const finish = deferred<void>()
    const requests: string[] = []
    const delivery = new DesktopUpdateDelivery({
      directory,
      get: async (url) => {
        requests.push(url)
        if (requests.length === 1) {
          started.resolve()
          await finish.promise
        }
        return new Response(body)
      },
      requestInstall: async () => false,
      launchInstaller: async () => {},
      openPackage: async () => {},
      reportFailure: () => {},
    })
    try {
      const plan = { mode: 'restart' as const, reason: null, update, fallback: null }
      delivery.discover(plan)
      delivery.reconcile(true, true)
      await started.promise
      const newer = { ...update, version: '1.2.4', name: update.name.replaceAll('1.2.3', '1.2.4'), url: update.url.replaceAll('1.2.3', '1.2.4') }
      delivery.discover({ ...plan, update: newer })
      const queued = delivery.download(true)
      if (decision === 'disabled')
        delivery.reconcile(true, false)
      else if (decision === 'ineligible')
        delivery.reconcile(false, true)
      else if (decision === 'cancelled')
        delivery.cancel()
      else
        delivery.discover({ mode: 'release', reason: 'asset-unavailable', update: null, fallback: null })
      finish.resolve()
      await queued
      expect(requests).toEqual([update.url])
      expect(delivery.state.status).toBe(decision === 'changed' ? 'idle' : 'available')
      await expect(readFile(join(directory, 'pending', newer.name))).rejects.toMatchObject({ code: 'ENOENT' })
      if (decision !== 'changed') {
        await delivery.download()
        expect(await readFile(join(directory, 'pending', newer.name))).toEqual(body)
      }
    }
    finally {
      finish.resolve()
      await delivery.dispose()
    }
  })

  it('retains a verified update after cancelled installation and allows retry', async () => {
    const { delivery, operations, allow } = await setup(false)
    await delivery.download()
    expect(delivery.state.status).toBe('ready')
    await delivery.install()
    expect(delivery.state.status).toBe('ready')
    expect(operations).toEqual(['confirm'])
    allow()
    await delivery.install()
    expect(operations).toEqual(['confirm', 'confirm', 'installer', 'shutdown'])
    await delivery.dispose()
  })

  it('rejects a staged package modified after download before requesting any shutdown', async () => {
    const { directory, delivery, operations } = await setup()
    await delivery.download()
    await writeFile(join(directory, 'pending', update.name), Buffer.alloc(body.length))
    await expect(delivery.install()).rejects.toThrow('UPDATE_PACKAGE_INVALID')
    expect(operations).toEqual([])
    expect(delivery.state.status).toBe('error')
    await delivery.dispose()
  })
  it('falls back to a manual package without shutting down when native staging fails', async () => {
    const { delivery, operations } = await setup(true, true)
    const fallback = { ...update, name: update.name.replace('windows-x64.exe', 'macos-arm64.dmg'), url: update.url.replace('windows-x64.exe', 'macos-arm64.dmg') }
    delivery.discover({ mode: 'restart', reason: null, update, fallback })
    await delivery.download()
    await delivery.install()
    expect(operations).toEqual(['confirm', 'installer'])
    expect(delivery.state).toMatchObject({ mode: 'open-package', reason: 'installer-unavailable', status: 'available' })
    await delivery.download()
    await expect(delivery.install()).rejects.toThrow('UPDATE_INSTALL_UNAVAILABLE')
    await delivery.openPackage()
    await delivery.dispose()
  })
})
