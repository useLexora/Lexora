import type { Buffer } from 'node:buffer'
import type { DesktopDistribution } from '../../shared/desktopDistribution'
import type { DesktopUpdateManualInstallation } from '../../shared/desktopUpdates'
import type { DesktopUpdatePackage } from './DesktopUpdatePackage'
import { spawn } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { desktopUpdateArtifactName } from '../../shared/desktopDistribution'
import { desktopVersionSchema } from '../../shared/desktopUpdates'

export type LinuxPackageFormat = 'pacman' | 'deb' | 'rpm'

const managers = { pacman: '/usr/bin/pacman', deb: '/usr/bin/apt-get', rpm: '/usr/bin/dnf' } as const
const receiptSchema = z.object({ version: desktopVersionSchema, outcome: z.enum(['failed', 'installed']) }).strict()

export function isLinuxPackageFormat(format: string | undefined): format is LinuxPackageFormat {
  return !!format && Object.hasOwn(managers, format)
}

export function linuxInstallerAvailable(helper: string | undefined, format: LinuxPackageFormat): boolean {
  if (!helper || process.getuid?.() === 0 || process.execPath !== '/opt/lexora-buddy/lexora-buddy')
    return false
  try {
    for (const path of [helper, '/usr/bin/pkexec', managers[format]])
      accessSync(path, constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

export function readLinuxInstallationFailure(directory: string): string | null {
  try {
    const receipt = receiptSchema.parse(JSON.parse(readFileSync(join(directory, 'installation.json'), 'utf8')))
    return receipt.outcome === 'failed' ? receipt.version : null
  }
  catch {
    return null
  }
}

export function linuxManualInstallation(distribution: DesktopDistribution, version: string, directory: string): DesktopUpdateManualInstallation | undefined {
  if (!isLinuxPackageFormat(distribution.format))
    return
  const packageName = desktopUpdateArtifactName(distribution.format, distribution.architecture, version)
  const packagePath = join(directory, packageName)
  const quotedPath = `'${packagePath.replaceAll('\'', '\'\\\'\'')}'`
  const commands = { pacman: 'sudo pacman -U --', deb: 'sudo apt-get install --', rpm: 'sudo dnf install' }
  return { version, packageName, packagePath, manager: { pacman: 'pacman', deb: 'APT', rpm: 'DNF' }[distribution.format], command: `${commands[distribution.format]} ${quotedPath}` }
}

export async function prepareLinuxInstaller(options: {
  helper: string
  format: LinuxPackageFormat
  path: string
  update: DesktopUpdatePackage
  directory: string
  quit: () => void
}): Promise<() => void> {
  await mkdir(options.directory, { recursive: true })
  const child = spawn(options.helper, ['--supervise-linux-update'], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
  child.stdin.on('error', () => {})
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('UPDATE_INSTALL_UNAVAILABLE'))
    }, 180_000)
    const finish = (error?: Error) => {
      clearTimeout(timer)
      child.stdout.removeAllListeners('data')
      error ? reject(error) : resolve()
    }
    let output = ''
    child.once('error', error => finish(error))
    child.once('exit', () => finish(new Error('UPDATE_INSTALL_UNAVAILABLE')))
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output === 'ready\n')
        finish()
      else if (output.includes('\n') || output.length > 256)
        finish(new Error(output === 'cancelled\n' ? 'UPDATE_INSTALL_CANCELLED' : 'UPDATE_INSTALL_UNAVAILABLE'))
    })
  })
  child.stdin.write(`${JSON.stringify({
    installation: { format: options.format, package: options.path, sha256: options.update.sha256, size: options.update.size, parent: process.pid },
    version: options.update.version,
    receipt: join(options.directory, 'installation.json'),
    log: join(options.directory, 'installation.log'),
    arguments: process.argv.slice(1).filter(argument => argument !== '--background'),
  })}\n`)
  try {
    await ready
  }
  catch (error) {
    child.stdin.destroy()
    throw error
  }
  return () => {
    child.stdin.end('commit\n', options.quit)
    child.stdout.destroy()
    child.unref()
  }
}
