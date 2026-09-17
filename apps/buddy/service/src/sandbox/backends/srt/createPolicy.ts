import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type { SrtSandboxInput } from '../../../../../shared/permissions/shellSandbox'
import { delimiter, join } from 'node:path'
import { containsCanonicalPath } from '../../../../../platform/filesystem/filePaths'
import { resolveSandboxDependencies } from '../../../../../platform/process/sandboxDependencies'
import { OPERATING_SYSTEM } from '../../../../../shared/platform/identifiers'
import { createSandboxFilesystemPolicy, existingSandboxPaths, SANDBOX_TOOLCHAIN_PATHS } from '../../sandboxFilesystemPolicy'

import { createLinuxSystemPolicy } from './linuxPolicy'
import { createMacosSystemPolicy } from './macosPolicy'

export async function createSandboxPolicy(input: SrtSandboxInput, signal: AbortSignal): Promise<{ config: SandboxRuntimeConfig, path: string }> {
  signal.throwIfAborted()
  const dependencies = await resolveSandboxDependencies({ backend: input.backend, searchDirectory: input.searchDirectory }, signal)
  const { rg, srtRoot } = dependencies
  const system = dependencies.platform === OPERATING_SYSTEM.Linux ? await createLinuxSystemPolicy(dependencies) : createMacosSystemPolicy()
  const policy = await createSandboxFilesystemPolicy(input, rg, signal)
  const toolchains = await existingSandboxPaths(SANDBOX_TOOLCHAIN_PATHS.map(path => join(input.home, path)))
  const searchPaths = await existingSandboxPaths(input.path.split(delimiter).filter(path => path.startsWith('/')))
  const pathEntries = searchPaths.filter(path => [...toolchains, ...system.pathRoots].some(root => containsCanonicalPath(root, path)))
  const runtimePaths = await existingSandboxPaths([...system.readPaths, ...toolchains, input.searchDirectory])
  const paths = (access: typeof policy[number]['access']) => policy.filter(grant => grant.access === access).map(grant => grant.path)
  return {
    path: [...new Set([...pathEntries, ...system.pathEntries])].join(delimiter),
    config: {
      ...system.runtime,
      ripgrep: { command: rg },
      filesystem: {
        denyRead: [...system.denyRead, ...paths('denyRead')],
        allowRead: [...runtimePaths, ...paths('read'), ...paths('write'), input.privateRoot],
        allowWrite: [input.privateRoot, ...paths('write')],
        denyWrite: [...runtimePaths.filter(path => !path.startsWith('/dev/')), ...system.denyWrite, srtRoot, ...paths('denyWrite'), ...policy.filter(grant => grant.access === 'denyRead' && !grant.exceptions.length).map(grant => grant.path), '/tmp/claude', '/private/tmp/claude'],
      },
      network: {
        allowedDomains: [],
        deniedDomains: [],
        deniedResolvedAddresses: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7'],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
    },
  }
}
