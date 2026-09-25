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
  const capability = createPluginAuthoringCapability({ conversationId: 'task', cwd: root, executionProfile: 'workspace_write', getRunId: () => 'run', grants: [{ kind: 'workspace', canonicalRoot: root, root, grantId: 'workspace' }], sessionMode: 'interactive', signal: new AbortController().signal }, {
    request: async (_method, input, _timeout, signal) => buildExtensionPackage(input, async (files, manifest, _signal, report) => compileExtensionSource(files, manifest, report), signal!),
    notify: (_method, input) => {
      notifications.push(input)
    },
  })
  await capability.extension.factory({ registerTool(value: ToolDefinition) {
    tool = value
  }, on() {} } as never)
  return {
    root,
    source,
    notifications,
    capability,
    execute: async (input: unknown) => await tool!.execute('call', input as never, undefined, undefined, {} as never) as { details: { ok: boolean, code?: string, packagePath?: string, installed?: boolean, runtimeTested?: boolean } },
  }
}

it('writes an authorized installable output and requests review without installing', async () => {
  const f = await fixture()
  const output = join(f.root, 'example.lexora-extension')
  const result = await f.execute({ source: 'source', output: 'example.lexora-extension', review: true })
  expect(result.details).toMatchObject({ ok: true, packagePath: output, installation: 'review_requested', runtimeTested: false })
  expect(unpackExtension(await readFile(output)).has('view.js')).toBe(true)
  expect(f.notifications).toEqual([{ path: output }])
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
