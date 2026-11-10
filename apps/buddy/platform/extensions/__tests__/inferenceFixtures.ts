import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { InferenceFrame } from '../inferenceWire'
import type { InferenceInvocation } from '../NativeInferenceProcess'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { inferenceFrame, readInferenceFrames } from '../inferenceWire'
import { NativeInferenceProcess } from '../NativeInferenceProcess'

export function invocation(input: Partial<InferenceInvocation> = {}): InferenceInvocation {
  return { id: 'call', capability: 'local', input: {}, signal: new AbortController().signal, event() {}, ...input }
}

export function memoryInference(options: { ignoreExit?: boolean, record?: ApplicationDiagnosticReporter } = {}) {
  const child = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const frames: InferenceFrame[] = []
  const waiters: Array<{ type: string, id: string, resolve: () => void }> = []
  const sessions = new Map<string, { input: InferenceInvocation['input'], size: number, cancelled: boolean }>()
  const send = (message: InferenceFrame, bytes?: Uint8Array) => stdout.write(inferenceFrame(message, bytes))
  let closed = false
  const close = () => {
    if (closed)
      return
    closed = true
    stdin.destroy()
    stdout.end()
    stderr.end()
    child.emit('close', 0)
  }
  Object.assign(child, { stdin, stdout, stderr, kill: close })
  stdin.once('finish', () => {
    if (!options.ignoreExit)
      close()
  })
  const worker = Reflect.construct(NativeInferenceProcess, [child, undefined, undefined, { extensionId: 'fixture.inference', record: options.record }]) as NativeInferenceProcess
  const reading = (async () => {
    for await (const { message, bytes } of readInferenceFrames(stdin)) {
      const id = message.id!
      frames.push(message)
      if (message.type === 'start') {
        const input = (message.data as { input: InferenceInvocation['input'] }).input
        sessions.set(id, { input, size: 0, cancelled: false })
        send({ type: 'started', id })
      }
      const session = sessions.get(id)
      if (session) {
        if (message.type === 'input') {
          session.size += bytes.length
          send({ type: 'accepted', id, sequence: message.sequence })
        }
        else if (message.type === 'cancel') {
          session.cancelled = true
        }
        else if (message.type === 'finish' && !(session.input as { ignoreFinish?: boolean })?.ignoreFinish) {
          if (!session.cancelled)
            send({ type: 'event', id, data: { size: session.size, input: session.input } }, new Uint8Array([1, 2, 3, 4]))
          send({ type: session.cancelled ? 'cancelled' : 'completed', id })
          sessions.delete(id)
        }
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.type === message.type && waiters[i]!.id === id)
          waiters.splice(i, 1)[0]!.resolve()
      }
    }
  })().catch((error: NodeJS.ErrnoException) => {
    if (!closed)
      throw error
  })
  return {
    worker,
    stderr,
    frames,
    send,
    close,
    reading,
    received(type: string, id: string): Promise<void> {
      if (frames.some(frame => frame.type === type && frame.id === id))
        return Promise.resolve()
      return new Promise(resolve => waiters.push({ type, id, resolve }))
    },
  }
}
