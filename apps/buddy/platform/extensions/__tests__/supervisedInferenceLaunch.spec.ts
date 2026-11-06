import type { InferenceResourceLease } from '../ExtensionInferenceResources'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterEach, expect, it } from 'vitest'
import { inferenceBindingSchema, inferenceLimits } from '../../../shared/extensions/extensionInference'
import { resolveInferenceEnvironment } from '../../../shared/extensions/inferencePlatform'
import { readInferenceInitialization } from '../inferenceInitialization'
import { NativeInferenceProcess } from '../NativeInferenceProcess'
import { prepareSupervisedInferenceLaunch } from '../supervisedInferenceLaunch'
import { createStore, manifest } from './fixtures'
import { invocation } from './inferenceFixtures'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function fixture() {
  const { root, store } = await createStore()
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const contribution = manifest({
    id: 'tests.windows-inference',
    apiVersion: 3,
    permissions: { inference: true },
    contributes: { inference: {
      runtimes: [{ id: 'local', entry: 'native/fixture.mjs', platforms: ['linux-x64', 'windows-x64', 'macos-arm64'] }],
      capabilities: [{ id: 'local', title: 'Local', kind: 'speech.transcribe', runtime: 'local' }],
    } },
  })
  const code = 'import { createHash } from "node:crypto"; export function initialize(context) { return { start(_capability, input, call) { return { finish() { call.emit(input.summary ? { sha256: createHash("sha256").update(JSON.stringify(context)).digest("hex") } : context, new Uint8Array([0, 255, 128, 10])) } } } } }'
  await store.install((await store.reviewFiles(new Map([
    ['extension.json', Buffer.from(JSON.stringify(contribution))],
    ['extension.js', Buffer.from('export function activate() {}')],
    ['native/fixture.mjs', Buffer.from(code)],
  ]))).token)
  const pkg = store.installed[contribution.id]!.current
  const runtime = pkg.manifest.contributes.inference!.runtimes[0]!
  const original = join(root, '外部 model # original.bin')
  await writeFile(original, 'synthetic weights')
  const handle = await open(original, 'r')
  cleanups.push(() => handle.close())
  const lease: InferenceResourceLease = { files: [{ path: 'nested/model.gguf', handle, hostPath: original }], release: async () => {} }
  const binding = inferenceBindingSchema.parse({ runtime: 'local', resources: [{ mount: 'model', id: 'model', revision: '0'.repeat(64) }] })
  const start = async (target = runtime) => {
    const launch = await prepareSupervisedInferenceLaunch('bootstrap', store, pkg, target, binding, [lease], new AbortController().signal)
    cleanups.push(launch.dispose)
    return launch
  }
  return { root, store, pkg, original, handle, lease, runtime, binding, code, start }
}

async function buildWorkerBootstrap(): Promise<string> {
  const result = await build({ configFile: false, envFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: { write: false, minify: false, target: 'esnext', ssr: fileURLToPath(new URL('../inferenceWorker.ts', import.meta.url)), rollupOptions: { external: [/^node:/], output: { codeSplitting: false } } } })
  const output = Array.isArray(result) ? result[0]!.output : 'output' in result ? result.output : []
  const bootstrap = output.find(item => item.type === 'chunk')
  if (bootstrap?.type !== 'chunk')
    throw new Error('Missing bootstrap')
  return bootstrap.code
}

