import { errorMonitor } from 'node:events'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { writeServiceStderr } from '../writeServiceStderr'

const output = vi.hoisted(() => ({ stderr: undefined as Writable | undefined }))
vi.mock('node:process', () => ({ default: output }))

describe('service diagnostic stderr', () => {
  it('forwards chunks without introducing line breaks', () => {
    let received = ''
    output.stderr = new Writable({ write(chunk, _encoding, done) {
      received += String(chunk)
      done()
    } })
    writeServiceStderr('HOST_')
    writeServiceStderr('DIAGNOSTIC\n')
    expect(received).toBe('HOST_DIAGNOSTIC\n')
  })

  it('tolerates an absent stream and a synchronous diagnostic write failure', () => {
    output.stderr = undefined
    expect(() => writeServiceStderr('HOST_DIAGNOSTIC\n')).not.toThrow()
    output.stderr = new Writable({ write() {
      throw Object.assign(new Error('closed handle'), { code: 'EBADF' })
    } })
    expect(() => writeServiceStderr('HOST_DIAGNOSTIC\n')).not.toThrow()
  })

  it('survives the failed write’s error event without silencing independent errors', async () => {
    const failure = Object.assign(new Error('closed sink'), { code: 'EPIPE' })
    const sink = output.stderr = new Writable({
      write(_chunk, _encoding, done) { setImmediate(() => done(failure)) },
      destroy(error, done) { setImmediate(() => setImmediate(() => done(error))) },
    })
    const observed: Error[] = []
    sink.on(errorMonitor, error => observed.push(error))
    const closed = new Promise<void>(resolve => sink.once('close', resolve))
    writeServiceStderr('HOST_DIAGNOSTIC\n')
    await closed
    expect(observed).toEqual([failure])
    expect(() => sink.emit('error', new Error('INDEPENDENT_IO_ERROR'))).toThrow('INDEPENDENT_IO_ERROR')
  })
})
