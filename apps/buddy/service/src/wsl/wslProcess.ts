import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { win32 } from 'node:path'
import process from 'node:process'

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 16 * 1024
const MAX_HEAD_BYTES = 4 * 1024
const SEARCH_TIMEOUT_MS = 30_000
// wsl.exe reports its own failures as `<3>WSL (pid - Relay) ERROR: ...` and may still exit with 0 or 1.
const RELAY_ERROR = /^<\d>WSL \([^)]*\) ERROR: (.*)$/m
const MISSING_PROGRAM = /execvpe\((.+?)\) failed/

export type SpawnWsl = (executable: string, args: string[]) => ChildProcessByStdio<null, Readable, Readable>
// The resident helper is also written to, so its stdin is a pipe.
export type SpawnWslHelper = (executable: string, args: string[]) => ChildProcessByStdio<Writable, Readable, Readable>

export interface WslSearchProcess {
  distribution: string
  program: string
  args: readonly string[]
  signal?: AbortSignal
  /** Byte that ends a record on stdout. */
  separator: number
  /** Return false to stop reading; the process is stopped and the search counts as successful. */
  onRecord: (record: Buffer) => boolean | void
  successCodes: readonly number[]
  /** Replaces the wsl.exe launch, for tests. */
  spawnProcess?: SpawnWsl
}

export type RunWslSearch = (request: WslSearchProcess) => Promise<void>

// The program ran and failed. Its message is in the language of the distribution (find, unlike rg, is localized),
// so callers decide from the exit code and the records already read, never from the text.
export class WslProgramError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode: number) {
    super(message)
    this.name = 'WslProgramError'
    this.exitCode = exitCode
  }
}

export const spawnWsl: SpawnWsl = (executable, args) => spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
export const spawnWslHelper: SpawnWslHelper = (executable, args) => spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

// System32 is used instead of PATH so that a planted wsl.exe earlier on PATH is never run.
export function wslExecutable(): string {
  return process.platform === 'win32' ? win32.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'wsl.exe') : 'wsl.exe'
}

// Messages that wsl.exe writes itself are UTF-16LE or in the system code page; everything a Linux program writes is UTF-8.
export function decodeDiagnostic(bytes: Buffer): string {
  return (bytes.includes(0) ? bytes.toString('utf16le') : bytes.toString('utf8')).trim()
}

// The text of a wsl.exe relay error in stderr, when there is one.
export function relayError(stderr: Buffer): string | undefined {
  return RELAY_ERROR.exec(decodeDiagnostic(stderr))?.[1]
}

export function missingProgramError(distribution: string, program: string): Error {
  return new Error(`${program} is not installed in the WSL distribution ${distribution}${program === 'rg' ? '; install ripgrep there (sudo apt install ripgrep)' : ''}`)
}

// A program the helper could not start at all: `err` is the helper's code for why.
function startError(request: WslSearchProcess, reason: string): Error {
  if (reason === 'ENOENT')
    return missingProgramError(request.distribution, request.program)
  return new Error(reason === 'FORBIDDEN' ? `${request.program} is not allowed in the WSL helper` : `${request.program} could not be started in the WSL distribution ${request.distribution}: ${reason}`)
}

function describeFailure(request: WslSearchProcess, stderr: Buffer, head: Buffer, code: number | null): Error | null {
  const relay = relayError(stderr)
  if (relay) {
    const missing = MISSING_PROGRAM.exec(relay)
    return missing ? missingProgramError(request.distribution, missing[1]!) : new Error(`wsl.exe failed: ${relay}`)
  }
  if (code !== null && !request.successCodes.includes(code))
    return new WslProgramError(decodeDiagnostic(stderr) || decodeDiagnostic(head) || `Search exited with code ${code}`, code)
  return null
}

export interface SearchCollector {
  /** Settles when the search is over: resolved when it succeeded or was stopped on purpose. */
  readonly done: Promise<void>
  /** Whether any output has arrived, which decides whether the search may be started again. */
  readonly received: boolean
  stdout: (chunk: Buffer) => void
  stderr: (chunk: Buffer) => void
  /** The program ended. `code` is its exit code, or null with `reason` when it never started. */
  exit: (code: number | null, reason?: string) => void
  /** The channel to the program failed before it ended. */
  fail: (error: Error) => void
}

