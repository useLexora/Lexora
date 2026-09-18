import { expect, it } from 'vitest'
import { extensionManifestSchema } from '../../../shared/extensions/extensionManifest'
import { compileExtensionSource } from '../compileExtensionSource'

const manifest = extensionManifestSchema.parse({ schemaVersion: 1, format: 'source', id: 'tests.source', name: 'Source', version: '1.0.0', apiVersion: 1, engines: { lexora: '^0.7.3' }, entry: 'extension.ts', contributes: { commands: [], views: [] } })
const encode = (files: Record<string, string>) => new Map(Object.entries(files).map(([name, text]) => [name, new TextEncoder().encode(text)]))
const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes)

it('compiles package-local modules without executing source or build scripts', () => {
  const files = encode({ 'extension.ts': 'import type { Missing } from "../../outside"; import { value } from "./helper.ts"; throw new Error("Must not execute"); export const answer: number = value', 'helper.ts': 'export const value: number = 42', 'package.json': '{"scripts":{"install":"exit 99"}}' })
  const output = compileExtensionSource(files, manifest, () => {})
  expect(decode(output.get('extension.js'))).toContain('from "./helper.js"')
  expect(decode(output.get('extension.js'))).not.toContain('outside')
  expect(JSON.parse(decode(output.get('extension.json')))).toMatchObject({ id: manifest.id, format: 'compiled', entry: 'extension.js' })
})

it.each(['import "node:fs"', 'import "npm-library"', 'import "../../outside.js"', 'import(globalThis.path)'])('rejects imports outside the package: %s', (text) => {
  expect(() => compileExtensionSource(encode({ 'extension.ts': text }), manifest, () => {})).toThrow('EXTENSION_SOURCE_IMPORT_DENIED')
})

it('reports relative file, line and diagnostic for invalid TypeScript', () => {
  const logs: string[] = []
  expect(() => compileExtensionSource(encode({ 'extension.ts': 'export const invalid: = 3' }), manifest, text => logs.push(text))).toThrow('EXTENSION_SOURCE_COMPILE_FAILED')
  expect(logs.some(line => /extension.ts:1:\d+ TS\d+:/.test(line))).toBe(true)
})

it('rejects colliding JS and TS output paths', () => {
  expect(() => compileExtensionSource(encode({ 'extension.ts': '', 'extension.js': '' }), manifest, () => {})).toThrow('EXTENSION_SOURCE_OUTPUT_COLLISION')
})
