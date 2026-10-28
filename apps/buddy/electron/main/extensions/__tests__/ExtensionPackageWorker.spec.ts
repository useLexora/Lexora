import type { ExtensionPackageProcessor } from '../../../../platform/extensions/extensionPackageProcessing'
import { watch } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { strToU8, Zip, ZipDeflate, zipSync } from 'fflate'
import { build } from 'vite'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { manifest } from '../../../../platform/extensions/__tests__/fixtures'
import { sha256 } from '../../../../platform/extensions/extensionFiles'
import { ExtensionPackageStore } from '../../../../platform/extensions/ExtensionPackageStore'
import { ExtensionCompatibilityError } from '../../../../shared/extensions/extensionCompatibility'
import { ExtensionPackageWorker } from '../ExtensionPackageWorker'

let root: string
let entry: string
let worker: ExtensionPackageWorker

beforeAll(async () => {
  const parent = fileURLToPath(new URL('../../../../.output/tests/', import.meta.url))
  await mkdir(parent, { recursive: true })
  root = await mkdtemp(join(parent, 'extension-worker-'))
  entry = join(root, 'package-worker.mjs')
  await build({
    configFile: false,
    logLevel: 'silent',
    publicDir: false,
    build: {
      ssr: fileURLToPath(new URL('../packageWorker.ts', import.meta.url)),
      outDir: root,
      emptyOutDir: false,
      minify: false,
      rollupOptions: { output: { entryFileNames: 'package-worker.mjs' } },
    },
  })
  worker = new ExtensionPackageWorker(entry)
}, 60000)

afterAll(async () => {
  if (root)
    await rm(root, { recursive: true, force: true })
})

function files(version = '1.0.0') {
  return new Map([
    ['extension.json', strToU8(JSON.stringify(manifest({ version })))],
    ['extension.js', strToU8('throw new Error("PLUGIN_MUST_NOT_EXECUTE")')],
    ['view.js', strToU8('throw new Error("PLUGIN_MUST_NOT_EXECUTE")')],
  ])
}

it('builds the real worker, reviews and installs a large archive while the caller remains responsive', async () => {
  const input = files()
  input.set('module.wasm', new Uint8Array(32 * 1024 * 1024).fill(23))
  const archive = join(root, 'large.lexora-extension')
  await writeFile(archive, zipSync(Object.fromEntries(input)))
  const store = new ExtensionPackageStore(join(root, 'large-store'), '0.7.3', worker.run)
  let ticks = 0
  const heartbeat = setInterval(() => {
    ticks++
  }, 5)
  try {
    const review = await store.review(archive)
    await store.install(review.token)
    const pkg = store.installed['tests.reader']!.current
    expect(sha256(await readFile(join(store.packageRoot(pkg), 'module.wasm')))).toBe(sha256(input.get('module.wasm')!))
    expect(ticks).toBeGreaterThan(2)
  }
  finally {
    clearInterval(heartbeat)
  }
}, 30000)

it('does not detach caller bytes and pins an independent reviewed snapshot', async () => {
  const input = files()
  const binary = new Uint8Array(2 * 1024 * 1024).fill(17)
  input.set('module.wasm', binary)
  const store = new ExtensionPackageStore(join(root, 'snapshot-store'), '0.7.3', worker.run)
  const review = await store.reviewFiles(input)
  binary.fill(31)
  await store.install(review.token)
  expect(binary.byteLength).toBe(2 * 1024 * 1024)
  const pkg = store.installed['tests.reader']!.current
  expect((await readFile(join(store.packageRoot(pkg), 'module.wasm')))[0]).toBe(17)
  await store.uninstall('tests.reader')
  await writeFile(join(store.packageRoot(pkg), 'extra.js'), 'changed')
  const original = files()
  original.set('module.wasm', new Uint8Array(2 * 1024 * 1024).fill(17))
  await expect(store.install((await store.reviewFiles(original)).token)).rejects.toThrow('EXTENSION_PACKAGE_CHANGED')
  expect(store.installed).toEqual({})
})

it('compiles source without running it, retaining binary resources and the caller buffers', async () => {
  const source = manifest({ version: '1.1.0', format: 'source', entry: 'extension.ts' })
  const input = new Map([
    ['extension.json', strToU8(JSON.stringify(source))],
    ['extension.ts', strToU8('throw new Error("PLUGIN_MUST_NOT_EXECUTE"); export const value: number = 1')],
    ['view.js', strToU8('export function render() {}')],
    ['module.wasm', new Uint8Array(2 * 1024 * 1024).fill(19)],
  ])
  const store = new ExtensionPackageStore(join(root, 'compile-store'), '0.7.3', worker.run)
  await store.install((await store.reviewFiles(files())).token)
  const current = structuredClone(store.installed['tests.reader']!.current)
  const review = await store.reviewFiles(input)
  expect(await store.prepare(review.token, (files, manifest, signal, report) => worker.run({ kind: 'compile', files, manifest }, signal, report), new AbortController().signal, () => {})).toBe(true)
  await store.install(review.token)
  const pending = store.installed['tests.reader']!.pending!
  expect(store.installed['tests.reader']!.current).toEqual(current)
  expect(pending.manifest.format).toBe('compiled')
  expect(await readFile(join(store.packageRoot(pending), 'extension.js'), 'utf8')).toContain('PLUGIN_MUST_NOT_EXECUTE')
  expect(new Uint8Array(await readFile(join(store.packageRoot(pending), 'module.wasm')))).toEqual(input.get('module.wasm'))
  expect(input.get('extension.ts')!.byteLength).toBeGreaterThan(0)
})

