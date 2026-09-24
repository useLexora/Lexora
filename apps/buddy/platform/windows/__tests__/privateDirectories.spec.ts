import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { readDiagnosticError } from '../../../shared/diagnostics/applicationDiagnostic'
import { runNativeCommand, runNativeCommandSync } from '../../native/nativeCommand'
import { ensureWindowsPrivateDirectories, ensureWindowsPrivateDirectoriesSync } from '../privateDirectories'

vi.mock('../../native/nativeCommand', () => ({ runNativeCommand: vi.fn(), runNativeCommandSync: vi.fn() }))

const paths = ['C:\\Users\\fixture\\.lexora']
const executable = 'C:\\Lexora\\private-directories.exe'

describe.each([
  ['asynchronous', ensureWindowsPrivateDirectories],
  ['synchronous', ensureWindowsPrivateDirectoriesSync],
] as const)('%s private directory failure diagnostics', (_name, ensure) => {
  it.each([
    { code: 'PRIVATE_DIRECTORIES_UNSAFE', operation: 'validate_acl', directoryIndex: 0 },
    { code: 'PRIVATE_DIRECTORIES_FAILED', operation: 'open_directory', directoryIndex: 0, systemError: { domain: 'ntstatus', code: 0xC0000022 } },
  ])('preserves the native $code failure', async (native) => {
    const result = { code: 1, stdout: Buffer.alloc(0), stderr: JSON.stringify(native) }
    vi.mocked(runNativeCommand).mockResolvedValue(result)
    vi.mocked(runNativeCommandSync).mockReturnValue(result)
    const error = await Promise.resolve().then(() => ensure(paths, executable)).catch(error => error)
    const { code, ...details } = native
    expect(readDiagnosticError(error)).toEqual({
      errorCode: code,
      errorType: 'PrivateDirectoryError',
      failure: { kind: 'private_directories', ...details, exitCode: 1 },
    })
  })

  it.each([
    { code: -1073741515, stdout: Buffer.alloc(0), stderr: '', expected: 'PRIVATE_DIRECTORIES_PROCESS_FAILED' },
    { code: 0, stdout: Buffer.from('fixture-invalid-response'), stderr: '', expected: 'PRIVATE_DIRECTORIES_INVALID_RESPONSE' },
    { code: 1, stdout: Buffer.alloc(0), stderr: JSON.stringify({ code: 'PRIVATE_DIRECTORIES_UNSAFE', operation: 'validate_acl', path: 'fixture-private-path' }), expected: 'PRIVATE_DIRECTORIES_PROCESS_FAILED' },
  ])('classifies abnormal process or protocol results: $expected', async (result) => {
    vi.mocked(runNativeCommand).mockResolvedValue(result)
    vi.mocked(runNativeCommandSync).mockReturnValue(result)
    const error = await Promise.resolve().then(() => ensure(paths, executable)).catch(error => error)
    const diagnostic = readDiagnosticError(error)
    expect(diagnostic).toMatchObject({ errorCode: result.expected, failure: { exitCode: result.code } })
    expect(JSON.stringify(diagnostic)).not.toContain('fixture-')
  })

  it('retains a process error code without exposing the command or environment', async () => {
    const cause = Object.assign(new Error('fixture-private-command token=fixture-secret'), { code: 'ENOENT', exitCode: -2 })
    vi.mocked(runNativeCommand).mockRejectedValue(cause)
    vi.mocked(runNativeCommandSync).mockImplementation(() => {
      throw cause
    })
    const error = await Promise.resolve().then(() => ensure(paths, executable)).catch(error => error)
    expect(error.cause).toBe(cause)
    expect(readDiagnosticError(error)).toEqual({
      errorCode: 'PRIVATE_DIRECTORIES_UNAVAILABLE',
      errorType: 'PrivateDirectoryError',
      failure: { kind: 'private_directories', operation: 'process', processErrorCode: 'ENOENT', exitCode: -2 },
    })
  })
})
