import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ExtensionShellDescriptor } from '../../../../shared/extensions/extensionShell'
import type { SandboxCommand } from '../../../../shared/permissions/shellSandbox'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { ToolAuthorizationService } from '../../permissions/ToolAuthorizationService'
import { SandboxDirectoryPermissions } from '../SandboxDirectoryPermissions'
import { createShellCapability } from '../shellCapability'
import { resolveShellCallExecution, resolveShellExecution } from '../shellExecution'
import { ShellSelection } from '../ShellSelection'

function descriptor(): ExtensionShellDescriptor {
  return {
    extensionId: 'tests.shells',
    revision: 'package-1',
    configurationRevision: 'config-1',
    preferred: [],
    candidates: [
      { id: 'bash', label: 'Bash', dialect: 'bash', executable: '/bin/bash', version: '5', available: true },
      { id: 'zsh', label: 'Zsh', dialect: 'zsh', executable: '/bin/zsh', version: '5', available: false, reason: 'NOT_FOUND' },
    ],
  }
}

describe('shell selection snapshots', () => {
  it('narrows sandbox writes per command and never widens a read-only profile or promises host isolation', () => {
    expect(resolveShellCallExecution(resolveShellExecution('workspace_write'), { readOnly: true })).toMatchObject({ boundary: 'sandbox', readOnly: true })
    expect(resolveShellCallExecution(resolveShellExecution('read_only'), { readOnly: false })).toMatchObject({ boundary: 'sandbox', readOnly: true })
    expect(() => resolveShellCallExecution(resolveShellExecution('full_access'), { readOnly: true })).toThrow('SHELL_READ_ONLY_REQUIRES_SANDBOX')
    expect(() => resolveShellCallExecution(resolveShellExecution('workspace_write'), { readOnly: true }, true)).toThrow('SHELL_READ_ONLY_REQUIRES_SANDBOX')
    expect(() => resolveShellCallExecution(resolveShellExecution('workspace_write'), { readOnly: 'true' })).toThrow('VALIDATION_FAILED')
  })

  it('preserves the platform default until preferences opt in and rejects explicit missing or arbitrary paths', () => {
    const entry = descriptor()
    const snapshot = new ShellSelection([entry], async () => [entry])
    expect(snapshot.enabled).toBe(true)
    expect(snapshot.defaultId).toBe('system')
    expect(snapshot.resolve()).toBeUndefined()
    expect(() => snapshot.resolve('/bin/bash')).toThrow('SHELL_CANDIDATE_NOT_ENABLED')
    expect(() => snapshot.resolve('tests.shells/zsh')).toThrow('SHELL_CANDIDATE_UNAVAILABLE')
    entry.preferred = ['zsh', 'bash']
    expect(new ShellSelection([entry], async () => [entry]).defaultId).toBe('tests.shells/bash')
    expect(new ShellSelection([], async () => []).enabled).toBe(false)
  })

  it('freezes configuration for the turn but revokes new starts after disable or package replacement', async () => {
    const entry = descriptor()
    let current = [entry]
    const snapshot = new ShellSelection(current, async () => current)
    const selected = snapshot.resolve('tests.shells/bash')!
    entry.candidates[0]!.executable = '/other/bash'
    entry.configurationRevision = 'config-2'
    entry.candidates = []
    expect(selected.program.executable).toBe('/bin/bash')
    await expect(snapshot.assertCurrent(selected)).resolves.toBeUndefined()
    current = [{ ...entry, revision: 'package-2' }]
    await expect(snapshot.assertCurrent(selected)).rejects.toThrow('SHELL_CONTRIBUTION_REVOKED')
    current = []
    await expect(snapshot.assertCurrent(selected)).rejects.toThrow('SHELL_CONTRIBUTION_REVOKED')
  })

  it('keeps candidate identities distinct across providers', () => {
    const first = descriptor()
    const second = { ...descriptor(), extensionId: 'tests.other' }
    const snapshot = new ShellSelection([first, second], async () => [first, second])
    expect(snapshot.resolve('tests.shells/bash')?.extensionId).toBe('tests.shells')
    expect(snapshot.resolve('tests.other/bash')?.extensionId).toBe('tests.other')
    expect(() => snapshot.resolve('bash')).toThrow('SHELL_CANDIDATE_NOT_ENABLED')
  })

  it('uses the selected program once, preserves failure and legacy meaning, and exposes interpreter-bound approval identity', async () => {
    const controller = new AbortController()
    const run = { runId: 'test-run', signal: controller.signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {} }
    const descriptors = [descriptor()]
    const shells = new ShellSelection(descriptors, async () => descriptors)
    const submitted: Pick<SandboxCommand, 'command' | 'shell' | 'readOnly'>[] = []
    const authorization = new ToolAuthorizationService({
      approvalAvailable: true,
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
      cwd: process.cwd(),
      owner: { kind: 'conversation', id: 'test-task' },
      getGrants: () => [],
      approvalService: { request: async () => ({ approvalId: 'test-approval', decision: 'denied' }) },
    })
    const capability = createShellCapability({
      shells,
      cwd: process.cwd(),
      execution: resolveShellExecution('workspace_write', 'linux'),
      getGrants: () => [],
      getRunContext: () => run,
      authorization,
      directoryPermissions: new SandboxDirectoryPermissions(),
      sandbox: { exec: async (input, options) => {
        submitted.push(input)
        options.onData(Buffer.from('output'))
        return { exitCode: 7 }
      } },
    })
    const tools: ToolDefinition[] = []
    await capability.extension.factory({ registerTool: (tool: ToolDefinition) => tools.push(tool) } as never)
    const tool = tools.find(tool => tool.name === 'lexora_shell')!
    const parameters = { command: 'printf output; exit 7', shell: 'tests.shells/bash' }
    const result = await tool.execute('call-1', parameters, controller.signal, undefined, {} as never)
    expect(result).toMatchObject({ isError: true, structuredContent: { exit_code: 7, shell: { id: parameters.shell, dialect: 'bash', executable: '/bin/bash' } } })
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toMatchObject({ command: parameters.command, shell: { dialect: 'bash', executable: '/bin/bash' } })
    const event = { type: 'tool_call', toolCallId: 'call-1', toolName: tool.name, input: parameters } as const
    const selected = await capability.classify(event, controller.signal)
    const system = await capability.classify({ ...event, input: { command: parameters.command, shell: 'system' } }, controller.signal)
    expect(selected).toMatchObject({ shellDialect: 'bash', shellBoundary: 'sandbox' })
    expect(selected && 'approval' in selected && selected.approval?.reuse).not.toEqual(system && 'approval' in system && system.approval?.reuse)
    await tools.find(tool => tool.name === 'bash')!.execute('legacy', parameters, controller.signal, undefined, {} as never)
    expect(submitted[1]?.shell).toBeUndefined()
    await expect(tool.execute('invalid', { ...parameters, shell: '/tmp/unknown' }, controller.signal, undefined, {} as never)).rejects.toThrow('SHELL_CANDIDATE_NOT_ENABLED')
    expect(submitted).toHaveLength(2)
    const query = { ...parameters, readOnly: true }
    expect(await capability.classify({ ...event, input: query }, controller.signal)).toMatchObject({ shellReadOnly: true, shellBoundary: 'sandbox' })
    expect(await capability.classify({ ...event, toolName: 'bash', input: query }, controller.signal)).toMatchObject({ shellReadOnly: true, shellBoundary: 'sandbox' })
    await tool.execute('read-only', query, controller.signal, undefined, {} as never)
    await tools.find(tool => tool.name === 'bash')!.execute('legacy-read-only', query, controller.signal, undefined, {} as never)
    expect(submitted.slice(-2).map(input => input.readOnly)).toEqual([true, true])
    descriptors.length = 0
    await expect(tool.execute('revoked', parameters, controller.signal, undefined, {} as never)).rejects.toThrow('SHELL_CONTRIBUTION_REVOKED')
    expect(submitted).toHaveLength(4)
  })
})
