import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ShellSandboxError } from '../../../shared/permissions/shellSandbox'
import { OPERATING_SYSTEM } from '../../../shared/platform/identifiers'
import shellSandbox from '../../native/shellSandbox.json'
import { currentTarget } from '../../target'

const execute = promisify(execFile)

export async function resolveLinuxSandboxDependencies(options: { sandboxDirectory: string, rg: string, srtRoot: string }, signal?: AbortSignal) {
  const bwrap = join(options.sandboxDirectory, 'bwrap')
  const socat = '/usr/bin/socat'
  const seccomp = join(options.srtRoot, 'vendor/seccomp', currentTarget.architecture, 'apply-seccomp')
  await Promise.all([bwrap, socat, options.rg, seccomp].map(path => access(path, constants.X_OK)))
  const metadata = await stat(bwrap)
  const version = await execute(bwrap, ['--version'], { signal, timeout: 5_000, env: { LANG: 'C' } })
  if (version.stdout.trim() !== `bubblewrap ${shellSandbox.version}` || (metadata.mode & 0o6000) !== 0)
    throw new ShellSandboxError('SANDBOX_UNAVAILABLE')
  return {
    ...options,
    platform: OPERATING_SYSTEM.Linux,
    bwrap,
    socat,
    seccomp,
    probe: { command: bwrap, args: ['--unshare-all', '--die-with-parent', '--new-session', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--chdir', '/', '--', '/usr/bin/true'] },
  }
}
