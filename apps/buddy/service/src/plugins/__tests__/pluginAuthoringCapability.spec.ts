import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { buildExtensionPackage } from '../../../../platform/extensions/buildExtensionPackage'
import { compileExtensionSource } from '../../../../platform/extensions/compileExtensionSource'
import { unpackExtension } from '../../../../platform/extensions/extensionFiles'
import { createPluginAuthoringCapability } from '../pluginAuthoringCapability'
import { PluginAuthoringService } from '../PluginAuthoringService'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-plugin-author-'))
  roots.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(join(source, 'extension.json'), JSON.stringify({ schemaVersion: 1, format: 'source', apiVersion: 1, id: 'local.example', name: 'Example', version: '1.0.0', engines: { lexora: '^0.7.3' }, contributes: { views: [{ id: 'local.example.page', title: 'Page', entry: 'view.ts', resource: 'none', location: 'page' }] } }))
  await writeFile(join(source, 'view.ts'), 'export function render(_context: unknown, container: HTMLElement) { container.textContent = "Hello" }')
  const notifications: unknown[] = []
  let tool: ToolDefinition | undefined
  let identityTool: ToolDefinition | undefined
  let rejectReview = false
  const peer = {
    request: async (_method: string, input: unknown, _timeout?: number | null, signal?: AbortSignal) => buildExtensionPackage(input, async (files, manifest, _signal, report) => compileExtensionSource(files, manifest, report), signal!),
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
    tool = value
    if (value.name === 'lexora_plugin_identity')
      identityTool = value
  }, on() {} } as never)
  return {
    root,
    source,
    notifications,
    capability,
    facts,
    rejectReview: () => { rejectReview = true },
    identity: async (input: unknown) => await identityTool!.execute('identity', input as never, undefined, undefined, {} as never),
    execute: async (input: unknown) => await tool!.execute('call', input as never, undefined, undefined, {} as never) as { details: { ok: boolean, code?: string, packagePath?: string, installed?: boolean, runtimeTested?: boolean } },
  }
}

it('writes an authorized installable output and requests review without installing', async () => {
  const f = await fixture()
  const output = join(f.root, 'example.lexora-extension')
  const result = await f.execute({ source: 'source', output: 'example.lexora-extension', review: true })
  expect(result.details).toMatchObject({ ok: true, id: 'local.example', name: 'Example', author: '', version: '1.0.0', packagePath: output, installation: 'review_requested', runtimeTested: false })
  expect(unpackExtension(await readFile(output)).has('view.js')).toBe(true)
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

it('preserves existing files and rejects output outside grants or inside source', async () => {
  const f = await fixture()
  const output = join(f.root, 'existing.lexora-extension')
  await writeFile(output, 'keep')
  expect((await f.execute({ source: 'source', output })).details).toMatchObject({ ok: false, code: 'EEXIST' })
  expect(await readFile(output, 'utf8')).toBe('keep')
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

it('reports invalid author fields and asks for a user choice without substituting an identity', async () => {
  const f = await fixture()
  const result = await f.identity({ slug: 'music', author: '名'.repeat(81) })
  expect(result.details).toMatchObject({ ok: false, code: 'EXTENSION_IDENTITY_INVALID', diagnostics: [expect.stringContaining('author:')], nextAction: expect.stringContaining('ask the user') })
  expect(result.details).not.toHaveProperty('id')
})

it('returns the explicit signature and keeps the existing identity when rebuilding', async () => {
  const f = await fixture()
  const manifestPath = join(f.source, 'extension.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, author: '山雨海', engines: { lexora: '>=0.9.0 <1' } }))
  const result = await f.execute({ source: 'source', output: 'signed.lexora-extension' })
  expect(result.details).toMatchObject({ ok: true, id: 'local.example', name: 'Example', author: '山雨海', version: '1.0.0' })
  const files = unpackExtension(await readFile(join(f.root, 'signed.lexora-extension')))
  expect(JSON.parse(new TextDecoder().decode(files.get('extension.json')))).toMatchObject({ id: 'local.example', author: '山雨海' })
})
