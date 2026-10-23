import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { BuddyExecutionProfile } from '../../../../shared/permissions/executionProfile'
import type { ShellSandboxClient } from '../ShellSandboxClient'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { Check } from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { SandboxDirectoryPermissions } from '../SandboxDirectoryPermissions'
import { createShellCapability } from '../shellCapability'
import { resolveShellExecution } from '../shellExecution'
import { ShellSelection } from '../ShellSelection'

const profiles = ['read_only', 'workspace_write', 'full_access'] as const

async function fixture(profile: BuddyExecutionProfile, platform: NodeJS.Platform, selection = true, sandbox?: Pick<ShellSandboxClient, 'exec'>) {
  let execution = resolveShellExecution(profile, platform)
  const signal = new AbortController().signal
  const tools = new Map<string, ToolDefinition>()
  const descriptors = [{ extensionId: 'fixture.shells', revision: '1', configurationRevision: '1', preferred: [], candidates: [] }]
  const capability = createShellCapability({
    cwd: process.cwd(),
    execution,
    getExecution: () => execution,
    shells: selection ? new ShellSelection(descriptors, async () => descriptors) : undefined,
    getGrants: () => [],
    getRunContext: () => ({ runId: 'shell-contract', signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {} }),
    authorization: { authorize: async () => { throw new Error('Unexpected network request') } },
    directoryPermissions: new SandboxDirectoryPermissions(),
    sandbox,
    assertExecutionAllowed: sandbox ? undefined : ({ boundary, readOnly }) => { throw new Error(`DISPATCH:${boundary}:${readOnly}`) },
  })
  await capability.extension.factory({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as never)
  return {
    tools,
    capability,
    signal,
    names: [execution.dialect, ...selection ? ['lexora_shell'] : []],
    setProfile(profile: BuddyExecutionProfile) {
      execution = resolveShellExecution(profile, platform)
      capability.refreshExecution()
    },
  }
}

describe.each(['win32', 'linux', 'darwin'] as const)('shell execution contract on %s', (platform) => {
  it.each(profiles)('keeps advertised inputs and effective execution consistent in %s', async (profile) => {
    const f = await fixture(profile, platform)
    for (const name of f.names) {
      const tool = f.tools.get(name)!
      const input = { command: 'read-only-query' }
      expect(Check(tool.parameters, input)).toBe(true)
      expect(Check(tool.parameters, { ...input, readOnly: true })).toBe(profile !== 'full_access')
      expect(tool.description).toContain(`Current mode: ${profile === 'full_access' ? 'full access' : profile.replace('_', '-')}`)
      const boundary = profile === 'full_access' ? 'host' : 'sandbox'
      await expect(tool.execute('inherited', input, f.signal, undefined, {} as never)).rejects.toThrow(`DISPATCH:${boundary}:${profile === 'read_only'}`)
      const query = { ...input, readOnly: true }
      const classification = await f.capability.classify({ type: 'tool_call', toolCallId: 'query', toolName: name, input: query }, f.signal)
      if (profile === 'full_access') {
        expect(tool.promptGuidelines?.join('\n')).toContain('omit readOnly')
        expect(tool.promptGuidelines?.join('\n')).not.toContain('Use readOnly=true')
        expect(tool.description).not.toContain('Other network destinations require approval')
        expect(classification).toEqual({ blocked: true, reason: 'SHELL_READ_ONLY_REQUIRES_SANDBOX' })
        await expect(tool.execute('stale-query', query, f.signal, undefined, {} as never)).rejects.toThrow('SHELL_READ_ONLY_REQUIRES_SANDBOX')
      }
      else {
        expect(classification).toMatchObject({ shellBoundary: 'sandbox', shellReadOnly: true })
        expect(f.capability.mutationEffect?.({ type: 'tool_call', toolCallId: 'query', toolName: name, input: query }, { access: 'execute', shellBoundary: 'sandbox', shellReadOnly: true })).toMatchObject({ kind: 'workspace' })
        await expect(tool.execute('narrowed', query, f.signal, undefined, {} as never)).rejects.toThrow('DISPATCH:sandbox:true')
        await expect(tool.execute('false', { ...input, readOnly: false }, f.signal, undefined, {} as never)).rejects.toThrow(`DISPATCH:sandbox:${profile === 'read_only'}`)
      }
    }
    const host = f.tools.get('lexora_host_shell')!
    expect(Check(host.parameters, { command: 'query', readOnly: true })).toBe(false)
    await expect(host.execute('host', { command: 'query', readOnly: true }, f.signal, undefined, {} as never)).rejects.toThrow('SHELL_READ_ONLY_REQUIRES_SANDBOX')
    expect(f.capability.mutationEffect?.({ type: 'tool_call', toolCallId: 'host', toolName: 'lexora_host_shell', input: { command: 'query' } }, { access: 'execute' })).toMatchObject({ kind: 'host' })
  })

  it('keeps an already dispatched sandbox command on its original policy during a mode switch', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const f = await fixture('workspace_write', platform, true, { exec: async (input, options) => {
      expect(input.readOnly).toBe(true)
      entered.resolve()
      await release.promise
      expect(input.readOnly).toBe(true)
      options.onData(Buffer.from('completed in original sandbox'))
      return { exitCode: 0 }
    } })
    const pending = f.tools.get('lexora_shell')!.execute('running', { command: 'echo sandbox', readOnly: true }, f.signal, undefined, {} as never)
    try {
      await entered.promise
      f.setProfile('full_access')
      expect(f.tools.get('lexora_shell')!.parameters).not.toHaveProperty('properties.readOnly')
    }
    finally { release.resolve() }
    expect(await pending).toMatchObject({ structuredContent: { exit_code: 0, output: 'completed in original sandbox' } })
  })

  it.each([false, true])('refreshes both directions without changing prior declarations, selection=%s', async (selection) => {
    const f = await fixture('workspace_write', platform, selection)
    const previous = f.tools.get(f.names[0]!)!
    f.setProfile('full_access')
    for (const name of f.names) {
      expect(f.tools.get(name)!.parameters).not.toHaveProperty('properties.readOnly')
      expect(f.tools.get(name)!.promptGuidelines?.join('\n')).toContain('omit readOnly')
    }
    expect(previous.parameters).toHaveProperty('properties.readOnly')
    await expect(previous.execute('stale', { command: 'query', readOnly: true }, f.signal, undefined, {} as never)).rejects.toThrow('SHELL_READ_ONLY_REQUIRES_SANDBOX')
    f.setProfile('read_only')
    for (const name of f.names) {
      expect(f.tools.get(name)!.parameters).toHaveProperty('properties.readOnly')
      expect(f.tools.get(name)!.promptGuidelines?.join('\n')).toContain('already inherit the read-only sandbox policy')
    }
    f.setProfile('workspace_write')
    for (const name of f.names)
      expect(f.tools.get(name)!.promptGuidelines?.join('\n')).toContain('Use readOnly=true only')
  })
})
