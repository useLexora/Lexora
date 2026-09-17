import type { SandboxEnvironmentStatus, SrtSandboxInput } from '../../shared/permissions/shellSandbox'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ShellSandboxError } from '../../shared/permissions/shellSandbox'
import { isLinux, isMacOS, isWindows, SHELL_SANDBOX_BACKEND } from '../../shared/platform/identifiers'
import { currentTarget } from '../target'
import { resolveLinuxSandboxDependencies } from './sandboxDependencies/linux'
import { resolveMacosSandboxDependencies } from './sandboxDependencies/macos'
import { checkWindowsSandbox } from './windowsSandbox'

const execute = promisify(execFile)
type SrtBackend = SrtSandboxInput['backend']

export async function resolveSandboxDependencies(options: { backend: SrtBackend, searchDirectory: string }, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const shared = {
    rg: join(options.searchDirectory, 'rg'),
    srtRoot: dirname(dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime')))).replace(/\.asar(?=\/)/, '.asar.unpacked'),
  }
  if (options.backend.kind === SHELL_SANDBOX_BACKEND.Linux && isLinux(currentTarget.platform))
    return resolveLinuxSandboxDependencies({ ...shared, sandboxDirectory: options.backend.sandboxDirectory }, signal)
  if (options.backend.kind === SHELL_SANDBOX_BACKEND.MacOS && isMacOS(currentTarget.platform))
    return resolveMacosSandboxDependencies(shared)
  throw new ShellSandboxError('SANDBOX_UNAVAILABLE')
}

export type SrtSandboxDependencies = Awaited<ReturnType<typeof resolveSandboxDependencies>>

export async function checkSandboxEnvironment(options: { sandboxDirectory?: string, searchDirectory: string, windowsSandbox?: string }): Promise<SandboxEnvironmentStatus> {
  if (isWindows(currentTarget.platform))
    return checkWindowsSandbox(options.windowsSandbox)
  try {
    if (isLinux(currentTarget.platform) && !options.sandboxDirectory)
      return 'unavailable'
    const backend: SrtBackend = isLinux(currentTarget.platform)
      ? { kind: SHELL_SANDBOX_BACKEND.Linux, sandboxDirectory: options.sandboxDirectory! }
      : { kind: SHELL_SANDBOX_BACKEND.MacOS }
    const { probe } = await resolveSandboxDependencies({ backend, searchDirectory: options.searchDirectory })
    await execute(probe.command, probe.args, { cwd: '/', env: { LANG: 'C' }, timeout: 5_000 })
    return 'available'
  }
  catch {
    return 'unavailable'
  }
}
