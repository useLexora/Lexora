import type { SandboxBackendInput } from '../../../../../shared/permissions/shellSandbox'
import type { SHELL_SANDBOX_BACKEND } from '../../../../../shared/platform/identifiers'
import type { SandboxFilesystemPolicyInput } from '../../sandboxFilesystemPolicy'
import { dirname, join } from 'node:path'
import { validateWindowsFilePath } from '../../../../../platform/windows/filePath'
import { createSandboxFilesystemPolicy, existingSandboxPaths, inspectSandboxPath } from '../../sandboxFilesystemPolicy'

type WindowsSandboxPolicyInput = SandboxFilesystemPolicyInput & Pick<SandboxBackendInput<typeof SHELL_SANDBOX_BACKEND.Windows>, 'backend' | 'path' | 'searchDirectory'>

export async function createWindowsSandboxPolicy(input: WindowsSandboxPolicyInput, signal: AbortSignal) {
  const grants = await createSandboxFilesystemPolicy(input, signal)
  const paths: string[] = []
  for (const entry of input.path.split(';')) {
    try {
      const path = validateWindowsFilePath(entry.replace(/^"|"$/g, ''))
      if (/^[a-z]:\\/i.test(path))
        paths.push(path)
    }
    catch {}
  }
  const localPaths = (await existingSandboxPaths(paths)).filter(path => /^[a-z]:\\/i.test(path))
  const roots = [...new Set([...await existingSandboxPaths([dirname(input.backend.shell), join(input.backend.systemRoot, 'System32'), input.searchDirectory]), ...localPaths])]
  for (const root of roots)
    grants.push(await inspectSandboxPath(root, 'read'))
  return { grants, path: roots.join(';') }
}
