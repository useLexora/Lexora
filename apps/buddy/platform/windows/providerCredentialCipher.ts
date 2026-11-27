import type { ServiceResourceLocation } from '../service/serviceResources'
import { Buffer, isUtf8 } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { debuglog } from 'node:util'
import { resolveBuddyProviderCredential } from '../native/nativeHost'

const MAGIC = Buffer.from('LXPC\x01', 'ascii')
const HEADER = 10
const SEAL = 1
const OPEN = 2
const MAX_TEXT = 1024 * 1024
const MAX_BLOB = MAX_TEXT + 64 * 1024
const childProcessDebug = debuglog('child_process')
// Multiple vault instances share one installed helper. Don't repeat a process timeout per record.
let unavailable: { executable: string, retryAt: number } | undefined

function canStart(executable: string | undefined): executable is string {
  return !!executable && !childProcessDebug.enabled && (unavailable?.executable !== executable || performance.now() >= unavailable.retryAt)
}

export function createWindowsProviderCipher(location?: ServiceResourceLocation) {
  const executable = resolveExecutable(location)
  return {
    isAvailable(): boolean {
      try {
        return canStart(executable) && statSync(executable, { throwIfNoEntry: false })?.isFile() === true
      }
      catch {
        return false
      }
    },
    encrypt(value: string): Buffer {
      if (typeof value !== 'string' || value.length > MAX_TEXT || Buffer.byteLength(value) > MAX_TEXT || !value.isWellFormed())
        throw cipherError()
      return exchange(executable, SEAL, value)
    },
    decrypt(value: Buffer): string {
      if (!Buffer.isBuffer(value) || value.length === 0 || value.length > MAX_BLOB)
        throw cipherError()
      const plaintext = exchange(executable, OPEN, value)
      try {
        if (!isUtf8(plaintext))
          throw cipherError()
        return plaintext.toString('utf8')
      }
      finally {
        plaintext.fill(0)
      }
    },
  }
}

function resolveExecutable(location?: ServiceResourceLocation): string | undefined {
  if (process.platform !== 'win32' || (process.arch !== 'x64' && process.arch !== 'arm64'))
    return undefined
  // A bare factory can use the installed Electron resources. Development and Node hosts pass
  // their trusted release location; never discover an executable via cwd, PATH or user config.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const root = location ?? (resourcesPath ? { isPackaged: true, appPath: '', resourcesPath } : undefined)
  const executable = root && resolveBuddyProviderCredential({ ...root, platform: process.platform, architecture: process.arch })
  return executable && isAbsolute(executable) ? executable : undefined
}

function exchange(executable: string | undefined, op: typeof SEAL | typeof OPEN, value: string | Buffer): Buffer {
  // Node's child_process debug trace can include the spawn options, including input.
  if (!canStart(executable))
    throw cipherError()
  const length = typeof value === 'string' ? Buffer.byteLength(value) : value.length
  const frame = Buffer.alloc(HEADER + length)
  MAGIC.copy(frame)
  frame[5] = op
  frame.writeUInt32LE(length, 6)
  if (typeof value === 'string')
    frame.write(value, HEADER, 'utf8')
  else
    value.copy(frame, HEADER)
  const limit = op === SEAL ? MAX_BLOB : MAX_TEXT
  try {
    const { status, error, stdout } = spawnSync(executable, [], {
      input: frame,
      cwd: dirname(executable),
      env: { SystemRoot: process.env.SystemRoot },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: HEADER + limit,
    })
    if (error)
      unavailable = { executable, retryAt: performance.now() + 5_000 }
    if (error || status !== 0 || !stdout || stdout.length < HEADER || stdout.length > HEADER + limit
      || !stdout.subarray(0, 5).equals(MAGIC) || stdout[5] !== (op | 0x80) || stdout.readUInt32LE(6) !== stdout.length - HEADER
      || (op === SEAL && stdout.length === HEADER)) {
      stdout?.fill(0)
      throw cipherError()
    }
    return stdout.subarray(HEADER)
  }
  catch {
    throw cipherError()
  }
  finally {
    frame.fill(0)
  }
}

function cipherError(): Error {
  return new Error('WINDOWS_PROVIDER_CIPHER_FAILED')
}
