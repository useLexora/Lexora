import type { ExtensionServicePorts } from '../ExtensionService'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import process from 'node:process'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { expect, it, onTestFinished } from 'vitest'
import { inferenceBindingSchema, inferencePlatformSchema } from '../../../shared/extensions/extensionInference'
import { resolveInferenceEnvironment } from '../../../shared/extensions/inferencePlatform'
import { ExtensionInferenceCredentials } from '../ExtensionInferenceCredentials'
import { ExtensionPackageStore } from '../ExtensionPackageStore'
import { ExtensionService } from '../ExtensionService'
import { manifest } from './fixtures'

function current() {}
const origin = 'https://images.invalid'
const reference = { id: 'images', origin }

function credentialStore() {
  const values = new Map<string, unknown>()
  const credentials = new ExtensionInferenceCredentials({
    read: async id => structuredClone(values.get(id) ?? null),
    write: async (id, value) => { values.set(id, structuredClone(value)) },
    delete: async (id) => { values.delete(id) },
  })
  return { credentials, values }
}

it('serializes credential updates, isolates plugin and origin ownership, and rejects stale writes', async () => {
  const { credentials, values } = credentialStore()
  await Promise.all(['first', 'second'].map(id => credentials.set('tests.one', {
    id,
    origin,
    token: `synthetic-${id}`,
  }, current)))
  expect(values.get('tests.one')).toEqual([
    { id: 'first', origin, token: 'synthetic-first' },
    { id: 'second', origin, token: 'synthetic-second' },
  ])
  expect(await credentials.authorize('tests.one', { id: 'second', origin })).toBe('Bearer synthetic-second')
  for (const [plugin, target] of [['tests.two', origin], ['tests.one', 'https://another.invalid']] as const)
    await expect(credentials.authorize(plugin, { id: 'first', origin: target })).rejects.toThrow('CREDENTIAL_UNAVAILABLE')
  await credentials.set('tests.two', { id: 'first', origin, token: 'synthetic-separate' }, current)
  await credentials.remove('tests.one', 'first', current)
  expect(await credentials.has('tests.one', { id: 'first', origin })).toBe(false)
  expect(await credentials.authorize('tests.one', { id: 'second', origin })).toBe('Bearer synthetic-second')
  await credentials.clear('tests.one')
  expect(values.has('tests.one')).toBe(false)
  expect(await credentials.authorize('tests.two', { id: 'first', origin })).toBe('Bearer synthetic-separate')
  await expect(credentials.set('tests.two', { id: 'third', origin, token: 'synthetic-late' }, () => {
    throw new Error('Stale generation')
  })).rejects.toThrow('Stale generation')
  expect(values.get('tests.two')).toEqual([{ id: 'first', origin, token: 'synthetic-separate' }])
  await credentials.remove('tests.two', 'first', current)
  expect(values.has('tests.two')).toBe(false)
})

it('enforces origin permission and credential availability before inference, preserving credentials on ordinary uninstall', async () => {
  const root = await createTemporaryDirectory('lexora-inference-credentials-')
  const store = new ExtensionPackageStore(join(root, 'extensions'), '0.14.0')
  const { credentials, values } = credentialStore()
  const owner = 'tests.images'
  const contribution = manifest({
    id: owner,
    apiVersion: 3,
    engines: { lexora: '*' },
    permissions: { inference: true, inferenceNetwork: [origin, 'https://another.invalid'] },
    contributes: {
      commands: [{ id: `${owner}.open`, title: 'Open' }],
      inference: {
        runtimes: [{ id: 'api', entry: 'native/api.mjs', platforms: inferencePlatformSchema.options }],
        capabilities: [{ id: 'image', title: 'Image', kind: 'image.generate', runtime: 'api' }],
      },
    },
  })
  const files = new Map([
    ['extension.json', Buffer.from(JSON.stringify(contribution))],
    ['extension.js', Buffer.from('export function activate() {}')],
    ['native/api.mjs', Buffer.from('export async function initialize() { throw Error("Unexpected inference start") }')],
  ])
  await store.install((await store.reviewFiles(files)).token)
  let broker: Parameters<ExtensionServicePorts['createHost']>[1] = async () => {
    throw new Error('Host not activated')
  }
  const service = new ExtensionService(store, {
    inference: {
      credentials,
      executable: 'unused',
      sandbox: 'unused',
      bootstrap: '',
      admit: async () => { throw new Error('Unauthenticated inference was admitted') },
    },
    createHost: (_pkg, request) => {
      broker = request
      return { call: async () => null, dispose: async () => {}, devtools() {} }
    },
    createView: () => ({ token: randomUUID(), url: 'lexora-extension://fixture', dispose() {} }),
    get: async () => { throw new Error('Unexpected network access') },
    readText: async () => '',
    workbench: async event => event.requestId,
  })
  onTestFinished(() => service.dispose())
  await service.execute(owner, `${owner}.open`, null)
  await expect(broker('inference.credentials.set', {
    id: 'images',
    origin: 'https://unapproved.invalid',
    token: 'synthetic-must-not-store',
  })).rejects.toThrow('PERMISSION_DENIED')
  expect(values.has(owner)).toBe(false)
  await broker('inference.credentials.set', { ...reference, token: 'synthetic-token' })
  const binding = inferenceBindingSchema.parse({
    runtime: 'api',
    resources: [],
    endpoints: [{ id: 'generate', url: 'https://another.invalid/v1/images/generations', contentType: 'application/json', credential: 'images' }],
    imageModels: [{ id: 'fixture', title: 'Fixture', capability: 'image', support: { operations: ['generate'], maxReferenceImages: 0, sizes: ['512x512'], qualities: ['auto'], backgrounds: ['auto'] } }],
  })
  await broker('inference.bind', binding)
  expect(await service.inferenceImageModels()).toEqual([])
  await expect(service.prepareInference(owner, store.installed[owner]!.current.revision, 'image')).rejects.toThrow('CREDENTIAL_UNAVAILABLE')
  binding.endpoints[0]!.url = `${origin}/v1/images/generations`
  await broker('inference.bind', binding)
  const available = await service.inferenceImageModels()
  expect(available).toHaveLength(resolveInferenceEnvironment(process.platform, process.arch).platform ? 1 : 0)
  await broker('inference.credentials.remove', { id: 'images' })
  expect(await service.inferenceImageModels()).toEqual([])
  await expect(service.prepareInference(owner, store.installed[owner]!.current.revision, 'image')).rejects.toThrow('CREDENTIAL_UNAVAILABLE')
  await broker('inference.credentials.set', { ...reference, token: 'synthetic-restored' })
  expect(await service.inferenceImageModels()).toEqual(available)
  await service.uninstall(owner)
  expect(await credentials.authorize(owner, reference)).toBe('Bearer synthetic-restored')
  await store.install((await store.reviewFiles(files)).token)
  await service.uninstall(owner, true)
  expect(values.has(owner)).toBe(false)
})
