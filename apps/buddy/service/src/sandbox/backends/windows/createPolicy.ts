import type { SandboxBackendInput } from '../../../../../shared/permissions/shellSandbox'
import type { SHELL_SANDBOX_BACKEND } from '../../../../../shared/platform/identifiers'
import { dirname, join } from 'node:path'
import { containsCanonicalPath } from '../../../../../platform/filesystem/filePaths'
import { createSandboxFilesystemPolicy, existingSandboxPaths, inspectSandboxPath, SANDBOX_TOOLCHAIN_PATHS } from '../../sandboxFilesystemPolicy'

export async function createWindowsSandboxPolicy(input: SandboxBackendInput<typeof SHELL_SANDBOX_BACKEND.Windows>, signal: AbortSignal) {
  const grants = await createSandboxFilesystemPolicy(input, join(input.searchDirectory, 'rg.exe'), signal)
  const toolchains = await existingSandboxPaths(SANDBOX_TOOLCHAIN_PATHS.map(path => join(input.home, path)))
  const runtime = [...toolchains, input.searchDirectory]
  for (const path of runtime.filter(path => !grants.some(grant => (grant.access === 'read' || grant.access === 'write') && containsCanonicalPath(grant.path, path))))
    grants.push(await inspectSandboxPath(path, 'read'))
  const paths = [dirname(input.backend.shell), join(input.backend.systemRoot, 'System32'), input.searchDirectory, ...input.path.split(';').filter(path => runtime.some(root => containsCanonicalPath(root, path)))]
  return { grants, path: [...new Set(paths)].join(';') }
}
