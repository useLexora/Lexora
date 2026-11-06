import type { InferenceResourceLease, InferenceResourceSource } from '../../../apps/buddy/platform/extensions/ExtensionInferenceResources'
import type { NativeInferenceOptions } from '../../../apps/buddy/platform/extensions/NativeInferenceProcess'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtensionPackageStore } from '../../../apps/buddy/platform/extensions/ExtensionPackageStore'
import { NativeInferenceProcess } from '../../../apps/buddy/platform/extensions/NativeInferenceProcess'
import { inferenceBindingSchema, inferenceLimits } from '../../../apps/buddy/shared/extensions/extensionInference'
import nativeEntry from './inference-smoke-native.mjs?raw'

export async function checkInferenceSmoke(options: NativeInferenceOptions & { appVersion: string }): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'lexora-inference-smoke-'))
  const signal = AbortSignal.timeout(15_000)
  const current = () => signal.throwIfAborted()
  const challenge = randomUUID()
  const store = new ExtensionPackageStore(root, options.appVersion)
  const manifest = {
    schemaVersion: 1,
    id: 'smoke.inference',
    name: 'Inference smoke',
    version: '1.0.0',
    apiVersion: 4,
    engines: { lexora: '*' },
    format: 'compiled',
    entry: 'extension.js',
    permissions: { inference: true },
    contributes: {
      inference: {
        runtimes: [{ id: 'echo', entry: 'native/echo.mjs', platforms: ['linux-x64', 'windows-x64', 'macos-arm64'] }],
        capabilities: [{ id: 'echo', title: 'Echo', kind: 'speech.transcribe', runtime: 'echo', streamingInput: true, streamingOutput: true }],
      },
    },
  }
  const source: InferenceResourceSource = {
    response: async () => new Response(challenge),
    openReference: async () => { throw new Error('Smoke must not open external resources') },
  }
  let lease: InferenceResourceLease | undefined
  let worker: NativeInferenceProcess | undefined
  try {
    const review = await store.reviewFiles(new Map([
      ['extension.json', Buffer.from(JSON.stringify(manifest))],
      ['extension.js', Buffer.from('export function activate() {}')],
      ['native/echo.mjs', Buffer.from(nativeEntry)],
    ]), false, null, signal)
    await store.install(review.token, signal)
    const pkg = store.installed[manifest.id]!.current
    const resource = await store.inference.prepare(manifest.id, {
      id: 'fixture',
      kind: 'model',
      files: [{ path: 'nested/payload.txt', sha256: createHash('sha256').update(challenge).digest('hex'), source: { resourceId: randomUUID(), reference: false } }],
    }, source, signal, current)
    lease = await store.inference.acquire(manifest.id, resource, source, signal)
    const binding = inferenceBindingSchema.parse({ runtime: 'echo', resources: [{ mount: 'fixture', id: resource.id, revision: resource.revision }], configuration: { challenge } })
    worker = await NativeInferenceProcess.start(options, store, pkg, pkg.manifest.contributes.inference!.runtimes[0]!, binding, [lease], signal)
    const chunks = [Buffer.from([0, 255, 13, 10, 128]), Buffer.from(`推理 ${challenge}`)]
    // Exercise large pipe writes without exceeding the concatenated echo frame or queue limits.
    const nearLimitChunk = Buffer.alloc(Math.min(inferenceLimits.chunkBytes, inferenceLimits.queuedBytes) - chunks.reduce((size, chunk) => size + chunk.length, 0))
    for (let index = 0; index < nearLimitChunk.length; index++)
      nearLimitChunk[index] = index % 256
    chunks.push(nearLimitChunk)
    const events: Array<{ data: unknown, bytes: Buffer }> = []
    await worker.invoke({
      id: randomUUID(),
      capability: 'echo',
      input: { challenge },
      signal,
      chunks: (async function* () { yield* chunks })(),
      event(data, bytes) { events.push({ data, bytes: Buffer.from(bytes) }) },
    })
    assert.deepEqual(events, [{ data: { challenge, chunks: chunks.length }, bytes: Buffer.concat(chunks) }])
    await worker.stop()
    assert.equal(worker.stopped, true)
    await lease.release()
    lease = undefined
    await store.inference.remove(manifest.id, resource, current)
    await store.inference.drain()
  }
  finally {
    try {
      await worker?.stop()
    }
    finally {
      try {
        await lease?.release()
      }
      finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
}
