import { Buffer } from 'node:buffer'
import { strToU8, zipSync } from 'fflate'
import { expect, it } from 'vitest'
import { addedExtensionPermissions, extensionManifestSchema } from '../../../shared/extensions/extensionManifest'
import { buildExtensionPackage } from '../buildExtensionPackage'
import { compileExtensionSource } from '../compileExtensionSource'
import { unpackExtension } from '../extensionFiles'

const manifest = {
  schemaVersion: 1,
  format: 'source',
  apiVersion: 1,
  id: 'local.confetti',
  name: 'Confetti',
  version: '1.0.0',
  engines: { lexora: '^0.7.3' },
  permissions: { windowEffects: true },
  contributes: { views: [{ id: 'local.confetti.effect', title: 'Confetti', entry: 'view.ts', resource: 'none', location: 'window-overlay' }] },
}
const source = 'export function render(context: unknown, container: HTMLElement) { container.textContent = "ready" }'
function input(files: Record<string, string> = {}) {
  return { archive: Buffer.from(zipSync(Object.fromEntries(Object.entries({ 'extension.json': JSON.stringify(manifest), 'view.ts': source, ...files }).map(([key, value]) => [key, strToU8(value)])))).toString('base64') }
}
const compile = async (...args: Parameters<typeof compileExtensionSource>) => compileExtensionSource(...args)
const build = (files?: Record<string, string>) => buildExtensionPackage(input(files), (files, manifest, _signal, report) => compile(files, manifest, report), new AbortController().signal)

it('produces a compiled installable archive without executing source code', async () => {
  const result = await build({ 'view.ts': `throw new Error('must not execute');\n${source}` })
  expect(result.ok).toBe(true)
  if (!result.ok)
    throw new Error(result.code)
  const files = unpackExtension(Buffer.from(result.archive, 'base64'))
  const compiled = JSON.parse(new TextDecoder().decode(files.get('extension.json')))
  expect(compiled.format).toBe('compiled')
  expect(compiled.contributes.views[0].entry).toBe('view.js')
  expect(new TextDecoder().decode(files.get('view.js'))).not.toContain('context: unknown')
})

it('returns actionable syntax diagnostics and rejects missing entries and dependencies', async () => {
  const syntax = await build({ 'view.ts': 'export function render( {' })
  expect(syntax.ok).toBe(false)
  expect(syntax.diagnostics.some(message => /view.ts:\d+:\d+ TS\d+/.test(message))).toBe(true)
  expect(await build({ 'view.ts': 'import secret from "node:fs"; export const render = secret' })).toMatchObject({ ok: false, code: 'EXTENSION_SOURCE_IMPORT_DENIED' })
  expect(await build({ 'extension.json': JSON.stringify({ ...manifest, entry: 'missing.ts' }) })).toMatchObject({ ok: false, code: 'EXTENSION_ENTRY_MISSING', diagnostics: ['Missing file: missing.ts'] })
})

it('requires explicit permission for overlays including updates from old manifests', () => {
  const old = extensionManifestSchema.parse({ ...manifest, permissions: {}, contributes: {} })
  const next = extensionManifestSchema.parse(manifest)
  expect(addedExtensionPermissions(old.permissions, next.permissions)).toEqual(['windowEffects'])
  expect(extensionManifestSchema.safeParse({ ...manifest, permissions: {} }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...manifest, contributes: { views: [{ ...manifest.contributes.views[0], resource: 'selected-file' }] }, permissions: { windowEffects: true, selectedResource: 'read' } }).success).toBe(false)
})

it('preserves cancellation rather than turning it into a build failure', async () => {
  await expect(buildExtensionPackage(input(), async () => new Map(), AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
})
