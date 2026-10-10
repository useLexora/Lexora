import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { readNativeBoundedFile, readNativeBoundedFiles } from '../nativeBoundedFile'

const execute = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execute }))

const fixtureRoot = resolve('fixture')
const fixturePath = resolve(fixtureRoot, 'file')
const fixtureExecutable = resolve(fixtureRoot, 'reader')

describe('native bounded read lifecycle', () => {
  it.each(['ABORT_ERR', 'ENOENT'] as const)('waits for process closure after %s', async (code) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough() })
    execute.mockReturnValue(child)
    let settled = false
    const pending = readNativeBoundedFile(fixtureRoot, fixturePath, 1024, undefined, fixtureExecutable).finally(() => settled = true)
    const error = Object.assign(new Error('fixture failure'), { code })
    execute.mock.calls[0]![3](error, Buffer.alloc(0), Buffer.alloc(0))
    await Promise.resolve()
    expect(settled).toBe(false)
    child.emit('close', null, 'SIGKILL')
    await expect(pending).rejects.toMatchObject({ code: code === 'ENOENT' ? 'BOUNDED_FILE_READER_UNAVAILABLE' : 'BOUNDED_FILE_READ_FAILED', cause: error })
    expect(settled).toBe(true)
  })

  it.each([
    [0, 0, 0],
    [0, 0, 0, 0, 2, 1],
    [0, 0, 0, 0, 2, 1, 2],
    [1, 0, 0, 0, 1, 1],
    [4, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
  ])('rejects malformed or over-limit frames: %j', async (...bytes) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough() })
    execute.mockReturnValue(child)
    const pending = readNativeBoundedFiles([{ root: fixtureRoot, path: fixturePath, maxBytes: 1 }], undefined, fixtureExecutable)
    execute.mock.calls[0]![3](null, Buffer.from(bytes), Buffer.alloc(0))
    child.emit('close', 0, null)
    await expect(pending).rejects.toMatchObject({ code: 'BOUNDED_FILE_READ_FAILED' })
  })
})
