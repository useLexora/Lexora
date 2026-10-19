import type { SrtSandboxDependencies } from '../../../../../platform/process/sandboxDependencies'
import type { OPERATING_SYSTEM } from '../../../../../shared/platform/identifiers'
import { join } from 'node:path'

const SYSTEM_READ_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ssl', '/etc/ca-certificates', '/etc/pki', '/etc/alternatives', '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/localtime', '/etc/passwd', '/etc/group', '/etc/nsswitch.conf', '/etc/resolv.conf', '/etc/hosts', '/etc/services']

export async function createLinuxSystemPolicy(dependencies: Extract<SrtSandboxDependencies, { platform: typeof OPERATING_SYSTEM.Linux }>) {
  return {
    readPaths: [...SYSTEM_READ_PATHS, join(dependencies.srtRoot, 'vendor'), ...(dependencies.privateUnixSockets ? [dependencies.bwrap, dependencies.processControl] : [])],
    denyRead: [] as string[],
    denyWrite: [dependencies.sandboxDirectory],
    pathRoots: ['/usr', '/bin'],
    pathEntries: ['/usr/local/bin', '/usr/bin', '/bin'],
    runtime: {
      bwrapPath: dependencies.bwrap,
      socatPath: dependencies.socat,
      seccomp: dependencies.privateUnixSockets
        ? { applyPath: dependencies.processControl, argv0: 'lexora-sandbox-ipc' }
        : { applyPath: dependencies.seccomp },
    },
  }
}
