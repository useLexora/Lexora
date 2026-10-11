import { expect, it } from 'vitest'
import { extensionManifestSchema } from '../../../shared/extensions/extensionManifest'
import { compileExtensionSource } from '../compileExtensionSource'

const manifest = extensionManifestSchema.parse({ schemaVersion: 1, format: 'source', id: 'tests.source', name: 'Source', version: '1.0.0', apiVersion: 1, engines: { lexora: '^0.7.3' }, entry: 'extension.ts', contributes: { commands: [], views: [] } })
const encode = (files: Record<string, string>) => new Map(Object.entries(files).map(([name, text]) => [name, new TextEncoder().encode(text)]))
const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes)

it('compiles package-local modules without executing source or build scripts', async () => {
  const files = encode({ 'extension.ts': 'import type { Missing } from "../../outside"; import { value } from "./helper.ts"; throw new Error("Must not execute"); export const answer: number = value', 'helper.ts': 'export const value: number = 42', 'package.json': '{"scripts":{"install":"exit 99"}}' })
  const output = await compileExtensionSource(files, manifest, () => {})
  expect(decode(output.get('extension.js'))).toContain('from "./helper.js"')
  expect(decode(output.get('extension.js'))).not.toContain('outside')
  expect(JSON.parse(decode(output.get('extension.json')))).toMatchObject({ id: manifest.id, format: 'compiled', entry: 'extension.js' })
})

it.each(['import "node:fs"', 'import "npm-library"', 'import "../../outside.js"', 'import(globalThis.path)'])('rejects imports outside the package: %s', async (text) => {
  await expect(compileExtensionSource(encode({ 'extension.ts': text }), manifest, () => {})).rejects.toThrow('EXTENSION_SOURCE_IMPORT_DENIED')
})

it('rejects colliding JS and TS output paths', async () => {
  await expect(compileExtensionSource(encode({ 'extension.ts': '', 'extension.js': '' }), manifest, () => {})).rejects.toThrow('EXTENSION_SOURCE_OUTPUT_COLLISION')
})

it('builds portable semantic CSS from literal classes and a bounded safelist without running plugin configuration', async () => {
  const source = extensionManifestSchema.parse({ ...manifest, styles: { uno: true, safelist: ['grid-cols-3'] } })
  const output = await compileExtensionSource(encode({
    'extension.ts': 'export const classes = "flex gap-2 bg-accent text-on-accent hover:bg-accent-hover"',
    'uno.config.ts': 'throw new Error("Do not execute plugin configuration")',
  }), source, () => {})
  const css = decode(output.get('lexora-uno.css'))
  expect(css).toContain('display:flex')
  expect(css).toContain('grid-template-columns:repeat(3,minmax(0,1fr))')
  expect(css).toContain('var(--lexora-accent-solid)')
  expect(css).toContain('var(--lexora-on-accent)')
  expect(css).toContain('var(--lexora-accent-hover)')
  expect(css).not.toContain('--buddy-')
  expect(extensionManifestSchema.parse(JSON.parse(decode(output.get('extension.json')))).styles).toEqual(source.styles)
  await expect(compileExtensionSource(encode({ 'lexora-uno.css': '' }), source, () => {})).rejects.toThrow('EXTENSION_SOURCE_OUTPUT_COLLISION')
})
