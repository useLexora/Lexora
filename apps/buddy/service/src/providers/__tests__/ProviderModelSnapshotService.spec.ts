import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProviderModelSnapshotService } from '../ProviderModelSnapshotService'

const directories: string[] = []
const builtin = { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', data: data('before') }
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('providerModelSnapshotService', () => {
  it('preserves a single refresh under observer reentry and versions complete capability changes', async () => {
    let next = data('before')
    const service = new ProviderModelSnapshotService({ builtin, fetch: async () => Response.json(next) })
    const events: import('../ProviderModelSnapshotService').ModelMetadataChange[] = []
    let reentrant: Promise<unknown> | undefined
    service.onDidChange((event) => {
      events.push(event)
      if (event.kind === 'refresh-started')
        reentrant = service.refresh()
    })
    const first = service.refresh()
    expect(reentrant).toBe(first)
    await first
    expect(events.find(event => event.kind === 'accepted')?.catalogRevision).toBe(0)
    next = data('before')
    next.openai.models.model.modalities.input = ['text']
    await service.refresh()
    expect(events.filter(event => event.kind === 'accepted').at(-1)?.catalogRevision).toBe(1)
    const accepted = events.filter(event => event.kind === 'accepted').length
    await service.refresh()
    expect(events.filter(event => event.kind === 'accepted')).toHaveLength(accepted)
    expect(Object.isFrozen(service.getModels()[0])).toBe(true)
    await service.dispose()
  })

  it('coalesces one public download, persists it and restores it offline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buddy-model-snapshot-'))
    directories.push(directory)
    const snapshotPath = join(directory, 'models.dev.json')
    let finish!: (response: Response) => void
    const service = new ProviderModelSnapshotService({
      builtin,
      snapshotPath,
      now: () => new Date('2026-09-12T00:00:00.000Z'),
      fetch: async (url, options) => {
        expect(url).toBe('https://models.dev/api.json')
        expect(options?.headers).toBeUndefined()
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    const first = service.refresh()
    expect(service.refresh()).toBe(first)
    finish(Response.json(data('after')))
    await expect(first).resolves.toMatchObject({ errorCount: 0, modelCount: 1, source: 'remote' })
    const restarted = new ProviderModelSnapshotService({ builtin, snapshotPath, fetch: offline })
    await restarted.initialize()
    expect(restarted.getModels()[0]?.name).toBe('after')
    await expect(restarted.refresh()).resolves.toMatchObject({ errorCount: 1, modelCount: 1, source: 'remote' })
    expect(restarted.getModels()[0]?.name).toBe('after')
    expect(JSON.parse(await readFile(snapshotPath, 'utf8')).data).toEqual(data('after'))
  })

  it.each([{}, { provider: { name: 'broken', models: { broken: {} } } }])('rejects malformed refreshes without replacing the last snapshot', async (invalid) => {
    const service = new ProviderModelSnapshotService({ builtin, fetch: async () => Response.json(invalid) })
    await expect(service.refresh()).resolves.toMatchObject({ errorCount: 1, source: 'builtin' })
    expect(service.getModels()[0]?.name).toBe('before')
  })

  it('falls back after a corrupt cache and does not publish a download that cannot be persisted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buddy-model-snapshot-'))
    directories.push(directory)
    const snapshotPath = join(directory, 'models.dev.json')
    await writeFile(snapshotPath, '{broken')
    const service = new ProviderModelSnapshotService({ builtin, snapshotPath })
    await service.initialize()
    expect(service.getModels()[0]?.name).toBe('before')
    const unwritable = new ProviderModelSnapshotService({ builtin, snapshotPath: directory, fetch: async () => Response.json(data('after')) })
    await expect(unwritable.refresh()).resolves.toMatchObject({ errorCount: 1, source: 'builtin' })
    expect(unwritable.getModels()[0]?.name).toBe('before')
  })
})

function data(name: string) {
  return { openai: { name: 'OpenAI', npm: '@ai-sdk/openai', models: {
    model: { name, modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }, limit: { context: 128_000, output: 16_384 } },
  } } }
}

async function offline(): Promise<Response> {
  throw new Error('offline')
}
