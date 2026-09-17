import type { SrtSandboxDependencies } from '../../../../../platform/process/sandboxDependencies'
import type { OPERATING_SYSTEM } from '../../../../../shared/platform/identifiers'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const SYSTEM_READ_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ssl', '/etc/ca-certificates', '/etc/pki', '/etc/alternatives', '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/localtime', '/etc/passwd', '/etc/group', '/etc/nsswitch.conf', '/etc/resolv.conf', '/etc/hosts', '/etc/services']

export async function createLinuxSystemPolicy(dependencies: Extract<SrtSandboxDependencies, { platform: typeof OPERATING_SYSTEM.Linux }>) {
  const denyRead = (await readdir('/', { withFileTypes: true }))
    .filter(entry => !entry.isSymbolicLink() && !['proc', 'dev', 'sys'].includes(entry.name))
    .map(entry => `/${entry.name}`)
  return {
    readPaths: [...SYSTEM_READ_PATHS, join(dependencies.srtRoot, 'vendor')],
    denyRead,
    denyWrite: [dependencies.sandboxDirectory],
    pathRoots: ['/usr', '/bin'],
    pathEntries: ['/usr/local/bin', '/usr/bin', '/bin'],
    runtime: { bwrapPath: dependencies.bwrap, socatPath: dependencies.socat, seccomp: { applyPath: dependencies.seccomp } },
  }
}