// Turns the output of one program (however it reaches us) into records, enforcing the limits and deciding the outcome.
// `stopProcess` ends the program: it is called on abort, timeout, a limit, or when the record handler is satisfied.
export function collectSearch(request: WslSearchProcess, stopProcess: () => void): SearchCollector {
  const { signal, separator, onRecord } = request
  const done = Promise.withResolvers<void>()
  let failure: Error | undefined
  let stopped = false
  let settled = false
  let received = false
  let total = 0
  let stderr = Buffer.alloc(0)
  let head = Buffer.alloc(0)
  let pending: Buffer[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  function settle(error?: Error) {
    if (settled)
      return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (error)
      done.reject(error)
    else
      done.resolve()
  }
  // Once the outcome is decided the program is told to end, but nothing waits for it to do so: a program that is slow
  // to die, or a helper that is stuck, must not hold the search.
  function stop(error?: Error) {
    failure ??= error
    if (stopped)
      return
    stopped = true
    stopProcess()
    settle(failure)
  }
  function abort() {
    stop(new Error('Operation aborted', { cause: signal?.reason }))
  }
  timer = setTimeout(() => stop(new Error('Search timed out; narrow the search path')), SEARCH_TIMEOUT_MS)
  signal?.addEventListener('abort', abort, { once: true })
  const emit = (tail: Buffer) => {
    const record = pending.length ? Buffer.concat([...pending, tail]) : tail
    pending = []
    if (record.length && onRecord(record) === false)
      stop()
  }
  if (signal?.aborted)
    abort()
  return {
    done: done.promise,
    get received() {
      return received
    },
    stdout(chunk) {
      if (stopped)
        return
      // A line-oriented stream never contains NUL, so UTF-16 text here is wsl.exe itself failing (for example an unknown distribution).
      if (total === 0 && separator !== 0 && chunk.includes(0)) {
        stop(new Error(`wsl.exe failed: ${decodeDiagnostic(chunk)}`))
        return
      }
      received = true
      if (head.length < MAX_HEAD_BYTES)
        head = Buffer.concat([head, chunk]).subarray(0, MAX_HEAD_BYTES)
      total += chunk.length
      if (total > MAX_CAPTURE_BYTES) {
        stop(new Error('Search output limit exceeded; narrow the search path or pattern'))
        return
      }
      try {
        let start = 0
        for (let end = chunk.indexOf(separator); end !== -1; end = chunk.indexOf(separator, start)) {
          emit(chunk.subarray(start, end))
          if (stopped)
            return
          start = end + 1
        }
        if (start < chunk.length)
          pending.push(chunk.subarray(start))
      }
      catch (error) {
        stop(error as Error)
      }
    },
    stderr(chunk) {
      if (stopped)
        return
      if (stderr.length + chunk.length > MAX_STDERR_BYTES) {
        stop(new Error('Search diagnostic output limit exceeded'))
        return
      }
      stderr = Buffer.concat([stderr, chunk])
    },
    exit(code, reason) {
      if (!failure && !stopped)
        failure = (reason ? startError(request, reason) : describeFailure(request, stderr, head, code)) ?? undefined
      if (!failure && !stopped && pending.length) {
        try {
          emit(Buffer.alloc(0))
        }
        catch (error) {
          failure = error as Error
        }
      }
      settle(failure)
    },
    fail(error) {
      if (!stopped)
        failure ??= error
      settle(failure)
    },
  }
}

// Runs a program inside a WSL distribution through its own wsl.exe, without a shell, so no argument is ever re-parsed
// by PowerShell or bash. Costs one wsl.exe start per call; the resident helper (WslHostPool) avoids that.
export async function runWslSearch(request: WslSearchProcess): Promise<void> {
  request.signal?.throwIfAborted()
  const child = (request.spawnProcess ?? spawnWsl)(wslExecutable(), ['-d', request.distribution, '--exec', request.program, ...request.args])
  const collector = collectSearch(request, () => child.kill('SIGKILL'))
  child.stdout.on('data', collector.stdout)
  child.stderr.on('data', collector.stderr)
  child.once('error', collector.fail)
  child.once('close', code => collector.exit(code))
  return collector.done
}
