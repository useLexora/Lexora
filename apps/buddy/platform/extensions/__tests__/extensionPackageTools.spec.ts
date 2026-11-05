import type { buildExtensionDirectory, packExtensionDirectory } from '../extensionPackageAuthoring'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { unpackExtension } from '../extensionFiles'
import { manifest } from './fixtures'

const roots: string[] = []
const run = promisify(execFile)
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each(['compiled', 'source'] as const)('preserves package resources through exported SDK %s builds and packaging', async (format) => {
  const parent = resolve('.output')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'extension-build-spec-'))
  roots.push(root)
  const source = join(root, 'source')
  const sdk = join(root, 'sdk')
  const suffix = format === 'source' ? 'ts' : 'mjs'
  const files = new Map([
    [`extension.${suffix}`, Buffer.from('export function activate(context) { return context.workers.create("workers/compute.js") }')],
    [`view.${suffix}`, Buffer.from('export function render() {}')],
    [`workers/compute.${format === 'source' ? 'ts' : 'js'}`, Buffer.from('self.onmessage = () => postMessage(42)')],
    ['workers/dependency.mjs', Buffer.from('export const value = 42')],
    ['workers/engine.wasm', Buffer.from([0, 127, 128, 255])],
    ['native/chat.mjs', Buffer.from('import { readFile } from "node:fs/promises"; export const read = readFile')],
    ['data/sample.bin', Buffer.from([255, 128, 127, 0])],
    ['LICENSE', Buffer.from('Fixture license')],
  ])
  for (const [name, bytes] of files) {
    await mkdir(join(source, name, '..'), { recursive: true })
    await writeFile(join(source, name), bytes)
  }
  await writeFile(join(source, 'extension.json'), JSON.stringify(manifest({ format, apiVersion: 4, permissions: { inference: true, selectedResource: 'read' }, engines: { lexora: '*' }, entry: `extension.${suffix}`, contributes: { inference: { runtimes: [{ id: 'chat', entry: 'native/chat.mjs', platforms: ['linux-x64'] }], capabilities: [{ id: 'chat', title: 'Chat', kind: 'chat.completion', runtime: 'chat' }] }, commands: [], views: [{ id: 'tests.reader.view', title: 'Reader', entry: `view.${suffix}` }] } })))
  await run(process.execPath, ['extensions/tools.mjs', 'export-sdk', sdk])
  const plugin = await import(pathToFileURL(join(sdk, 'plugin.mjs')).href) as { buildPlugin: typeof buildExtensionDirectory, packPlugin: typeof packExtensionDirectory }
  const sdkOutput = join(root, 'sdk-output')
  await plugin.buildPlugin(source, sdkOutput)
  const sdkPackage = join(root, 'sdk.lexora-extension')
  await plugin.packPlugin(sdkOutput, sdkPackage)
  const packaged = unpackExtension(await readFile(sdkPackage))
  expect([...packaged.keys()].sort()).toEqual(['extension.json', ...[...files.keys()].map(name => name.replace(/\.ts$/, '.js'))].sort())
  for (const [name, bytes] of files) {
    if (format === 'compiled' || name.startsWith('native/') || !/\.(?:ts|mjs)$/.test(name))
      expect(packaged.get(name)).toEqual(new Uint8Array(bytes))
  }
  const built = JSON.parse(new TextDecoder().decode(packaged.get('extension.json')))
  expect(built).toMatchObject({ format: 'compiled', entry: `extension.${format === 'source' ? 'js' : 'mjs'}` })
}, 60000)
