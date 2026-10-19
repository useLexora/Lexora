import type { SandboxEnvironmentStatus, SandboxSetupResult } from '../../shared/permissions/shellSandbox'
import { execFile } from 'node:child_process'
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
const versionSchema = z.object({ protocol: z.literal(1), version: z.number().int().positive() }).strict()

async function inspect(executable: string) {
  const { stdout } = await execute(executable, ['status'], {
    env: createWindowsHostEnvironment(executable, process.env),
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  })
  return statusSchema.parse(JSON.parse(stdout))
}

async function componentVersion(executable: string): Promise<number | undefined> {
  let stdout: string
  try {
    ({ stdout } = await execute(executable, ['version'], {
      env: createWindowsHostEnvironment(executable, process.env),
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }))
  }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' && !('killed' in error && error.killed))
      return undefined
    throw error
  }
  try {
    return versionSchema.parse(JSON.parse(stdout)).version
  }
  catch { return undefined }
}

async function compatible(executable: string, status: z.infer<typeof statusSchema>): Promise<boolean> {
  if (!status.healthy)
    return false
  const [bundledVersion, installedVersion] = await Promise.all([executable, status.path].map(componentVersion))
  return bundledVersion !== undefined && bundledVersion === installedVersion
}

async function verifyService(executable: string): Promise<boolean> {
  try {
    await execute(executable, ['health'], { env: createWindowsHostEnvironment(executable, process.env), windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 })
    return true
  }
  catch (error) {
    if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' && !('killed' in error && error.killed)) {
      try {
        const diagnostic = z.object({ type: z.literal('error'), code: z.literal('SANDBOX_NEEDS_UPDATE'), nativeCode: z.null() }).strict().safeParse(JSON.parse(error.stderr.trim()))
        if (diagnostic.success)
          return false
      }
      catch {}
    }
    const failure = z.object({ code: z.union([z.string(), z.number()]).nullable().optional(), killed: z.boolean().optional(), signal: z.string().nullable().optional() }).safeParse(error)
    console.error('SANDBOX_SERVICE_UNAVAILABLE', failure.success ? failure.data : {})
    throw new ShellSandboxError('SANDBOX_UNAVAILABLE')
  }
}

export async function checkWindowsSandbox(executable: string | undefined): Promise<SandboxEnvironmentStatus> {
  if (!executable || !isWindows(currentTarget.platform))
    return 'unavailable'
  try {
    const status = await inspect(executable)
    if (!status.installed)
      return 'needs_setup'
    if (!await compatible(executable, status))
      return 'needs_repair'
    if (!await verifyService(status.path))
      return 'needs_repair'
    return await probeWindowsSandbox(status.path, await resolveWindowsPowerShell()) ? 'available' : 'incompatible'
  }
  catch { return 'unavailable' }
}

export async function resolveWindowsSandbox(executable: string | undefined): Promise<string> {
  if (!executable)
    throw new ShellSandboxError('SANDBOX_UNAVAILABLE')
  const status = await inspect(executable)
  if (!status.installed || !await compatible(executable, status))
    throw new ShellSandboxError('SANDBOX_UNAVAILABLE')
  if (!await verifyService(status.path))
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
