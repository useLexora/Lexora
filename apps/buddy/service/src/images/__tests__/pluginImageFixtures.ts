import type { Model } from '@earendil-works/pi-ai'
import type { registerExtensionImageReadingRpc } from '../../../../electron/main/extensions/registerExtensionImageReadingRpc'
import type { InferenceInvocation } from '../../../../platform/extensions/NativeInferenceProcess'
import { Buffer } from 'node:buffer'
import { PhotonImage } from '@silvia-odwyer/photon-node'
import { onTestFinished } from 'vitest'
import { RuntimeRpcPeer } from '../../../../platform/ipc/runtimeRpcPeer'

export type InferenceHost = NonNullable<ReturnType<Parameters<typeof registerExtensionImageReadingRpc>[1]>>

export const primaryModel: Model<'openai-completions'> = {
  api: 'openai-completions',
  provider: 'fixture',
  id: 'text',
  name: 'Text',
  baseUrl: 'https://example.test',
  input: ['text'],
  reasoning: false,
  contextWindow: 128000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

export function pngBytes(): Buffer {
  const image = new PhotonImage(Uint8Array.from([64, 128, 192, 255, 192, 128, 64, 255]), 2, 1)
  try {
    return Buffer.from(image.get_bytes())
  }
  finally { image.free() }
}

export function rpcPair() {
  const listeners: Array<(value: unknown) => void> = []
  const peer = (index: number) => new RuntimeRpcPeer({
    transport: {
      postMessage: value => queueMicrotask(() => listeners[1 - index]!(structuredClone(value))),
      subscribe: (listener) => {
        listeners[index] = listener
        return () => {}
      },
    },
  })
  const host = peer(0)
  const service = peer(1)
  onTestFinished(() => {
    host.close(new Error('Test finished'))
    service.close(new Error('Test finished'))
  })
  return { host, service }
}

export function inferenceHost(invoke: InferenceHost['invoke']): InferenceHost {
  return {
    imageReaders: async () => [],
    imageModels: async () => [],
    models: async () => [],
    list: async () => [],
    prepare: async () => { throw new Error('Unexpected preparation') },
    reset: async () => {},
    invoke,
  }
}

export async function readInferenceJson(input: InferenceInvocation): Promise<unknown> {
  const chunks: Uint8Array[] = []
  for await (const chunk of input.chunks ?? [])
    chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
