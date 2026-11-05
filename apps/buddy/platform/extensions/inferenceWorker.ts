import type { InferenceNetworkOptions } from '../../shared/extensions/extensionInference'
import type { JsonValue } from '../../shared/workbench/workbenchState'
import type { InferenceFrame } from './inferenceWire'
import { dirname } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { inferenceLimits } from '../../shared/extensions/extensionInference'
import { readInferenceInitialization } from './inferenceInitialization'
import { InferenceNetworkClient } from './inferenceNetworkClient'
import { inferenceFrame, readInferenceFrames, writeInferenceFrame } from './inferenceWire'

interface InputSession {
  write?: (bytes: Uint8Array) => void | Promise<void>
  finish: () => void | Promise<void>
}
interface Invocation {
  network: { post: (endpoint: string, body: Uint8Array, options?: InferenceNetworkOptions) => Promise<Response> }
  signal: AbortSignal
  emit: (data: JsonValue, bytes?: Uint8Array) => boolean
  emitAsync: (data: JsonValue, bytes?: Uint8Array) => Promise<void>
}
interface Backend {
  start: (capability: string, input: JsonValue, invocation: Invocation) => Promise<InputSession> | InputSession
  dispose?: () => Promise<void> | void
}
interface Session {
  abort: AbortController
  input: Promise<InputSession>
  tail: Promise<void>
  sequence: number
}
const sessions = new Map<string, Session>()
let backend: Backend | undefined
const send = (message: InferenceFrame, bytes?: Uint8Array) => writeInferenceFrame(process.stdout, message, bytes)
const network = new InferenceNetworkClient(send)
function failed() {
  process.exitCode = 1
  process.stdin.destroy()
  process.stdout.destroy()
}
process.stdout.on('error', failed)
process.stdin.on('error', failed)
const errorCode = (error: unknown) => error instanceof Error && /^EXTENSION_INFERENCE_[A-Z_]+$/.test(error.message) ? error.message : 'EXTENSION_INFERENCE_BACKEND_FAILED'
async function terminal(id: string, session: Session, error?: unknown) {
  if (sessions.get(id) !== session)
    return
  if (error)
    session.abort.abort(error)
  network.close(id)
  sessions.delete(id)
  await send({ type: error ? 'failed' : session.abort.signal.aborted ? 'cancelled' : 'completed', id, ...(error ? { data: errorCode(error) } : {}) })
}
async function receive(message: InferenceFrame, bytes: Uint8Array) {
  if (message.type.startsWith('network.')) {
    network.receive(message, bytes)
    return
  }
  if (message.type === 'initialize') {
    if (backend || sessions.size)
      throw new Error('EXTENSION_INFERENCE_PROTOCOL_INVALID')
    const initialization = (process.platform === 'win32' || process.platform === 'darwin') && message.data === undefined
      ? await readInferenceInitialization(dirname(process.argv[1]!))
      : message.data ?? null
    const entry = await import(pathToFileURL(process.argv[2]!).href) as {
      initialize: (input: JsonValue) => Promise<Backend>
    }
    backend = await entry.initialize(initialization)
    if (typeof backend?.start !== 'function')
      throw new Error('EXTENSION_INFERENCE_BACKEND_INVALID')
    await send({ type: 'ready' })
    return
  }
  if (!backend || typeof message.id !== 'string')
    throw new Error('EXTENSION_INFERENCE_PROTOCOL_INVALID')
  const id = message.id
  if (message.type === 'start') {
    if (sessions.has(id) || sessions.size >= 4 || !message.data || typeof message.data !== 'object' || Array.isArray(message.data))
      throw new Error('EXTENSION_INFERENCE_PROTOCOL_INVALID')
    const { capability, input } = message.data
    if (typeof capability !== 'string')
      throw new Error('EXTENSION_INFERENCE_PROTOCOL_INVALID')
    const abort = new AbortController()
    const invocation: Invocation = {
      network: { post: (endpoint, body, options) => network.post(id, endpoint, body, abort.signal, options) },
      signal: abort.signal,
      async emitAsync(data, bytes) {
        abort.signal.throwIfAborted()
        await writeInferenceFrame(process.stdout, { type: 'event', id, data }, bytes)
        abort.signal.throwIfAborted()
      },
      emit(data, bytes) {
        if (abort.signal.aborted || !sessions.has(id))
          return false
        const frame = inferenceFrame({ type: 'event', id, data }, bytes)
        if (process.stdout.writableLength + frame.length > inferenceLimits.queuedBytes) {
          abort.abort(new Error('EXTENSION_INFERENCE_CHANNEL_FULL'))
          return false
        }
        process.stdout.write(frame)
        return true
      },
    }
    const inputSession = Promise.resolve().then(() => backend!.start(capability, input ?? null, invocation))
    const session: Session = { abort, input: inputSession, tail: Promise.resolve(), sequence: 0 }
    sessions.set(id, session)
    void inputSession.then(() => send({ type: 'started', id })).catch(error => terminal(id, session, error)).catch(failed)
    return
  }
  const session = sessions.get(id)
  if (!session && (message.type === 'cancel' || message.type === 'finish'))
    return
  if (!session)
    throw new Error('EXTENSION_INFERENCE_PROTOCOL_INVALID')
  if (message.type === 'cancel') {
    session.abort.abort()
    return
  }
  if (message.type === 'input') {
    if (message.sequence !== session.sequence++)
      throw new Error('EXTENSION_INFERENCE_SEQUENCE_INVALID')
    void (session.tail = session.tail.then(async () => {
      const input = await session.input
      if (!session.abort.signal.aborted) {
        if (!input.write)
          throw new Error('EXTENSION_INFERENCE_INPUT_UNSUPPORTED')
        await input.write(bytes)
      }
      await send({ type: 'accepted', id, sequence: message.sequence })
    })).catch(error => terminal(id, session, error)).catch(failed)
    return
  }
  if (message.type === 'finish') {
    void (session.tail = session.tail.then(async () => {
      const input = await session.input
      await input.finish()
      if (session.abort.signal.reason instanceof Error && session.abort.signal.reason.message === 'EXTENSION_INFERENCE_CHANNEL_FULL')
        throw session.abort.signal.reason
      await terminal(id, session)
    })).catch(error => terminal(id, session, error)).catch(failed)
    return
  }
  throw new Error('EXTENSION_INFERENCE_PROTOCOL_INVALID')
}
async function main() {
  try {
    for await (const { message, bytes } of readInferenceFrames(process.stdin))
      await receive(message, bytes)
  }
  catch (error) {
    await send({ type: 'fatal', data: errorCode(error) }).catch(() => {
    })
    process.exitCode = 1
  }
  finally {
    for (const session of sessions.values())
      session.abort.abort()
    await Promise.allSettled([...sessions.values()].map(session => session.tail))
    await backend?.dispose?.()
  }
}
void main().catch(failed)
