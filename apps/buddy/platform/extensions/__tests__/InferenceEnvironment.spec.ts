import type { InferenceHardware } from '../../../shared/extensions/extensionInference'
import type { ExtensionInferencePorts } from '../ExtensionInference'
import type { ExtensionServicePorts } from '../ExtensionService'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import process from 'node:process'
import { expect, it, onTestFinished } from 'vitest'
import { resolveInferenceEnvironment } from '../../../shared/extensions/inferencePlatform'
import { ExtensionService } from '../ExtensionService'
import { createStore, manifest } from './fixtures'

async function fixture(permissions: { inference?: boolean, inferenceGpu?: boolean }, hardware?: ExtensionInferencePorts['hardware']) {
  const { root, store } = await createStore()
  const id = 'tests.environment'
  const contribution = manifest({ id, apiVersion: 3, permissions, contributes: { commands: [{ id: `${id}.open`, title: 'Open' }] } })
  await store.install((await store.reviewFiles(new Map([
    ['extension.json', Buffer.from(JSON.stringify(contribution))],
    ['extension.js', Buffer.from('export function activate() {}')],
  ]))).token)
  let broker: Parameters<ExtensionServicePorts['createHost']>[1] = async () => {
    throw new Error('Not activated')
  }
  const service = new ExtensionService(store, {
    inference: { hardware, executable: '', bootstrap: '', admit: async () => { throw new Error('Unexpected inference') } },
    createHost: (_pkg, request) => {
      broker = request
      return { call: async () => null, dispose: async () => {}, devtools() {} }
    },
    createView: () => ({ token: randomUUID(), url: 'lexora-extension://fixture', dispose() {} }),
    get: async () => { throw new Error('Unexpected network') },
    readText: async () => '',
    workbench: async event => event.requestId,
  })
  onTestFinished(async () => {
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await service.execute(id, `${id}.open`, null)
  return { request: () => broker('inference.environment', null) }
}

const hardware: InferenceHardware = { sampledAt: 1234, logicalCores: 8, totalMemoryBytes: 16000, gpus: [{ name: 'Fixture', vendor: 'nvidia', totalMemoryBytes: 8000 }] }

it.each([true, false])('projects hardware behind inference and GPU permissions: GPU=%s', async (inferenceGpu) => {
  const f = await fixture({ inference: true, inferenceGpu }, async () => ({ ...hardware, private: 'must not escape' }))
  expect(await f.request()).toEqual({ ...resolveInferenceEnvironment(process.platform, process.arch), hardware: { ...hardware, gpus: inferenceGpu ? hardware.gpus : [] } })
})

it('denies hardware to plugins without inference permission', async () => {
  const f = await fixture({}, async () => hardware)
  await expect(f.request()).rejects.toThrow('EXTENSION_PERMISSION_DENIED')
})

it.each(['absent', 'failed', 'invalid'] as const)('preserves the old environment contract when hardware is %s', async (mode) => {
  const f = await fixture({ inference: true }, mode === 'absent'
    ? undefined
    : async () => {
      if (mode === 'failed')
        throw new Error('Hardware unavailable')
      return { ...hardware, logicalCores: -1 }
    })
  expect(await f.request()).toEqual(resolveInferenceEnvironment(process.platform, process.arch))
})
