import { strToU8 } from 'fflate'
import { expect, it } from 'vitest'
import { compileExtensionSource } from '../compileExtensionSource'
import { completeExtensionCompilation, prepareExtensionCompilation } from '../extensionCompilation'
import { manifest } from './fixtures'

it('keeps binary assets out of compiler IPC while retaining HTML class scanning and original assets', async () => {
  const source = manifest({ format: 'source', entry: 'extension.ts', styles: { uno: true }, contributes: { commands: [], views: [] } })
  const binary = new Uint8Array(1024)
  binary[0] = 7
  const files = new Map([['extension.json', strToU8(JSON.stringify(source))], ['extension.ts', strToU8('export const answer: number = 42')], ['module.wasm', binary], ['page.html', strToU8('<div class="flex">original</div>')]])
  const prepared = prepareExtensionCompilation(files, source)
  expect([...prepared.input.values()].reduce((total, bytes) => total + bytes.length, 0)).toBeLessThan(1024)
  const compiled = await compileExtensionSource(prepared.input, source, () => {})
  const complete = completeExtensionCompilation(prepared, compiled, source)
  expect(complete.get('module.wasm')).toEqual(binary)
  expect(new TextDecoder().decode(complete.get('page.html'))).toBe('<div class="flex">original</div>')
  expect(new TextDecoder().decode(complete.get('lexora-uno.css'))).toContain('display:flex')
})

it('rejects compiler path and manifest changes and changed retained assets', async () => {
  const source = manifest({ format: 'source', entry: 'extension.ts', contributes: { commands: [], views: [] } })
  const binary = new Uint8Array([0, 1, 2])
  const files = new Map([['extension.json', strToU8(JSON.stringify(source))], ['extension.ts', strToU8('export const answer = 42')], ['module.wasm', binary]])
  const prepared = prepareExtensionCompilation(files, source)
  const compiled = await compileExtensionSource(prepared.input, source, () => {})
  expect(() => completeExtensionCompilation(prepared, new Map([...compiled, ['unexpected.js', new Uint8Array()]]), source)).toThrow('EXTENSION_COMPILE_OUTPUT_INVALID')
  const changed = JSON.parse(new TextDecoder().decode(compiled.get('extension.json')))
  changed.permissions.notifications = true
  expect(() => completeExtensionCompilation(prepared, new Map([...compiled, ['extension.json', strToU8(JSON.stringify(changed))]]), source)).toThrow('EXTENSION_COMPILE_OUTPUT_INVALID')
  expect(() => completeExtensionCompilation(prepared, new Map([...compiled, ['module.wasm', new Uint8Array([4])]]), source)).toThrow('EXTENSION_COMPILE_OUTPUT_INVALID')
  prepared.retained.get('module.wasm')!.bytes[0] = 9
  expect(() => completeExtensionCompilation(prepared, compiled, source)).toThrow('EXTENSION_COMPILE_OUTPUT_INVALID')
})
