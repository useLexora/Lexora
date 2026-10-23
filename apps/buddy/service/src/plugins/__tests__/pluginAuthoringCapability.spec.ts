import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { compileExtensionSource } from '../../../../platform/extensions/compileExtensionSource'
import { unpackExtension } from '../../../../platform/extensions/extensionFiles'
import { ExtensionPackageTransfer } from '../../../../platform/extensions/ExtensionPackageTransfer'
import { createPluginAuthoringCapability } from '../pluginAuthoringCapability'
import { PluginAuthoringService } from '../PluginAuthoringService'

const roots: string[] = []
const transfers: ExtensionPackageTransfer[] = []
afterEach(async () => {
  await Promise.all(transfers.splice(0).map(transfer => transfer.dispose()))
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-plugin-author-'))
  roots.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(join(source, 'extension.json'), JSON.stringify({ schemaVersion: 1, format: 'source', apiVersion: 1, id: 'local.example', name: 'Example', version: '1.0.0', author: '山雨海', engines: { lexora: '>=0.9.0 <1' }, contributes: { views: [{ id: 'local.example.page', title: 'Page', entry: 'view.ts', resource: 'none', location: 'page' }] } }))
  await writeFile(join(source, 'view.ts'), 'export function render(_context: unknown, container: HTMLElement) { container.textContent = "Hello" }')
  const notifications: unknown[] = []
  let tool: ToolDefinition | undefined
  let rejectReview = false
  let corruptDownload = false
  let beforeDownload: (() => Promise<void>) | undefined
  const transfer = new ExtensionPackageTransfer(async (files, manifest, _signal, report) => compileExtensionSource(files, manifest, report))
  transfers.push(transfer)
  const peer = {
    request: async (_method: string, input: unknown, _timeout?: number | null, signal?: AbortSignal) => {
      const result = await transfer.request(input, signal)
      if (result && typeof result === 'object' && 'data' in result) {
        const before = beforeDownload
        beforeDownload = undefined
        await before?.()
      }
      if (corruptDownload && result && typeof result === 'object' && 'data' in result && typeof result.data === 'string') {
        const bytes = Buffer.from(result.data, 'base64')
        bytes[0] ^= 1
        return { ...result, data: bytes.toString('base64') }
      }
      return result
    },
    notify: (_method: string, input: unknown) => {
      if (rejectReview)
        throw new Error('fixture-private-review-failure')
      notifications.push(input)
    },
  }
  const builder = new PluginAuthoringService(peer)
  const facts: unknown[] = []
  builder.onDidChange(event => facts.push(event))
  const capability = createPluginAuthoringCapability({ conversationId: 'task', cwd: root, executionProfile: 'workspace_write', getRunId: () => 'run', grants: [{ kind: 'workspace', canonicalRoot: root, root, grantId: 'workspace' }], sessionMode: 'interactive', signal: new AbortController().signal }, peer, builder)
  await capability.extension.factory({ registerTool(value: ToolDefinition) {
    if (value.name === 'lexora_plugin_build')
      tool = value
  }, on() {} } as never)
  return {
    root,
    source,
    notifications,
    capability,
    facts,
    rejectReview: () => { rejectReview = true },
    corruptDownload: () => { corruptDownload = true },
    beforeDownload: (callback: () => Promise<void>) => { beforeDownload = callback },
    execute: async (input: unknown) => await tool!.execute('call', input as never, undefined, undefined, {} as never) as { details: { ok: boolean, code?: string, packagePath?: string, installed?: boolean, runtimeTested?: boolean } },
  }
}

it('preserves package identity and signature and requests review without installing', async () => {
  const f = await fixture()
  const output = join(f.root, 'example.lexora-extension')
  const result = await f.execute({ source: 'source', output: 'example.lexora-extension', review: true })
  expect(result.details).toMatchObject({ ok: true, id: 'local.example', name: 'Example', author: '山雨海', version: '1.0.0', packagePath: output, installation: 'review_requested', runtimeTested: false })
  const files = unpackExtension(await readFile(output))
  expect(files.has('view.js')).toBe(true)
  expect(JSON.parse(new TextDecoder().decode(files.get('extension.json')))).toMatchObject({ id: 'local.example', author: '山雨海' })
  expect(f.notifications).toEqual([{ path: output }])
})

it('keeps the committed package and reports review failure separately when notification fails', async () => {
  const f = await fixture()
  f.rejectReview()
  const result = await f.execute({ source: 'source', output: 'example.lexora-extension', review: true })
  expect(result.details).toMatchObject({ ok: true, installation: 'review_failed', reviewRequested: false, reviewError: 'EXTENSION_REVIEW_REQUEST_FAILED' })
  expect(unpackExtension(await readFile(join(f.root, 'example.lexora-extension'))).has('view.js')).toBe(true)
  expect(f.facts).toMatchObject([{ kind: 'package-written', extensionId: 'local.example' }, { kind: 'review-failed', extensionId: 'local.example', errorCode: 'EXTENSION_REVIEW_REQUEST_FAILED' }])
  expect(JSON.stringify(f.facts)).not.toMatch(/fixture-private|packagePath|example\.lexora-extension/)
})

it('rejects output outside grants or inside source', async () => {
  const f = await fixture()
  expect((await f.execute({ source: 'source', output: '../outside.lexora-extension' })).details).toMatchObject({ ok: false, code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
  expect((await f.execute({ source: 'source', output: 'source/nested.lexora-extension' })).details).toMatchObject({ ok: false, code: 'EXTENSION_OUTPUT_INVALID' })
  expect(f.notifications).toEqual([])
})

it('rejects symlinked source files instead of packaging unrelated user data', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'private.txt'), Buffer.from('do not package'))
  await symlink(join(f.root, 'private.txt'), join(f.source, 'linked.txt'))
  expect((await f.execute({ source: 'source', output: 'bad.lexora-extension', review: true })).details).toMatchObject({ ok: false, code: 'EXTENSION_UNSAFE_PATH' })
  expect(f.notifications).toEqual([])
})

it('removes an unverified output and never requests its installation review', async () => {
  const f = await fixture()
  f.corruptDownload()
  expect((await f.execute({ source: 'source', output: 'corrupt.lexora-extension', review: true })).details).toMatchObject({ ok: false, code: 'EXTENSION_TRANSFER_CHECKSUM_FAILED' })
  await expect(readFile(join(f.root, 'corrupt.lexora-extension'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.notifications).toEqual([])
  expect(f.facts).toEqual([])
})

it.each([false, true])('never publishes partial data or removes a concurrent output, corrupt=%s', async (corrupt) => {
  const f = await fixture()
  const output = join(f.root, 'concurrent.lexora-extension')
  f.beforeDownload(async () => {
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(output, 'concurrent user content', { flag: 'wx' })
  })
  if (corrupt)
    f.corruptDownload()
  expect((await f.execute({ source: 'source', output, review: true })).details).toMatchObject({ ok: false, code: corrupt ? 'EXTENSION_TRANSFER_CHECKSUM_FAILED' : 'EEXIST' })
  expect(await readFile(output, 'utf8')).toBe('concurrent user content')
  expect((await readdir(f.root)).sort()).toEqual(['concurrent.lexora-extension', 'source'])
  expect(f.notifications).toEqual([])
  expect(f.facts).toEqual([])
})