it('preserves compatibility diagnostics, rejects traversal, and accepts streaming ZIP buffers', async () => {
  const incompatible = files()
  incompatible.set('extension.json', strToU8(JSON.stringify(manifest({ engines: { lexora: '>=9' } }))))
  await expect(worker.run({ kind: 'inspect', files: incompatible, appVersion: '0.7.3' })).rejects.toBeInstanceOf(ExtensionCompatibilityError)
  await expect(worker.run({ kind: 'unpack', bytes: zipSync({ '../escape.js': strToU8('bad') }), appVersion: '0.7.3' })).rejects.toThrow('EXTENSION_UNSAFE_PACKAGE')
  const chunks: Uint8Array[] = []
  const zip = new Zip((_error, bytes) => chunks.push(bytes))
  for (const [name, bytes] of files()) {
    const file = new ZipDeflate(name)
    zip.add(file)
    file.push(bytes, true)
  }
  zip.end()
  const archive = new Uint8Array(chunks.reduce((sum, bytes) => sum + bytes.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    archive.set(chunk, offset)
    offset += chunk.byteLength
  }
  expect((await worker.run({ kind: 'unpack', bytes: archive, appVersion: '0.7.3' })).manifest.id).toBe('tests.reader')
})

it('cancels staging without changing current, pending or private data and removes incomplete files', async () => {
  const controller = new AbortController()
  let stagedWriteObserved = false
  const process: ExtensionPackageProcessor = (request, signal, report) => {
    const result = worker.run(request, signal, report)
    if (request.kind === 'stage' && signal) {
      const watcher = watch(request.directory, () => {
        stagedWriteObserved = true
        controller.abort(new Error('EXTENSION_INSTALL_CANCELLED'))
      })
      return result.finally(() => watcher.close())
    }
    return result
  }
  const store = new ExtensionPackageStore(join(root, 'cancel-store'), '0.7.3', process)
  await store.install((await store.reviewFiles(files())).token)
  await store.saveData('tests.reader', { retained: true }, 2)
  const current = structuredClone(store.installed)
  const update = files('1.1.0')
  update.set('module.wasm', new Uint8Array(32 * 1024 * 1024))
  const review = await store.reviewFiles(update)
  await expect(store.install(review.token, controller.signal)).rejects.toThrow('EXTENSION_INSTALL_CANCELLED')
  expect(stagedWriteObserved).toBe(true)
  expect(store.installed).toEqual(current)
  expect(await store.data('tests.reader')).toEqual({ version: 2, value: { retained: true } })
  expect((await readdir(join(store.root, 'packages/tests.reader'))).filter(name => name.startsWith('.install-'))).toEqual([])
})

it('bounds admission, cancels queued work and waits for worker termination before advancing', async () => {
  const marker = join(root, 'active-worker.txt')
  const fixture = join(root, 'lifecycle-worker.mjs')
  await writeFile(fixture, `import { parentPort } from 'node:worker_threads'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
parentPort.once('message', ({ bytes }) => {
  if (bytes[0] === 0) {
    appendFileSync(${JSON.stringify(marker)}, 'x')
    setInterval(() => appendFileSync(${JSON.stringify(marker)}, 'x'), 2)
    parentPort.postMessage({ kind: 'log', message: 'ready' })
  }
  else parentPort.postMessage({ kind: 'result', value: existsSync(${JSON.stringify(marker)}) ? readFileSync(${JSON.stringify(marker)}, 'utf8') : '' })
})`)
  const runner = new ExtensionPackageWorker(fixture, 5000)
  const active = new AbortController()
  const queued = new AbortController()
  let started!: () => void
  const ready = new Promise<void>(resolve => started = resolve)
  const first = runner.run({ kind: 'hash', bytes: new Uint8Array([0]) }, active.signal, started)
  const firstFailure = expect(first).rejects.toThrow('EXTENSION_INSTALL_CANCELLED')
  await ready
  const second = runner.run({ kind: 'hash', bytes: new Uint8Array([1]) }, queued.signal)
  const secondFailure = expect(second).rejects.toThrow('EXTENSION_INSTALL_CANCELLED')
  const third = runner.run({ kind: 'hash', bytes: new Uint8Array([1]) })
  const fourth = runner.run({ kind: 'hash', bytes: new Uint8Array([1]) })
  await expect(runner.run({ kind: 'hash', bytes: new Uint8Array([1]) })).rejects.toThrow('EXTENSION_PACKAGE_BUSY')
  queued.abort()
  await secondFailure
  active.abort()
  await firstFailure
  const stoppedAt = await third
  expect(await fourth).toBe(stoppedAt)
  await delay(30)
  expect(await readFile(marker, 'utf8')).toBe(stoppedAt)
})

it('times out running work and rejects crashed workers without hanging subsequent tasks', async () => {
  const hanging = join(root, 'hanging-worker.mjs')
  await writeFile(hanging, 'setInterval(() => {}, 1000)')
  await expect(new ExtensionPackageWorker(hanging, 100).run({ kind: 'hash', bytes: new Uint8Array([1]) })).rejects.toThrow('EXTENSION_PACKAGE_TIMEOUT')
  const crash = join(root, 'crash-worker.mjs')
  await writeFile(crash, 'throw new Error("fixture failure")')
  const runner = new ExtensionPackageWorker(crash)
  await expect(runner.run({ kind: 'hash', bytes: new Uint8Array([1]) })).rejects.toThrow('EXTENSION_PACKAGE_WORKER_FAILED')
  await writeFile(crash, 'import { parentPort } from "node:worker_threads"; parentPort.once("message", () => parentPort.postMessage({ kind: "result", value: "recovered" }))')
  expect(await runner.run({ kind: 'hash', bytes: new Uint8Array([1]) })).toBe('recovered')
})
