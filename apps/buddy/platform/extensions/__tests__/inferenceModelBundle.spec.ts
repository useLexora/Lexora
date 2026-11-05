import type { InferencePrepare } from '../../../shared/extensions/extensionInference'
import type { InferenceResourceSource } from '../ExtensionInferenceResources'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { inferencePrepareSchema } from '../../../shared/extensions/extensionInference'
import { ExtensionInferenceResources } from '../ExtensionInferenceResources'

const roots: string[] = []
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-model-preparation-'))
  roots.push(root)
  const bytes = Buffer.from('private-fixture-model')
  const input: InferencePrepare = { id: 'model', kind: 'model', files: [], preparation: { inputs: [{ id: 'bundle', sha256: digest(bytes), size: bytes.length, source: { url: 'https://example.test/model' } }], options: {}, maxBytes: 1024, maxFiles: 4 } }
  const store = new ExtensionInferenceResources(join(root, 'store'))
  const source: InferenceResourceSource = {
    response: async () => new Response(bytes),
    openReference: async () => { throw new Error('No file references') },
    prepare: async (inputs, _options, signal, emit) => {
      const data = await inputs[0]!.handle.readFile()
      await emit({ type: 'file', path: 'model.onnx', size: data.length }, new Uint8Array(), signal)
      await emit({ type: 'chunk' }, data, signal)
      await emit({ type: 'end', sha256: digest(data) }, new Uint8Array(), signal)
      await emit({ type: 'alias', path: 'alias.onnx', target: 'model.onnx' }, new Uint8Array(), signal)
    },
  }
  return { store, input, source, files: join(root, 'store', 'inference', 'example.models', 'files') }
}
it('publishes verified plugin output and aliases and reopens the exact bytes', async () => {
  const { store, input, source } = await fixture()
  const signal = new AbortController().signal
  const result = await store.prepare('example.models', input, source, signal, () => {})
  expect(result.files).toBe(2)
  const lease = await store.acquire('example.models', result, source, signal)
  try {
    expect(await Promise.all(lease.files.map(async file => [file.path, await file.handle.readFile('utf8')]))).toEqual([['alias.onnx', 'private-fixture-model'], ['model.onnx', 'private-fixture-model']])
  }
  finally { await lease.release() }
})
it.each(['path', 'collision', 'size', 'hash', 'incomplete', 'cancel', 'failed', 'executable'])('rejects %s output and preserves the previous revision', async (failure) => {
  const { store, input, source, files } = await fixture()
  const controller = new AbortController()
  const previous = await store.prepare('example.models', input, source, controller.signal, () => {})
  const previousFiles = await readdir(files)
  source.prepare = async (_inputs, _options, signal, emit) => {
    const event = (data: Parameters<typeof emit>[0], bytes = new Uint8Array()) => emit(data, bytes, signal)
    await event({ type: 'file', path: failure === 'path' ? '../escape' : 'new.bin', size: 3, ...(failure === 'executable' ? { executable: true } : {}) })
    await event({ type: 'chunk' }, Buffer.from(failure === 'size' ? 'long' : 'new'))
    if (failure === 'incomplete')
      return
    if (failure === 'cancel')
      controller.abort(new Error('PREPARATION_CANCELLED'))
    if (failure === 'failed')
      throw new Error('fixture failure')
    await event({ type: 'end', sha256: failure === 'hash' ? '0'.repeat(64) : digest(Buffer.from('new')) })
    if (failure === 'collision')
      await event({ type: 'file', path: 'NEW.bin/child', size: 0 })
  }
  const error = failure === 'hash' ? 'EXTENSION_INFERENCE_CHECKSUM_MISMATCH' : failure === 'incomplete' ? 'EXTENSION_INFERENCE_PREPARATION_INCOMPLETE' : failure === 'cancel' ? 'PREPARATION_CANCELLED' : undefined
  await expect(store.prepare('example.models', input, source, controller.signal, () => {})).rejects.toThrow(error)
  expect(await store.list('example.models')).toEqual([previous])
  expect(await readdir(files)).toEqual(previousFiles)
  const lease = await store.acquire('example.models', previous, source, new AbortController().signal)
  await lease.release()
})
it.each(['input', 'bytes', 'files'])('enforces %s integrity and limits', async (limit) => {
  const { store, input, source } = await fixture()
  if (limit === 'input')
    input.preparation!.inputs[0]!.sha256 = '0'.repeat(64)
  if (limit === 'bytes')
    input.preparation!.maxBytes = 1
  if (limit === 'files')
    input.preparation!.maxFiles = 1
  await expect(store.prepare('example.models', input, source, new AbortController().signal, () => {})).rejects.toThrow()
  expect(await store.list('example.models')).toEqual([])
})
it('requires a declared preparation runner and a single preparation mode', async () => {
  const { store, input, source } = await fixture()
  delete source.prepare
  await expect(store.prepare('example.models', input, source, new AbortController().signal, () => {})).rejects.toThrow('EXTENSION_INFERENCE_PREPARATION_UNAVAILABLE')
  expect(inferencePrepareSchema.safeParse({ ...input, files: [{ path: 'file', sha256: '0'.repeat(64), source: { url: 'https://example.test/file' } }] }).success).toBe(false)
})
