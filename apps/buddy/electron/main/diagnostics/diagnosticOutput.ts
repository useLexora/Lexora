import type { Buffer } from 'node:buffer'
import { Writable } from 'node:stream'

export function createDiagnosticOutput(onOutput: (output: { bytes: number, chunks: number }) => void, onDrop: () => void): Writable {
  let bytes = 0
  let chunks = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (chunks)
      onOutput({ bytes, chunks })
    bytes = 0
    chunks = 0
  }
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + chunk.length)
      chunks = Math.min(Number.MAX_SAFE_INTEGER, chunks + 1)
      timer ??= setTimeout(flush, 5000)
      timer.unref()
      callback()
    },
    final(callback) {
      flush()
      callback()
    },
    destroy(error, callback) {
      flush()
      callback(error)
    },
  })
  output.on('error', onDrop)
  return output
}

export interface CapturedDiagnosticOutput {
  done: Promise<void>
  stop: () => void
}

export function captureDiagnosticOutput(
  source: NodeJS.ReadableStream,
  output: Writable,
  onError: (error: Error) => void,
): CapturedDiagnosticOutput {
  let stop!: () => void
  const done = new Promise<void>((resolve) => {
    const handleError = (error: Error) => {
      onError(error)
      stop()
    }
    stop = () => {
      source.unpipe(output)
      source.removeListener('end', stop)
      source.removeListener('close', stop)
      source.removeListener('error', handleError)
      output.end()
      resolve()
    }
    source.once('end', stop)
    source.once('close', stop)
    source.once('error', handleError)
    source.pipe(output)
    if (!source.readable)
      stop()
  })
  return { done, stop }
}
