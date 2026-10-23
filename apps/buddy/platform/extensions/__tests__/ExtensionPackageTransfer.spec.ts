import type { ExtensionCompiler } from '../compileExtensionSource'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'
import { extensionTransferChunkSchema, extensionTransferOffsetSchema, extensionTransferredBuildResultSchema, extensionTransferSessionSchema } from '../../../shared/extensions/extensionAuthoring'
import { EXTENSION_PACKAGE_CHUNK_BASE64_LENGTH, EXTENSION_PACKAGE_CHUNK_BYTES } from '../../../shared/extensions/extensionPackageBudget'
import { compileExtensionSource } from '../compileExtensionSource'
import { sha256, unpackExtension } from '../extensionFiles'
import { EXTENSION_TRANSFER_IDLE_MS, ExtensionPackageTransfer } from '../ExtensionPackageTransfer'
import { manifest } from './fixtures'

const servers: ExtensionPackageTransfer[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(servers.splice(0).map(server => server.dispose()))
})
function server(compile: ExtensionCompiler = async (files, manifest, _signal, report) => compileExtensionSource(files, manifest, report)) {
  const server = new ExtensionPackageTransfer(compile)
  servers.push(server)
  return server
}
const archive = () => zipSync({ 'extension.json': strToU8(JSON.stringify(manifest())), 'extension.js': strToU8('export function activate() {}'), 'view.js': strToU8('export function render() {}') })
async function begin(service: ExtensionPackageTransfer, bytes: Uint8Array, hash = sha256(bytes)) {
  return extensionTransferSessionSchema.parse(await service.request({ action: 'begin', size: bytes.length, sha256: hash })).transferId
}
async function upload(service: ExtensionPackageTransfer, transferId: string, bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length; offset += EXTENSION_PACKAGE_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + EXTENSION_PACKAGE_CHUNK_BYTES)
    const result = extensionTransferOffsetSchema.parse(await service.request({ action: 'upload', transferId, offset, data: Buffer.from(chunk).toString('base64') }))
    expect(result.offset).toBe(offset + chunk.length)
  }
}

it('transports a package across bounded acknowledged frames and invalidates it on runtime disposal', async () => {
  const service = server()
  const binary = randomBytes(EXTENSION_PACKAGE_CHUNK_BYTES + 1)
  const bytes = zipSync({ ...Object.fromEntries(unpackExtension(archive())), 'module.wasm': binary })
  const id = await begin(service, bytes)
  await upload(service, id, bytes)
  const built = extensionTransferredBuildResultSchema.parse(await service.request({ action: 'build', transferId: id }))
  expect(built.ok).toBe(true)
  if (!built.ok)
    throw new Error(built.code)
  expect(built.package.size).toBeGreaterThan(EXTENSION_PACKAGE_CHUNK_BYTES)
  const chunks: Buffer[] = []
  let offset = 0
  while (offset < built.package.size) {
    const chunk = extensionTransferChunkSchema.parse(await service.request({ action: 'read', transferId: id, offset }))
    expect(chunk.data.length).toBeLessThanOrEqual(EXTENSION_PACKAGE_CHUNK_BASE64_LENGTH)
    const bytes = Buffer.from(chunk.data, 'base64')
    expect(bytes.length).toBeLessThanOrEqual(EXTENSION_PACKAGE_CHUNK_BYTES)
    expect(chunk.offset).toBe(offset + bytes.length)
    chunks.push(bytes)
    offset = chunk.offset
  }
  const result = Buffer.concat(chunks)
  expect(sha256(result)).toBe(built.package.sha256)
  expect(sha256(unpackExtension(result).get('module.wasm')!)).toBe(sha256(binary))
  await service.request({ action: 'dispose', transferId: id })
  await expect(service.request({ action: 'read', transferId: id, offset: 0 })).rejects.toThrow('EXTENSION_TRANSFER_UNAVAILABLE')
  const owned = await begin(service, archive())
  await service.dispose()
  await expect(service.request({ action: 'read', transferId: owned, offset: 0 })).rejects.toThrow()
  await expect(begin(service, bytes)).rejects.toThrow()
})

it('isolates peer ownership and rejects uncommitted, out-of-order or checksum-mismatched uploads', async () => {
  const service = server()
  const other = server()
  const bytes = archive()
  const id = await begin(service, bytes)
  await expect(other.request({ action: 'read', transferId: id, offset: 0 })).rejects.toThrow('EXTENSION_TRANSFER_UNAVAILABLE')
  await expect(service.request({ action: 'build', transferId: id })).rejects.toThrow('EXTENSION_TRANSFER_INCOMPLETE')
  await expect(service.request({ action: 'upload', transferId: id, offset: 0, data: Buffer.from(bytes).toString('base64') })).rejects.toThrow('EXTENSION_TRANSFER_UNAVAILABLE')
  const unordered = await begin(service, bytes)
  await expect(service.request({ action: 'upload', transferId: unordered, offset: 1, data: 'YQ==' })).rejects.toThrow('EXTENSION_TRANSFER_ORDER')
  const tampered = await begin(service, bytes, '0'.repeat(64))
  await upload(service, tampered, bytes)
  await expect(service.request({ action: 'build', transferId: tampered })).rejects.toThrow('EXTENSION_TRANSFER_CHECKSUM_FAILED')
  const unreadable = await begin(service, bytes)
  await expect(service.request({ action: 'read', transferId: unreadable, offset: 0 })).rejects.toThrow('EXTENSION_TRANSFER_ORDER')
})

it('enforces frame and transfer counts, and releases idle sessions', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const service = server()
  const bytes = archive()
  const first = await begin(service, bytes)
  const second = await begin(service, bytes)
  await expect(begin(service, bytes)).rejects.toThrow('EXTENSION_TRANSFER_LIMIT')
  await expect(service.request({ action: 'upload', transferId: first, offset: 0, data: Buffer.alloc(EXTENSION_PACKAGE_CHUNK_BYTES + 1).toString('base64') })).rejects.toThrow()
  await service.request({ action: 'dispose', transferId: first })
  await vi.advanceTimersByTimeAsync(EXTENSION_TRANSFER_IDLE_MS + 1)
  await expect(service.request({ action: 'build', transferId: second })).rejects.toThrow('EXTENSION_TRANSFER_UNAVAILABLE')
  await expect(begin(service, bytes)).resolves.toMatch(/^[a-f0-9-]{36}$/)
})

it('cancels running compilation, removes the session and admits another build', async () => {
  let started!: () => void
  const began = new Promise<void>(resolve => started = resolve)
  const service = server(async (_files, _manifest, signal) => {
    started()
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('EXTENSION_INSTALL_CANCELLED')), { once: true }))
    throw new Error('unreachable')
  })
  const bytes = zipSync({ 'extension.json': strToU8(JSON.stringify(manifest({ format: 'source', entry: 'extension.ts', contributes: { commands: [], views: [] } }))), 'extension.ts': strToU8('export const answer = 42') })
  const id = await begin(service, bytes)
  await upload(service, id, bytes)
  const abort = new AbortController()
  const building = service.request({ action: 'build', transferId: id }, abort.signal)
  const rejected = expect(building).rejects.toThrow()
  await began
  abort.abort()
  await rejected
  await expect(service.request({ action: 'read', transferId: id, offset: 0 })).rejects.toThrow('EXTENSION_TRANSFER_UNAVAILABLE')
  await expect(begin(service, bytes)).resolves.toMatch(/^[a-f0-9-]{36}$/)
})
