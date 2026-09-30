import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { SandboxNetworkTarget } from '../../../../shared/permissions/shellSandbox'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { createBuddyToolPresentation } from '../../agent/events/toolPresentation'
import { ApprovalCancelledError, ApprovalExpiredError } from '../../approvals/ApprovalService'
import { ToolAuthorizationService } from '../../permissions/ToolAuthorizationService'
import { SandboxDirectoryPermissions } from '../SandboxDirectoryPermissions'
import { createShellCapability } from '../shellCapability'
import { resolveShellExecution } from '../shellExecution'

const target = { host: 'registry.example.test', port: 443 }

async function fixture(options: {
  dialect?: 'bash' | 'powershell'
  decision?: 'denied' | 'approved_once' | Error
  exitCode?: number
  background?: boolean
  targets?: SandboxNetworkTarget[]
  stop?: boolean
} = {}) {
  const controller = new AbortController()
  const decisions: boolean[] = []
  const targets = options.targets ?? [target]
  const run = { runId: 'run-1', signal: controller.signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {} }
  const authorization = new ToolAuthorizationService({
    approvalAvailable: !options.background,
    approvalPolicy: 'policy',
    executionProfile: 'workspace_write',
    cwd: '/workspace',
    owner: { kind: 'conversation', id: 'conversation-1' },
    getGrants: () => [],
    approvalService: {
      request: async () => {
        if (options.stop) {
          controller.abort()
          throw new ApprovalCancelledError()
        }
        if (options.decision instanceof Error)
          throw options.decision
        return { approvalId: 'approval-1', decision: options.decision ?? 'denied' }
      },
    },
  })
  const capability = createShellCapability({
    cwd: '/workspace',
    execution: resolveShellExecution('workspace_write', options.dialect === 'powershell' ? 'win32' : 'linux'),
    getGrants: () => [],
    getRunContext: () => run,
    authorization,
    directoryPermissions: new SandboxDirectoryPermissions(),
    sandbox: {
      exec: async (_input, execOptions, approveNetwork) => {
        for (const destination of targets)
          decisions.push(await approveNetwork(destination).catch(() => false))
        execOptions.signal?.throwIfAborted()
        execOptions.onData(Buffer.from('original-command-output'))
        return { exitCode: options.exitCode ?? 22 }
      },
    },
  })
  const tools: ToolDefinition[] = []
  await capability.extension.factory({ registerTool: (tool: ToolDefinition) => tools.push(tool) } as never)
  const tool = tools.find(tool => tool.name === (options.dialect ?? 'bash'))!
  return {
    decisions,
    targets,
    invoke: () => tool.execute('tool-call-1', { command: 'fixture' }, controller.signal, undefined, {} as never),
  }
}

describe.each(['bash', 'powershell'] as const)('%s network authorization feedback', (dialect) => {
  it.each([
    ['denied' as const, 'APPROVAL_DENIED'],
    [new ApprovalCancelledError(), 'APPROVAL_CANCELLED'],
    [new ApprovalExpiredError(), 'AUTOMATION_APPROVAL_EXPIRED'],
    [new Error('synthetic-private-error-detail'), 'NETWORK_APPROVAL_FAILED'],
  ])('preserves authorization outcome %s without replacing the command exit status', async (decision, code) => {
    const check = await fixture({ dialect, decision })
    const result = await check.invoke()
    expect(result.isError).toBe(true)
    const output = result.content.find(item => item.type === 'text')!.text
    expect(output).toContain('original-command-output')
    expect(output).toContain(JSON.stringify({ ...target, code }))
    expect(output).not.toContain('synthetic-private-error-detail')
    if (code !== 'APPROVAL_DENIED')
      expect(output).not.toContain('APPROVAL_DENIED')
    expect(output).toMatch(/Command exited with code 22$/)
    expect(check.decisions).toEqual([false])
    expect(createBuddyToolPresentation({ toolName: dialect, arguments: { command: 'fixture' }, isError: true, result })).toMatchObject({ card: 'terminal', exitCode: 22 })
  })

  it('keeps successful command recovery successful while reporting the refused request', async () => {
    const check = await fixture({ dialect, exitCode: 0 })
    const result = await check.invoke()
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('original-command-output') }])
    expect(JSON.stringify(result)).toContain('APPROVAL_DENIED')
    expect(createBuddyToolPresentation({ toolName: dialect, arguments: { command: 'fixture' }, isError: false, result })).toMatchObject({ card: 'terminal', exitCode: 0 })
    expect(check.decisions).toEqual([false])
  })

  it('keeps an ordinary failure free of network or sandbox advice', async () => {
    const check = await fixture({ dialect, decision: 'approved_once', exitCode: 7 })
    await expect(check.invoke()).resolves.toMatchObject({ isError: true, content: [{ type: 'text', text: 'original-command-output\n\nCommand exited with code 7' }], structuredContent: { exit_code: 7 } })
    expect(check.decisions).toEqual([true])
  })

  it('keeps background unavailability distinct from user refusal', async () => {
    const check = await fixture({ dialect, background: true })
    const result = await check.invoke()
    expect(result.isError).toBe(true)
    const output = result.content.find(item => item.type === 'text')!.text
    expect(output).toContain(JSON.stringify({ ...target, code: 'APPROVAL_UNAVAILABLE_IN_BACKGROUND' }))
    expect(check.decisions).toEqual([false])
  })

  it('does not carry a previous command refusal into the next command', async () => {
    const check = await fixture({ dialect, exitCode: 0 })
    expect(JSON.stringify(await check.invoke())).toContain('[Network authorization]')
    check.targets.length = 0
    expect((await check.invoke()).content).toEqual([{ type: 'text', text: 'original-command-output' }])
  })

  it('does not reclassify stopping the run as a declined network request', async () => {
    const check = await fixture({ dialect, stop: true })
    const error = await check.invoke().catch(error => error as Error)
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error))
      throw new Error('Expected cancellation')
    expect(error.message).not.toContain('[Network authorization]')
    expect(error.message).not.toContain('APPROVAL_DENIED')
  })
})

it('bounds feedback without changing any network authorization decision', async () => {
  const check = await fixture({ exitCode: 0, targets: Array.from({ length: 20 }, (_, index) => ({ host: `target-${index}.example.test`, port: 443 })) })
  const result = await check.invoke()
  const text = result.content.find(item => item.type === 'text')!.text
  const feedback = JSON.parse(text.split('[Network authorization]\n')[1]!.split('\n')[0]!)
  expect(feedback.requests).toHaveLength(16)
  expect(feedback.omitted).toBe(4)
  expect(check.decisions).toEqual(Array.from({ length: 20 }).fill(false))
})
