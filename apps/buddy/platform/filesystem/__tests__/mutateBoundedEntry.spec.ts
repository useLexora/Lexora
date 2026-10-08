import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mutateBoundedEntry } from '../mutateBoundedEntry'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  process: { platform: 'win32', env: {} as Record<string, string | undefined> },
}))
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }))
vi.mock('node:process', () => ({ default: mocks.process }))

beforeEach(() => {
  mocks.execFile.mockReset()
  mocks.process.env = {
    LEXORA_BUDDY_FILE_READER: '/trusted/helper',
    SystemRoot: 'C:/Windows',
    USERPROFILE: 'C:/Users/test',
    LOCALAPPDATA: 'C:/Users/test/local',
    HOME: '/home/test',
    XDG_DATA_HOME: '/home/test/.local/share',
    SECRET: 'not-forwarded',
  }
})

const input = { root: '/workspace', path: '/workspace', operation: 'create-file' as const, name: 'note.md' }

describe('cross-platform bounded mutation transport', () => {
  it.each(['win32', 'darwin', 'linux'])('dispatches %s through the native authorization handshake', async (platform) => {
    mocks.process.platform = platform
    const authorize = vi.fn()
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      const stdout = new EventEmitter()
      const stdin = Object.assign(new EventEmitter(), {
        write: vi.fn(() => stdout.emit('data', 'ready\n')),
        end: vi.fn((decision: string) => {
          expect(decision).toBe('commit\n')
          expect(authorize).toHaveBeenCalledOnce()
          callback(null, 'ready\n"file"', '')
        }),
      })
      return { stdout, stdin }
    })
    expect(await mutateBoundedEntry(input, authorize)).toEqual({ status: 'completed', kind: 'file' })
    const [executable, args, options] = mocks.execFile.mock.calls[0]!
    expect(executable).toBe('/trusted/helper')
    expect(args).toEqual(['--mutate-entry'])
    expect(options.env).toEqual(platform === 'win32'
      ? { SystemRoot: 'C:/Windows', USERPROFILE: 'C:/Users/test', LOCALAPPDATA: 'C:/Users/test/local' }
      : platform === 'darwin' ? { HOME: '/home/test' } : { HOME: '/home/test', XDG_DATA_HOME: '/home/test/.local/share' })
    expect(options.env).not.toHaveProperty('SECRET')
  })

  it('does not claim support when the native backend rejects an operation', async () => {
    mocks.process.platform = 'linux'
    const authorize = vi.fn()
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(new Error('unsupported'), '', 'unsupported'))
      return { stdin: { on: vi.fn(), write: vi.fn() } }
    })
    expect(await mutateBoundedEntry(input, authorize)).toEqual({ status: 'failed', reason: 'unsupported' })
    expect(authorize).not.toHaveBeenCalled()
    expect(mocks.execFile).toHaveBeenCalledOnce()
  })

  it('rejects unknown platforms without spawning a helper', async () => {
    mocks.process.platform = 'freebsd'
    expect(await mutateBoundedEntry(input, vi.fn())).toEqual({ status: 'failed', reason: 'unsupported' })
    expect(mocks.execFile).not.toHaveBeenCalled()
  })
})
