import type { SandboxEnvironmentStatus, SandboxSetupResult } from '../../shared/permissions/shellSandbox'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { ShellSandboxError } from '../../shared/permissions/shellSandbox'
import { isWindows } from '../../shared/platform/identifiers'
import { currentTarget } from '../target'
import { createWindowsHostEnvironment, resolveWindowsPowerShell } from '../windows/powerShell'
import { probeWindowsSandbox } from './probeWindowsSandbox'

const execute = promisify(execFile)
const statusSchema = z.object({ installed: z.boolean(), healthy: z.boolean(), path: z.string().min(1).max(4096), protocol: z.literal(1) }).strict()

async function inspect(executable: string) {
  const { stdout } = await execute(executable, ['status'], {
    env: createWindowsHostEnvironment(executable, process.env),
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  })
  return statusSchema.parse(JSON.parse(stdout))
}

async function matchesBundled(executable: string, installed: string): Promise<boolean> {
  const hashes = await Promise.all([executable, installed].map(async path => createHash('sha256').update(await readFile(path)).digest('hex')))
  return hashes[0] === hashes[1]
}

async function healthy(executable: string, status: z.infer<typeof statusSchema>): Promise<boolean> {
  if (!status.healthy || !await matchesBundled(executable, status.path))
    return false
  try {
    await execute(status.path, ['health'], { env: createWindowsHostEnvironment(status.path, process.env), windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 })
    return true
  }
  catch { return false }
}

export async function checkWindowsSandbox(executable: string | undefined): Promise<SandboxEnvironmentStatus> {
  if (!executable || !isWindows(currentTarget.platform))
    return 'unavailable'
  try {
    const status = await inspect(executable)
    if (!status.installed)
      return 'needs_setup'
    if (!await healthy(executable, status))
      return 'needs_repair'
    return await probeWindowsSandbox(status.path, await resolveWindowsPowerShell()) ? 'available' : 'incompatible'
  }
  catch { return 'unavailable' }
}

export async function resolveWindowsSandbox(executable: string | undefined): Promise<string> {
  if (!executable)
    throw new ShellSandboxError('SANDBOX_UNAVAILABLE')
  const status = await inspect(executable)
  if (!status.installed || !await healthy(executable, status))
    throw new ShellSandboxError('SANDBOX_UNAVAILABLE')
  if (!await probeWindowsSandbox(status.path, await resolveWindowsPowerShell()))
    throw new ShellSandboxError('SANDBOX_UNAVAILABLE')
  return status.path
}

export async function setupWindowsSandbox(executable: string | undefined): Promise<SandboxSetupResult> {
  if (!executable || !isWindows(currentTarget.platform))
    return 'failed'
  try {
    await execute(executable, ['setup'], {
      env: createWindowsHostEnvironment(executable, process.env),
      windowsHide: true,
      timeout: 190_000,
      maxBuffer: 16 * 1024,
    })
    const status = await checkWindowsSandbox(executable)
    if (status === 'available')
      return 'ready'
    return status === 'incompatible' ? 'incompatible' : 'failed'
  }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 126)
      return 'busy'
    if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
      try {
        const diagnostic = z.object({ nativeCode: z.number().nullable() }).passthrough().parse(JSON.parse(error.stderr.trim()))
        if (diagnostic.nativeCode === 1223)
          return 'cancelled'
      }
      catch {}
    }
    return 'failed'
  }
}
