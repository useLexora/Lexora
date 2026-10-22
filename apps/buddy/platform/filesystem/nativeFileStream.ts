import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { OPERATING_SYSTEM } from '../../shared/platform/identifiers'
import { filePaths } from './filePaths'

export interface NativeFileStream {
  body: ReadableStream<Uint8Array>
  start: () => void
  dispose: () => Promise<void>
}

export async function openNativeFileStream(
  request: { root: string, path: string, fileId: string, sizeBytes: number, start: number, length: number },
  signal: AbortSignal,
  executable = process.env.LEXORA_BUDDY_FILE_READER,
): Promise<NativeFileStream> {
  if (!executable)
    throw new Error('MEDIA_FILE_READER_UNAVAILABLE')
  signal.throwIfAborted()
  const child = spawn(filePaths.resolveInput(executable), ['--stream'], {
    env: process.platform === OPERATING_SYSTEM.Windows ? { SystemRoot: process.env.SystemRoot } : {},
    stdio: 'pipe',
    windowsHide: true,
  })
  let failure = false
  let stopped = false
  let started = false
  let received = 0
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const closed = new Promise<void>((resolve) => {
    child.once('error', () => {
      failure = true
    })
    child.once('close', (code) => {
      failure ||= code !== 0
      resolve()
    })
  })
  child.stdin.on('error', () => {
    failure = true
  })
  child.stderr.on('data', () => {
    failure = true
  })
  const iterator = child.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>
  const dispose = async () => {
    stopped = true
    signal.removeEventListener('abort', abort)
    child.kill('SIGKILL')
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    await closed
  }
  function abort() {
    if (!stopped)
      controller?.error(new Error('MEDIA_REQUEST_ABORTED'))
    void dispose()
  }
  signal.addEventListener('abort', abort, { once: true })
  const startup = setTimeout(() => {
    void dispose()
  }, 10_000)
  try {
    child.stdin.write(`${JSON.stringify({ ...request, root: filePaths.resolveInput(request.root), path: filePaths.resolveInput(request.path) })}\n`)
    const ready = await iterator.next()
    if (signal.aborted || stopped || ready.done || ready.value.length !== 1 || ready.value[0] !== 1)
      throw new Error('MEDIA_FILE_READ_FAILED')
  }
  catch (error) {
    await dispose()
    throw error
  }
  finally { clearTimeout(startup) }
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      if (signal.aborted)
        abort()
    },
    async pull() {
      try {
        const next = await iterator.next()
        if (stopped)
          return
        if (next.done) {
          await closed
          if (failure || received !== request.length)
            throw new Error('MEDIA_FILE_READ_FAILED')
          stopped = true
          signal.removeEventListener('abort', abort)
          controller!.close()
          return
        }
        received += next.value.length
        if (received > request.length)
          throw new Error('MEDIA_FILE_OUTPUT_LIMIT')
        controller!.enqueue(next.value)
      }
      catch (error) {
        if (!stopped)
          controller!.error(error)
        await dispose()
      }
    },
    cancel: dispose,
  }, { highWaterMark: 0 })
  return {
    body,
    start() {
      if (started || stopped || signal.aborted)
        throw new Error('MEDIA_REQUEST_ABORTED')
      started = true
      child.stdin.end(Uint8Array.of(1))
    },
    dispose,
  }
}