it('preserves external role names through a path map without copying, linking or changing original permissions', async () => {
  const f = await fixture()
  const before = await f.handle.stat()
  const launch = await f.start()
  expect(launch.resourceFiles).toEqual({ model: { 'nested/model.gguf': f.original } })
  expect(await readInferenceInitialization(launch.directory)).toEqual({ configuration: {}, resources: launch.resources, resourceFiles: launch.resourceFiles })
  expect(await readdir(launch.resources.model!)).toEqual([])
  expect(await readFile(join(launch.directory, 'plugin', 'native', 'fixture.mjs'), 'utf8')).toBe(f.code)
  expect(await readFile(f.original, 'utf8')).toBe('synthetic weights')
  const after = await f.handle.stat()
  expect([after.ino, after.dev, after.mode, after.nlink]).toEqual([before.ino, before.dev, before.mode, before.nlink])
  await launch.dispose()
  await expect(readFile(join(launch.directory, 'runtime.mjs'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects a package changed after review and an unregistered native entry', async () => {
  const f = await fixture()
  await expect(f.start({ ...f.runtime, entry: '../fixture.mjs' })).rejects.toThrow('EXTENSION_INFERENCE_ENTRY_INVALID')
  await expect(f.start({ ...f.runtime, entry: 'native/unregistered.mjs' })).rejects.toThrow('EXTENSION_INFERENCE_ENTRY_INVALID')
  await writeFile(join(f.store.packageRoot(f.pkg), f.runtime.entry), 'changed')
  await expect(f.start()).rejects.toThrow('EXTENSION_PACKAGE_CHANGED')
})

it('fails closed when an external path no longer denotes the verified open file', async () => {
  const f = await fixture()
  await rename(f.original, `${f.original}.retained`)
  await writeFile(f.original, 'synthetic weights')
  await expect(f.start()).rejects.toThrow('EXTENSION_INFERENCE_RESOURCE_CHANGED')
  f.lease.files[0]!.hostPath = undefined
  await expect(f.start()).rejects.toThrow('EXTENSION_INFERENCE_RESOURCE_PATH_UNAVAILABLE')
})

it('materializes supervised resource mappings with same-volume hardlinks (Darwin mapping on Linux)', async () => {
  const f = await fixture()
  const source = {
    response: async () => new Response('synthetic'),
    openReference: async () => { throw new Error('unused') },
  }
  const digest = createHash('sha256').update('synthetic').digest('hex')
  const resource = await f.store.inference.prepare(f.pkg.manifest.id, { id: 'engine', kind: 'engine', files: ['bin/engine.exe', 'bin/libs/helper.dll'].map(path => ({ path, executable: true, sha256: digest, source: { url: 'https://fixture.invalid/engine' } })) }, source, new AbortController().signal, () => {})
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: process.platform === 'linux' ? 'darwin' : process.platform })
  let lease: InferenceResourceLease
  try {
    lease = await f.store.inference.acquire(f.pkg.manifest.id, resource, source, new AbortController().signal)
  }
  finally { Object.defineProperty(process, 'platform', platform) }
  cleanups.push(lease.release)
  expect(lease.directory).toBeTruthy()
  for (const file of lease.files) {
    expect(file.hostPath).toBe(join(lease.directory!, file.path))
    const original = await file.handle.stat({ bigint: true })
    const view = await stat(file.hostPath!, { bigint: true })
    expect([view.dev, view.ino]).toEqual([original.dev, original.ino])
    expect(view.nlink).toBeGreaterThanOrEqual(2n)
    expect(await readFile(file.hostPath!, 'utf8')).toBe('synthetic')
  }
  await lease.release()
  await expect(readdir(lease.directory!)).rejects.toMatchObject({ code: 'ENOENT' })
  const retained = await f.store.inference.acquire(f.pkg.manifest.id, resource, source, new AbortController().signal)
  cleanups.push(retained.release)
  expect(await retained.files[0]!.handle.readFile('utf8')).toBe('synthetic')
})

it('keeps an external resource lease mapped to the original file on the Darwin branch', async () => {
  const f = await fixture()
  const before = await stat(f.original, { bigint: true })
  const source = {
    response: async () => { throw new Error('reference must not be copied') },
    openReference: () => open(f.original, 'r'),
    referencePath: async () => f.original,
  }
  const resource = await f.store.inference.prepare(f.pkg.manifest.id, {
    id: 'external',
    kind: 'model',
    files: [{ path: 'nested/model.gguf', sha256: createHash('sha256').update('synthetic weights').digest('hex'), source: { resourceId: randomUUID(), reference: true } }],
  }, source, new AbortController().signal, () => {})
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  let lease: InferenceResourceLease
  try {
    lease = await f.store.inference.acquire(f.pkg.manifest.id, resource, source, new AbortController().signal)
  }
  finally { Object.defineProperty(process, 'platform', platform) }
  cleanups.push(lease.release)
  expect(lease.files[0]!.hostPath).toBe(f.original)
  expect(await readdir(lease.directory!)).toEqual([])
  const after = await stat(f.original, { bigint: true })
  expect([after.dev, after.ino, after.mode, after.nlink]).toEqual([before.dev, before.ino, before.mode, before.nlink])
  await lease.release()
  expect(await readFile(f.original, 'utf8')).toBe('synthetic weights')
})

it.skipIf(resolveInferenceEnvironment(process.platform, process.arch).executionMode !== 'supervised')('runs the validated worker with mapped resources through the actual platform supervisor', async () => {
  const f = await fixture()
  expect(process.env.LEXORA_BUDDY_PROCESS_CONTROL, 'freshly built platform process-control helper').toBeTruthy()
  const worker = await NativeInferenceProcess.start({
    executable: process.execPath,
    supervisor: process.env.LEXORA_BUDDY_PROCESS_CONTROL,
    sandbox: '',
    bootstrap: await buildWorkerBootstrap(),
  }, f.store, f.pkg, f.runtime, f.binding, [f.lease], AbortSignal.timeout(10000))
  cleanups.push(() => worker.stop())
  const events: unknown[] = []
  await worker.invoke(invocation({
    signal: AbortSignal.timeout(10000),
    event(data, bytes) { events.push({ data, bytes: [...bytes] }) },
  }))
  expect(events).toEqual([{ data: { configuration: {}, resources: { model: expect.any(String) }, resourceFiles: { model: { 'nested/model.gguf': f.original } } }, bytes: [0, 255, 128, 10] }])
  await worker.stop()
  expect(worker.stopped).toBe(true)
})

it.skipIf(resolveInferenceEnvironment(process.platform, process.arch).executionMode !== 'supervised')('initializes more than 64 KiB of managed and external mappings through the supervised worker without changing wire budgets', async () => {
  const f = await fixture()
  expect(process.env.LEXORA_BUDDY_PROCESS_CONTROL).toBeTruthy()
  const directory = join(f.root, 'managed-model-view-完整角色目录初始化预算测试')
  await mkdir(join(directory, 'espeak-ng-data', 'lang'), { recursive: true })
  const files: InferenceResourceLease['files'] = []
  for (let index = 0; index < 360; index++) {
    const path = `espeak-ng-data/lang/语言-family-${index.toString().padStart(4, '0')}.dict`
    const hostPath = join(directory, path)
    await link(f.original, hostPath)
    files.push({ path, hostPath, handle: f.handle })
  }
  f.lease.directory = join(f.root, 'external-view')
  const managed: InferenceResourceLease = { directory, files, release: async () => {} }
  const binding = inferenceBindingSchema.parse({
    runtime: 'local',
    resources: [...f.binding.resources, { mount: 'external', id: 'external', revision: '0'.repeat(64) }],
    libraryPaths: [{ mount: 'model', path: 'espeak-ng-data/lang' }],
  })
  const initialization = {
    configuration: {},
    resources: { model: directory, external: f.lease.directory },
    resourceFiles: {
      model: Object.fromEntries(files.map(file => [file.path, file.hostPath!])),
      external: { 'nested/model.gguf': f.original },
    },
  }
  expect(Buffer.byteLength(JSON.stringify(initialization))).toBeGreaterThan(inferenceLimits.controlBytes)
  const worker = await NativeInferenceProcess.start({
    executable: process.execPath,
    supervisor: process.env.LEXORA_BUDDY_PROCESS_CONTROL,
    sandbox: '',
    bootstrap: await buildWorkerBootstrap(),
  }, f.store, f.pkg, f.runtime, binding, [managed, f.lease], AbortSignal.timeout(10000))
  cleanups.push(() => worker.stop())
  const events: unknown[] = []
  await worker.invoke(invocation({
    input: { summary: true },
    signal: AbortSignal.timeout(10000),
    event(data, bytes) { events.push({ data, bytes: [...bytes] }) },
  }))
  expect(events).toEqual([{ data: { sha256: createHash('sha256').update(JSON.stringify(initialization)).digest('hex') }, bytes: [0, 255, 128, 10] }])
  await worker.stop()
  expect(worker.stopped).toBe(true)
})
