import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { linuxManualInstallation } from '../linuxInstaller'

describe.skipIf(process.platform === 'win32')('linux manual installation commands', () => {
  it.each(['pacman', 'deb', 'rpm'] as const)('quotes %s package paths as one literal shell argument', (format) => {
    const installation = linuxManualInstallation({ schemaVersion: 1, format, architecture: 'arm64', signing: 'none' }, '1.2.3', '/tmp/update \'with spaces\' $(echo injected); &')!
    const output = execFileSync('/bin/sh', ['-c', `sudo() { printf '%s\\n' "$@"; }; ${installation.command}`], { encoding: 'utf8' })
    expect(output.trim().split('\n').at(-1)).toBe(installation.packagePath)
    expect(installation.command).not.toContain('--noconfirm')
    expect(installation.command).not.toContain('-Sy')
    expect(installation.packageName).toContain(format === 'deb' ? 'arm64' : 'aarch64')
  })
})
