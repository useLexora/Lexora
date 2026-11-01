import type { BuddyExtensionRunContext } from '../../agent/extensions/BuddyExtensionRunContext'
import type { RunWslShell, WslShellRequest } from '../../wsl/WslHostPool'
import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { createWslShellCapability, WSL_SHELL_EXTENSION, WSL_SHELL_TOOL_NAME } from '../wslShellCapability'

const wslRoot = String.raw`\\wsl.localhost\Ubuntu-24.04\home\lenovo\code\Foo`
const signal = new AbortController().signal

interface Registered {
  name: string
  label: string
  description: string
  promptGuidelines: string[]
  execute: (...args: unknown[]) => Promise<{ content: { text: string }[], isError?: boolean }>
}

function setup(cwd: string, overrides: { shell?: RunWslShell, run?: BuddyExtensionRunContext | null, assertExecutionAllowed?: () => void | Promise<void> } = {}) {
  const run = overrides.run === undefined ? { runId: 'run-1', signal } as unknown as BuddyExtensionRunContext : overrides.run
  const shell = overrides.shell ?? vi.fn<RunWslShell>(async () => ({ exitCode: 0 }))
  const capability = createWslShellCapability({ cwd, getRunContext: () => run, assertExecutionAllowed: overrides.assertExecutionAllowed, shell })
  const tools = new Map<string, Registered>()
  capability.extension.factory({ registerTool: (tool: Registered) => tools.set(tool.name, tool) } as never)
  const call = (command: unknown, context: { cwd: string }, parameters: object = {}, abort?: AbortSignal) => tools.get(WSL_SHELL_TOOL_NAME)!.execute('call-1', { command, ...parameters }, abort, undefined, context)
  return { capability, tools, call, shell }
}

