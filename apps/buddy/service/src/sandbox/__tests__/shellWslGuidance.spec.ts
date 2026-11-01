import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { BuddyExecutionProfile } from '../../../../shared/permissions/executionProfile'
import { describe, expect, it } from 'vitest'
import { SandboxDirectoryPermissions } from '../SandboxDirectoryPermissions'
import { createShellCapability } from '../shellCapability'
import { resolveShellExecution } from '../shellExecution'
import { ShellSelection } from '../ShellSelection'

const wslRoot = String.raw`\\wsl.localhost\Ubuntu-24.04\home\lenovo\code\Foo`
const NOTE = 'but this shell runs on Windows. Run project commands'

async function descriptions(cwd: string, profile: BuddyExecutionProfile) {
  const execution = resolveShellExecution(profile, 'win32')
  const signal = new AbortController().signal
  const tools = new Map<string, ToolDefinition>()
  const descriptors = [{ extensionId: 'fixture.shells', revision: '1', configurationRevision: '1', preferred: [], candidates: [] }]
  const capability = createShellCapability({
    cwd,
    execution,
    getExecution: () => execution,
    shells: new ShellSelection(descriptors, async () => descriptors),
    getGrants: () => [],
    getRunContext: () => ({ runId: 'guidance', signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {} }),
    authorization: { authorize: async () => null },
    directoryPermissions: new SandboxDirectoryPermissions(),
    sandbox: undefined,
  })
  await capability.extension.factory({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as never)
  return new Map([...tools].map(([name, tool]) => [name, tool.description]))
}

describe('windows shell tools in a WSL project', () => {
  it.each(['read_only', 'workspace_write', 'full_access'] as const)('send project commands to lexora_wsl_shell in %s', async (profile) => {
    const found = await descriptions(wslRoot, profile)
    for (const name of ['powershell', 'lexora_shell', 'lexora_host_shell']) {
      expect(found.get(name), name).toContain(NOTE)
      expect(found.get(name), name).toContain('(Ubuntu-24.04)')
      expect(found.get(name), name).toContain('lexora_wsl_shell')
    }
    expect(found.get('powershell')).toContain('Use this shell only for Windows programs')
  })

  it('does not point lexora_shell back to wsl.exe when the new tool is there', async () => {
    const description = (await descriptions(wslRoot, 'full_access')).get('lexora_shell')!
    expect(description).toContain('for WSL directories use lexora_wsl_shell when it is available; otherwise follow the Directory context notes and run commands through wsl.exe')
  })

  it('leaves the descriptions of an ordinary project unchanged', async () => {
    const found = await descriptions('C:\\work\\Foo', 'full_access')
    for (const [name, description] of found)
      expect(description, name).not.toContain(NOTE)
  })
})
