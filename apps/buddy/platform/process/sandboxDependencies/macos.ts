import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { OPERATING_SYSTEM } from '../../../shared/platform/identifiers'

export async function resolveMacosSandboxDependencies(options: { rg: string, srtRoot: string }) {
  const command = '/usr/bin/sandbox-exec'
  await Promise.all([options.rg, command].map(path => access(path, constants.X_OK)))
  return {
    ...options,
    platform: OPERATING_SYSTEM.MacOS,
    probe: { command, args: ['-p', '(version 1)(allow default)(deny network*)(deny file-write*)', '/usr/bin/true'] },
  }
}