describe('wsl shell capability', () => {
  it('is offered only when the working directory is in WSL', () => {
    const wsl = setup(wslRoot)
    expect(wsl.capability.extension.name).toBe(WSL_SHELL_EXTENSION)
    expect(wsl.tools.get(WSL_SHELL_TOOL_NAME)).toMatchObject({ name: 'lexora_wsl_shell', label: 'WSL shell' })
    expect(wsl.tools.get(WSL_SHELL_TOOL_NAME)!.description).toContain('Ubuntu-24.04')
    expect(wsl.capability.disclosure).toEqual([expect.objectContaining({ exposure: 'direct', tools: [{ name: 'lexora_wsl_shell' }] })])

    const local = setup('C:\\work\\Foo')
    expect(local.tools.size).toBe(0)
    expect(local.capability.disclosure).toEqual([])
  })

  it('tells the model to pass a bash command with Linux paths, without wsl.exe or script files', () => {
    const guidelines = setup(wslRoot).tools.get(WSL_SHELL_TOOL_NAME)!.promptGuidelines.join('\n')
    expect(guidelines).toContain('Do not run wsl.exe through another shell, quote for PowerShell, or write a temporary script file')
    expect(guidelines).toContain('each one needs approval unless full access is on')
  })

  it('classifies the call as a bash execution outside the sandbox, approved per command and distribution', async () => {
    const { capability } = setup(wslRoot)
    const event = { toolName: WSL_SHELL_TOOL_NAME, input: { command: 'git status' } } as never
    const classification = await capability.classify(event, signal)
    expect(classification).toMatchObject({ access: 'execute', shellDialect: 'bash', approval: { summary: expect.stringContaining('WSL (Ubuntu-24.04)') } })
    expect(classification).not.toHaveProperty('shellBoundary')
    expect(classification).toMatchObject({ approval: { reuse: { operation: [WSL_SHELL_TOOL_NAME, 'Ubuntu-24.04', { command: 'git status' }], source: [WSL_SHELL_TOOL_NAME, 'Ubuntu-24.04'] } } })
    expect(await capability.classify({ toolName: 'bash', input: {} } as never, signal)).toBeNull()
    expect(await setup('C:\\work').capability.classify(event, signal)).toBeNull()
  })

  it('holds the workspace as a host mutation while it runs, with no process of its own to recover', () => {
    const { capability } = setup(wslRoot)
    expect(capability.workspaceMutationTools).toEqual([WSL_SHELL_TOOL_NAME])
    expect(capability.mutationEffect!({ toolName: WSL_SHELL_TOOL_NAME } as never, {})).toEqual({ kind: 'host', ownedProcess: false })
    expect(capability.mutationEffect!({ toolName: 'bash' } as never, {})).toBeNull()
  })

  it('runs the command in the Linux path of the session directory and returns its output', async () => {
    const shell = vi.fn<RunWslShell>(async (request: WslShellRequest) => {
      request.onData(Buffer.from('on branch main\n'))
      return { exitCode: 0 }
    })
    const { call } = setup(wslRoot, { shell })
    const result = await call('git status', { cwd: `${wslRoot}\\apps\\web` }, { timeout: 30 })
    expect(result.content[0]!.text).toBe('on branch main\n')
    expect(shell).toHaveBeenCalledOnce()
    expect(shell.mock.calls[0]![0]).toMatchObject({ distribution: 'Ubuntu-24.04', cwd: '/home/lenovo/code/Foo/apps/web', command: 'git status', timeout: 30 })
  })

  it('reports a failing command, an abort and a timeout the way the built-in shell tools do', async () => {
    const failing = setup(wslRoot, { shell: async (request) => {
      request.onData(Buffer.from('boom\n'))
      return { exitCode: 2 }
    } })
    expect(await failing.call('false', { cwd: wslRoot })).toMatchObject({ isError: true, content: [{ text: 'boom\n\n\nCommand exited with code 2' }] })
    const aborted = setup(wslRoot, { shell: async () => {
      throw new Error('aborted')
    } })
    await expect(aborted.call('sleep 9', { cwd: wslRoot })).rejects.toThrow('Command aborted')
    const slow = setup(wslRoot, { shell: async () => {
      throw new Error('timeout:5')
    } })
    await expect(slow.call('sleep 9', { cwd: wslRoot }, { timeout: 5 })).rejects.toThrow('Command timed out after 5 seconds')
  })

  it('refuses a directory outside WSL and an invalid timeout without starting anything', async () => {
    const { call, shell } = setup(wslRoot)
    await expect(call('ls', { cwd: 'C:\\work' })).rejects.toThrow('runs only in a directory inside WSL')
    for (const timeout of [0, -1, Number.NaN, 3_000_000_000])
      await expect(call('ls', { cwd: wslRoot }, { timeout })).rejects.toThrow('Invalid timeout')
    expect(shell).not.toHaveBeenCalled()
  })

  it('checks that execution is allowed first, and needs a run', async () => {
    const denied = vi.fn(async () => {
      throw new Error('SHELL_EXECUTION_DELEGATED')
    })
    const blocked = setup(wslRoot, { assertExecutionAllowed: denied })
    await expect(blocked.call('ls', { cwd: wslRoot })).rejects.toThrow('SHELL_EXECUTION_DELEGATED')
    expect(denied).toHaveBeenCalledWith({ run: expect.objectContaining({ runId: 'run-1' }) })
    expect(blocked.shell).not.toHaveBeenCalled()
    const idle = setup(wslRoot, { run: null })
    await expect(idle.call('ls', { cwd: wslRoot })).rejects.toThrow('WSL_SHELL_UNAVAILABLE')
    expect(idle.shell).not.toHaveBeenCalled()
  })

  it('stops the command when the run is cancelled', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const { call } = setup(wslRoot, {
      run: { runId: 'run-1', signal: controller.signal } as unknown as BuddyExtensionRunContext,
      shell: async (request) => {
        seen = request.signal
        return { exitCode: 0 }
      },
    })
    await call('ls', { cwd: wslRoot })
    expect(seen?.aborted).toBe(false)
    controller.abort()
    expect(seen?.aborted).toBe(true)
  })
})
