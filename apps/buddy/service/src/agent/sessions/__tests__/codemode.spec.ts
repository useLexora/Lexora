import type { Api, AssistantMessage, Model, ToolCall } from '@earendil-works/pi-ai'
import type { AgentSessionEvent, createCodemodeExtension } from '@earendil-works/pi-coding-agent'
import type { BuddyExecutionProfile } from '../../../../../shared/permissions/executionProfile'
import type { AuthorizedToolExecution, DeniedToolExecution } from '../../events/projectPiEvent'
import type { BuddySessionExtensionServices } from '../../extensions/createBuddySessionExtensions'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RUNTIME_PREFERENCES } from '../../../../../shared/runtime/runtimePreferences'
import { ApprovalCancelledError } from '../../../approvals/ApprovalService'
import { MutationCoordinator } from '../../../changes/MutationCoordinator'
import { FileResourceCoordinator } from '../../../files/FileResourceCoordinator'
import { NativeFileEngine } from '../../../files/NativeFileEngine'
import { createEstimatedContextUsage } from '../../context/contextUsageBreakdown'
import { CODEMODE_EXTENSION, CodemodeCleanupIncompleteError, createCodemodeCapability } from '../../extensions/codemodeExtension'
import { createBuddySessionExtensions } from '../../extensions/createBuddySessionExtensions'
import { createReusableBuddySession } from '../createReusableBuddySession'
import { createIsolatedBuddyContextSnapshot, createIsolatedBuddySession } from './isolatedBuddySession'

type FixtureCall = Pick<ToolCall, 'name' | 'arguments'>

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

describe('codemode runtime preference', () => {
  it('keeps collaboration control available only as a native model tool', async () => {
    const fixture = await createFixture()
    fixture.apply(true)
    await fixture.turn({ name: 'codemode', arguments: { code: 'text({ callable: "lexora_agents" in tools, listed: ALL_TOOLS.some(tool => tool.name === "lexora_agents") });' } })
    expect(fixture.requests.at(-1)?.names).toContain('lexora_agents')
    expect(fixture.lastResult()).toContain('"callable":false')
    expect(fixture.lastResult()).toContain('"listed":false')
    await fixture.turn({ name: 'lexora_agents', arguments: { operation: 'status' } })
    expect(fixture.lastResult()).toBe('{"status":"working","updates":[]}')
  })

  it('cannot be enabled through discovery or expose host globals', async () => {
    const fixture = await createFixture()
    await fixture.turn({ name: 'lexora_tool_search', arguments: { toolNames: ['codemode'] } })
    expect(fixture.requests.at(-1)?.names).not.toContain('codemode')
    expect(fixture.lastResult()).toContain('"notFound":["codemode"]')
    expect(fixture.requests.at(-1)?.prompt).not.toMatch(/\b(?:searchTools|describeNamespace)\b/)

    fixture.apply(true)
    await fixture.turn({ name: 'codemode', arguments: { code: 'text({ node: typeof process, network: typeof fetch, models: typeof models });' } })
    expect(fixture.lastResult()).toContain('"node":"undefined"')
    expect(fixture.lastResult()).toContain('"network":"undefined"')
    expect(fixture.lastResult()).toContain('"models":"undefined"')
    expect(fixture.requests.at(-1)?.names).toContain('codemode')
    expect(fixture.requests.at(-1)?.names).not.toContain('read')
    expect(fixture.requests.at(-1)?.prompt).toContain('describeNamespace')

    fixture.apply(false)
    await fixture.turn()
    expect(fixture.requests.at(-1)?.names).not.toContain('codemode')
    expect(fixture.requests.at(-1)?.names).toContain('read')
    expect(fixture.requests.at(-1)?.prompt).not.toMatch(/\b(?:searchTools|describeNamespace)\b/)

    fixture.apply(true)
    await fixture.turn()
    expect((await fixture.preview())?.toolTokens).toBe(fixture.requests.at(-1)?.toolTokens)
  })

  it('authorizes nested tools individually and keeps their parent and bounded journal records', async () => {
    const fixture = await createFixture('workspace_write')
    const outside = join(fixture.root, 'outside.txt')
    await writeFile(outside, 'unchanged')
    fixture.apply(true)
    await fixture.turn({
      name: 'codemode',
      arguments: {
        code: `const results = await Promise.allSettled([tools.read({ path: "allowed.txt" }), tools.write({ path: ${JSON.stringify(outside)}, content: "blocked" })]); for (const result of results) text(result.status === "fulfilled" ? result.value : result.reason.message);`,
      },
    })
    expect(fixture.lastResult()).toContain('allowed content')
    expect(fixture.lastResult()).toContain('APPROVAL_DENIED')
    expect(await readFile(outside, 'utf8')).toBe('unchanged')
    const nested = fixture.events.flatMap(event => event.type === 'tool_execution_end' && event.parentToolCallId ? [event] : [])
    expect(nested).toEqual(expect.arrayContaining([
      expect.objectContaining({ parentToolCallId: 'call-1', toolCallId: expect.stringMatching(/^call-1\/\d+$/), toolName: 'read', isError: false }),
      expect.objectContaining({ parentToolCallId: 'call-1', toolCallId: expect.stringMatching(/^call-1\/\d+$/), toolName: 'write', isError: true }),
    ]))
    expect(new Set(nested.map(event => event.toolCallId)).size).toBe(2)
    expect(fixture.authorized.map(call => call.toolName)).toEqual(['codemode', 'read'])
    expect(fixture.denied).toEqual([expect.objectContaining({ toolName: 'write', denialCode: 'APPROVAL_DENIED' })])
    const result = fixture.session.messages.find(message => message.role === 'toolResult')
    expect(result).toMatchObject({ toolName: 'codemode', nestedCalls: {
      complete: true,
      calls: [{ name: 'read', status: 'ok' }, { name: 'write', status: 'error' }],
    } })
    const journal = fixture.session.sessionManager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'toolResult')
    expect(journal).toHaveLength(1)
  })

  it('keeps read-only file protection for scripts', async () => {
    const fixture = await createFixture('read_only')
    fixture.apply(true)
    await fixture.turn({ name: 'codemode', arguments: { code: 'await tools.write({ path: "allowed.txt", content: "blocked" });' } })
    expect(fixture.lastResult()).toContain('READ_ONLY_PROFILE')
    expect(await readFile(join(fixture.cwd, 'allowed.txt'), 'utf8')).toBe('allowed content')
  })

  it('interrupts runaway microtasks that cannot reach a host tool', async () => {
    const code = 'while (true) { await Promise.resolve(); }'
    const fixture = await createFixture('read_only', { computeTimeoutMs: 100 })
    fixture.apply(true)
    await fixture.turn({ name: 'codemode', arguments: { code } })
    expect(fixture.lastResult()).toContain('100 ms compute budget')
    expect(fixture.session.isStreaming).toBe(false)
    expect(fixture.gates).toHaveLength(0)
  })

  it('excludes host tool waiting from computation and accumulates computation across awaits', async () => {
    const fixture = await createFixture('read_only', { computeTimeoutMs: 200 })
    fixture.apply(true)
    const waiting = fixture.turn({ name: 'codemode', arguments: { code: 'await tools.lexora_gate({ value: 0 }); text("wait completed");' } })
    await vi.waitFor(() => expect(fixture.gates).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 300))
    fixture.gates[0]!.release()
    await waiting
    expect(fixture.lastResult()).toContain('wait completed')

    const computing = fixture.turn({ name: 'codemode', arguments: { code: 'for (let i = 1; i <= 4; i++) { const start = Date.now(); while (Date.now() - start < 85) {} await tools.lexora_gate({ value: i }); } text("budget reset incorrectly");' } })
    for (let index = 1; index <= 2; index++) {
      await vi.waitFor(() => expect(fixture.gates).toHaveLength(index + 1))
      fixture.gates[index]!.release()
    }
    await computing
    expect(fixture.lastResult()).toContain('200 ms compute budget')
    expect(fixture.lastResult()).not.toContain('budget reset incorrectly')
    expect(fixture.gates).toHaveLength(3)
  })

  it('bounds parallel calls and drains waiting calls in order', async () => {
    const fixture = await createFixture('read_only', { computeTimeoutMs: 1000, maxPendingToolCalls: 2, maxQueuedToolCalls: 4 })
    fixture.apply(true)
    const task = fixture.turn({ name: 'codemode', arguments: { code: 'text(await Promise.all([0, 1, 2, 3, 4, 5].map(value => tools.lexora_gate({ value }))));' } })
    await vi.waitFor(() => expect(fixture.gates.map(gate => gate.value)).toEqual([0, 1]))
    for (let index = 0; index < 6; index++) {
      fixture.gates[index]!.release()
      if (index < 4)
        await vi.waitFor(() => expect(fixture.gates).toHaveLength(index + 3))
    }
    await task
    expect(fixture.gates.map(gate => gate.value)).toEqual([0, 1, 2, 3, 4, 5])
    expect(fixture.maximumActive()).toBe(2)
  })

  it('cancels active calls and never starts queued calls when the queue overflows', async () => {
    const fixture = await createFixture('read_only', { maxPendingToolCalls: 2, maxQueuedToolCalls: 1 })
    fixture.apply(true)
    await fixture.turn({ name: 'codemode', arguments: { code: 'await Promise.all([0, 1, 2, 3].map(value => tools.lexora_gate({ value })));' } })
    expect(fixture.lastResult()).toContain('Too many queued tool calls')
    expect(fixture.lastResult()).toContain('Inspect any completed actions')
    expect(fixture.gates.map(gate => gate.value)).toEqual([0, 1])
    expect(fixture.gates.every(gate => gate.signal.aborted)).toBe(true)
  })

  it('completes nested write and edit, retaining their side effects after a later script error', async () => {
    const fixture = await createFixture('workspace_write')
    fixture.apply(true)
    await fixture.turn({ name: 'codemode', arguments: { code: 'await tools.write({ path: "allowed.txt", content: "completed write" }); await tools.edit({ path: "allowed.txt", oldText: "completed write", newText: "completed edit" }); throw new Error("later step failed");' } })
    expect(await readFile(join(fixture.cwd, 'allowed.txt'), 'utf8')).toBe('completed edit')
    expect(fixture.lastResult()).toContain('later step failed')
    expect(fixture.lastResult()).toContain('do not replay the entire script')
    expect(fixture.session.messages.filter(message => message.role === 'toolResult').at(-1)).toMatchObject({ nestedCalls: { complete: true, calls: [{ name: 'write', status: 'ok' }, { name: 'edit', status: 'ok' }] } })
  })

  it('waits for nested tool cleanup before releasing a failed script turn', async () => {
    const fixture = await createFixture()
    fixture.apply(true)
    let settled = false
    const task = fixture.turn({ name: 'codemode', arguments: { code: 'await Promise.all([tools.lexora_wait({}), tools.lexora_gate({ value: 0 }).then(() => { throw new Error("stop-script"); })]);' } }).then(() => {
      settled = true
    })
    const signal = await fixture.waiting.promise
    try {
      await vi.waitFor(() => expect(fixture.gates).toHaveLength(1))
      fixture.gates[0]!.release()
      await vi.waitFor(() => expect(signal.aborted).toBe(true))
      expect(settled).toBe(false)
      expect(fixture.session.isStreaming).toBe(true)
    }
    finally {
      fixture.cleanup.resolve()
      await task
    }
    expect(fixture.lastResult()).toContain('stop-script')
    expect(fixture.controller.signal.aborted).toBe(false)
    expect(fixture.session.isStreaming).toBe(false)
    await fixture.turn()
    expect(fixture.session.messages.at(-1)).toMatchObject({ content: [{ type: 'text', text: 'Done' }] })
  })

  it('preserves global admission across three sessions and frees it after cancellation', async () => {
    const [first, second, third] = await Promise.all(Array.from({ length: 3 }, () => createFixture('read_only', { computeTimeoutMs: 200 })))
    for (const fixture of [first, second, third])
      fixture.apply(true)
    const code = 'text(await tools.lexora_gate({ value: 1 }));'
    const firstTurn = first.turn({ name: 'codemode', arguments: { code } })
    const secondTurn = second.turn({ name: 'codemode', arguments: { code } })
    try {
      await vi.waitFor(() => expect(first.gates.length + second.gates.length).toBe(2))
      await new Promise(resolve => setTimeout(resolve, 300))
      await third.turn({ name: 'codemode', arguments: { code } })
      expect(third.lastResult()).toContain('worker limit reached')
      expect(third.gates).toHaveLength(0)

      await first.reusable.abort()
      await firstTurn
      expect(first.gates[0]!.signal.aborted).toBe(true)
      const replacement = third.turn({ name: 'codemode', arguments: { code } })
      await vi.waitFor(() => expect(third.gates).toHaveLength(1))
      third.gates[0]!.release()
      await replacement
      expect(third.lastResult()).toContain('Script completed')
      second.gates[0]!.release()
      await secondTurn
      expect(second.lastResult()).toContain('Script completed')
    }
    finally {
      await Promise.all([first.reusable.abort(), second.reusable.abort(), third.reusable.abort()])
      await Promise.allSettled([firstTurn, secondTurn])
    }
  })

  it('aborts active nested calls without admitting queued or later calls', async () => {
    const fixture = await createFixture('read_only', { maxPendingToolCalls: 2, maxQueuedToolCalls: 4 })
    fixture.apply(true)
    const task = fixture.turn({ name: 'codemode', arguments: { code: 'await Promise.all([0, 1, 2, 3, 4, 5].map(value => tools.lexora_gate({ value }))); await tools.lexora_gate({ value: 6 });' } })
    try {
      await vi.waitFor(() => expect(fixture.gates).toHaveLength(2))
      await fixture.reusable.abort()
      await task
      expect(fixture.gates.map(gate => gate.value)).toEqual([0, 1])
      expect(fixture.gates.every(gate => gate.signal.aborted)).toBe(true)
      expect(fixture.lastResult()).not.toContain('Script completed')
      const cancelled = fixture.session.messages.filter(message => message.role === 'toolResult').at(-1)
      expect(cancelled).toMatchObject({ isError: true })
      await fixture.turn({ name: 'codemode', arguments: { code: 'text("new turn");' } })
      expect(fixture.lastResult()).toContain('new turn')
    }
    finally {
      await fixture.reusable.abort()
      await task
    }
  })

  it('bounds uncooperative cleanup, rejects false success and quarantines the original session', async () => {
    const fixture = await createFixture('read_only', { cleanupTimeoutMs: 50 })
    fixture.apply(true)
    const task = fixture.turn({ name: 'codemode', arguments: { code: 'tools.lexora_wait({}); return "not finished";' } })
    const rejected = expect(task).rejects.toBeInstanceOf(CodemodeCleanupIncompleteError)
    const signal = await fixture.waiting.promise
    try {
      await rejected
      expect(signal.aborted).toBe(true)
      expect(fixture.lastResult()).toContain('Script failed')
      expect(fixture.lastResult()).toContain('Cleanup is incomplete')
      expect(fixture.lastResult()).not.toContain('Script completed')
      expect(fixture.session.messages.filter(message => message.role === 'toolResult').at(-1)).toMatchObject({
        isError: true,
        details: { cleanup: { toolCalls: 'pending', worker: 'exited' }, calls: [expect.objectContaining({ status: 'cancelled' })] },
      })
      expect(() => fixture.disposeCodemode()).toThrow(CodemodeCleanupIncompleteError)
      const requests = fixture.requests.length
      await expect(fixture.turn()).rejects.toBeInstanceOf(CodemodeCleanupIncompleteError)
      expect(fixture.requests).toHaveLength(requests)
      fixture.cleanup.resolve()
      await fixture.cleanupPending()
      expect(() => fixture.disposeCodemode()).not.toThrow()
      await expect(fixture.turn()).rejects.toBeInstanceOf(CodemodeCleanupIncompleteError)
      expect(fixture.requests).toHaveLength(requests)
    }
    finally {
      fixture.cleanup.resolve()
      await fixture.cleanupPending()
    }
  })

  it('settles cancellation even when a nested tool ignores abort and does not launch its continuation', async () => {
    const fixture = await createFixture('read_only', { cleanupTimeoutMs: 50 })
    fixture.apply(true)
    const task = fixture.turn({ name: 'codemode', arguments: { code: 'await tools.lexora_wait({}); await tools.lexora_gate({ value: 9 });' } })
    const rejected = expect(task).rejects.toBeInstanceOf(CodemodeCleanupIncompleteError)
    const signal = await fixture.waiting.promise
    try {
      fixture.controller.abort()
      await fixture.reusable.abort()
      await rejected
      expect(signal.aborted).toBe(true)
      expect(fixture.session.isStreaming).toBe(false)
      expect(fixture.gates).toHaveLength(0)
      expect(fixture.session.messages.filter(message => message.role === 'toolResult').at(-1)).toMatchObject({
        isError: true,
        nestedCalls: { complete: false, calls: [expect.objectContaining({ status: 'unfinished' })] },
      })
      const result = fixture.lastResult()
      fixture.cleanup.resolve()
      await fixture.cleanupPending()
      expect(fixture.gates).toHaveLength(0)
      expect(fixture.lastResult()).toBe(result)
    }
    finally {
      fixture.cleanup.resolve()
      await fixture.cleanupPending()
    }
  })

  it('keeps concurrent incomplete cleanups degraded until every nested execution settles', async () => {
    const fixture = await createFixture('read_only', { cleanupTimeoutMs: 50 })
    fixture.apply(true)
    const task = fixture.turn(Array.from({ length: 2 }, () => ({ name: 'codemode', arguments: { code: 'await tools.lexora_wait({});' } })))
    const rejected = expect(task).rejects.toBeInstanceOf(CodemodeCleanupIncompleteError)
    try {
      await vi.waitFor(() => expect(fixture.waits).toHaveLength(2))
      await fixture.reusable.abort()
      await rejected
      expect(fixture.cleanupPromises).toHaveLength(2)
      expect(fixture.waits.every(wait => wait.signal.aborted)).toBe(true)
      expect(() => fixture.disposeCodemode()).toThrow(CodemodeCleanupIncompleteError)

      fixture.waits[0]!.release()
      await Promise.race(fixture.cleanupPromises)
      expect(() => fixture.disposeCodemode()).toThrow(CodemodeCleanupIncompleteError)
      await expect(fixture.turn()).rejects.toBeInstanceOf(CodemodeCleanupIncompleteError)

      fixture.waits[1]!.release()
      await fixture.cleanupPending()
      expect(() => fixture.disposeCodemode()).not.toThrow()
      await expect(fixture.turn()).rejects.toBeInstanceOf(CodemodeCleanupIncompleteError)
    }
    finally {
      fixture.cleanup.resolve()
      await fixture.reusable.abort()
      await fixture.cleanupPending()
      await rejected
    }
  })

  it('retains worker admission until real exit, not stop acknowledgement', async () => {
    const [first, second, third] = await Promise.all(Array.from({ length: 3 }, () => createFixture('read_only', { cleanupTimeoutMs: 50 })))
    for (const fixture of [first, second, third])
      fixture.apply(true)
    const originalTerminate = Worker.prototype.terminate
    const exits: (() => Promise<number>)[] = []
    const termination = vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
      const stopped = Promise.withResolvers<number>()
      exits.push(async () => {
        const code = await originalTerminate.call(this)
        stopped.resolve(code)
        return code
      })
      return stopped.promise
    })
    try {
      for (const fixture of [first, second]) {
        await expect(fixture.turn({ name: 'codemode', arguments: { code: 'return "response is not exit";' } })).rejects.toBeInstanceOf(CodemodeCleanupIncompleteError)
        expect(fixture.lastResult()).toContain('Script failed')
        expect(fixture.session.messages.filter(message => message.role === 'toolResult').at(-1)).toMatchObject({
          details: { cleanup: { toolCalls: 'completed', worker: 'pending' } },
        })
      }
      await third.turn({ name: 'codemode', arguments: { code: 'text("must not be admitted");' } })
      expect(third.lastResult()).toContain('worker limit reached')
      expect(third.lastResult()).not.toContain('must not be admitted')
    }
    finally {
      termination.mockRestore()
      await Promise.all(exits.map(exit => exit()))
      await Promise.all([first.cleanupPending(), second.cleanupPending()])
    }
    await third.turn({ name: 'codemode', arguments: { code: 'text("capacity released");' } })
    expect(third.lastResult()).toContain('Script completed')
    expect(third.lastResult()).toContain('capacity released')
  })

  it('cancels a nested approval on script timeout while keeping the run authorization lifetime', async () => {
    const fixture = await createFixture('workspace_write')
    const pending = Promise.withResolvers<Parameters<BuddySessionExtensionServices['approvalService']['request']>[0]>()
    fixture.approvals.request = async (input) => {
      pending.resolve(input)
      await new Promise<void>((resolve) => {
        if (input.signal.aborted)
          resolve()
        else
          input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      throw new ApprovalCancelledError()
    }
    fixture.apply(true)
    const task = fixture.turn({ name: 'codemode', arguments: { code: `// @options: {"timeout_ms": 1000}\nawait tools.write({ path: ${JSON.stringify(join(fixture.root, 'outside.txt'))}, content: "blocked" });` } })
    const approval = await pending.promise
    await task
    expect(fixture.lastResult()).toContain('timed out')
    expect(approval.signal.aborted).toBe(true)
    expect(approval.runSignal?.aborted).toBe(false)
    fixture.controller.abort()
    expect(approval.runSignal?.aborted).toBe(true)
    expect(fixture.authorized.map(call => call.toolName)).toEqual(['codemode'])
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'tool_execution_end', toolName: 'write', parentToolCallId: 'call-1', isError: true }))
  })
})

async function createFixture(executionProfile: BuddyExecutionProfile = 'read_only', runtimeOptions?: NonNullable<Parameters<typeof createCodemodeExtension>[0]>['runtime']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-codemode-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  await writeFile(join(cwd, 'allowed.txt'), 'allowed content')
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
  const model = runtime.getModels().find(model => model.provider === 'anthropic')!
  await runtime.setRuntimeApiKey(model.provider, 'offline-fixture')
  let nextCall: FixtureCall | FixtureCall[] | undefined
  let first = false
  let run = 0
  const requests: { prompt: string, names: string[], toolTokens: number }[] = []
  vi.spyOn(runtime, 'streamSimple').mockImplementation((target, context) => {
    requests.push({ prompt: getCurrentSystemPrompt(context.messages), names: getCurrentTools(context.messages).map(tool => tool.name), toolTokens: createEstimatedContextUsage(context).toolTokens })
    const call = first ? nextCall : undefined
    first = false
    return response(target, call, run)
  })
  const waiting = Promise.withResolvers<AbortSignal>()
  const cleanup = Promise.withResolvers<void>()
  const waits: { signal: AbortSignal, release: () => void }[] = []
  const gates: { value: number, signal: AbortSignal, release: () => void }[] = []
  let active = 0
  let maximumActive = 0
  const engine = new NativeFileEngine(join(root, 'file-operations'))
  await engine.ready()
  const fileResources = new FileResourceCoordinator(engine)
  const mutations = new MutationCoordinator({ resources: fileResources })
  cleanups.push(async () => {
    await mutations.dispose()
    await engine.dispose()
  })
  const services: BuddySessionExtensionServices = {
    delegation: { pending: () => [], execute: async () => ({ status: 'working', updates: [] }), assertShellExecutionAllowed: () => {} },
    approvalService: { request: async () => ({ approvalId: 'denied-1', decision: 'denied' }) },
    attachmentService: {} as BuddySessionExtensionServices['attachmentService'],
    fileResources,
    mutations,
    changeCaptureService: {
      beginInvocation: async input => ({ invocationId: input.invocationId, runId: input.runId }),
      finishInvocation: async () => ({ complete: true }),
      markPartial: async () => {},
    },
    createCapabilities: async () => [{
      classify: event => ['lexora_wait', 'lexora_gate'].includes(event.toolName) ? { access: 'read', paths: [] } : null,
      disclosure: [{ source: { kind: 'builtin', id: 'wait', title: 'Wait' }, exposure: 'direct', keywords: '', tools: [{ name: 'lexora_wait' }, { name: 'lexora_gate' }] }],
      extension: {
        name: 'lexora-wait-fixture',
        factory(pi) {
          pi.registerTool({
            name: 'lexora_gate',
            label: 'Gate',
            description: 'Controlled parallel operation',
            parameters: Type.Object({ value: Type.Number() }),
            executionMode: 'parallel',
            async execute(_id, { value }, signal) {
              const gate = Promise.withResolvers<void>()
              gates.push({ value, signal: signal!, release: () => gate.resolve() })
              active++
              maximumActive = Math.max(maximumActive, active)
              const abort = () => gate.resolve()
              if (signal?.aborted)
                abort()
              else
                signal?.addEventListener('abort', abort, { once: true })
              try {
                await gate.promise
                return { content: [{ type: 'text', text: String(value) }], details: {} }
              }
              finally {
                signal?.removeEventListener('abort', abort)
                active--
              }
            },
          })
          pi.registerTool({
            name: 'lexora_wait',
            label: 'Wait',
            description: 'Wait until cancelled',
            parameters: Type.Object({}),
            async execute(_id, _arguments, signal) {
              const settled = Promise.withResolvers<void>()
              waits.push({ signal: signal!, release: () => settled.resolve() })
              waiting.resolve(signal!)
              await new Promise<void>((resolve) => {
                if (signal?.aborted)
                  resolve()
                else
                  signal?.addEventListener('abort', () => resolve(), { once: true })
              })
              await Promise.race([cleanup.promise, settled.promise])
              return { content: [{ type: 'text', text: 'Cancelled' }], details: {} }
            },
          })
        },
      },
    }],
    directoryGrants: {} as BuddySessionExtensionServices['directoryGrants'],
  }
  const extensions = await createBuddySessionExtensions({
    canonicalRoot: cwd,
    conversationId: 'codemode-conversation',
    approvalPolicy: 'policy',
    executionProfile,
    grants: [{ canonicalRoot: cwd, root: cwd, grantId: 'workspace-1', kind: 'workspace' }],
    services,
    sessionMode: 'interactive',
    signal: new AbortController().signal,
    spaceId: null,
  })
  cleanups.push(() => extensions.dispose())
  const cleanupPromises: Promise<void>[] = []
  const runtimeCapability = runtimeOptions && createCodemodeCapability(() => true, {
    ...runtimeOptions,
    onCleanupIncomplete(pending) {
      cleanupPromises.push(pending)
      runtimeOptions.onCleanupIncomplete?.(pending)
    },
  })
  const options: Parameters<typeof createIsolatedBuddySession>[0] = {
    agentDir: join(root, 'agent'),
    canonicalRoot: cwd,
    cwd,
    conversationsDirectory: join(root, 'conversations'),
    conversationId: 'codemode-conversation',
    branchId: 'codemode-branch',
    approvalPolicy: 'policy',
    executionProfile,
    model,
    modelRuntime: runtime,
    thinkingLevel: 'off',
    resources: { skillReadRoots: [], skillReferences: [], approvedSkills: [], context: { agentsFiles: [], diagnostics: [] }, directoryContext: '', revision: 'empty' },
    inProcessExtensions: extensions.inProcessExtensions.map(extension => runtimeCapability && extension.name === CODEMODE_EXTENSION
      ? { ...extension, factory: runtimeCapability.extension.factory }
      : extension),
  }
  const created = await createIsolatedBuddySession(options)
  cleanups.push(() => created.shutdown('quit'))
  cleanups.push(async () => {
    cleanup.resolve()
    await Promise.all(cleanupPromises)
    await runtimeCapability?.dispose?.()
  })
  const { session } = created
  session.settingsManager.setCompactionEnabled(false)
  const events: AgentSessionEvent[] = []
  session.subscribe(event => events.push(event))
  const reusable = createReusableBuddySession({
    session,
    shutdown: created.shutdown,
    assertModelAccess: async () => model,
    runContext: extensions.runContext,
    inputReferences: extensions.inputReferences,
    materializeInput: async input => input.prompt,
    setCodemodeEnabled: extensions.setCodemodeEnabled,
    assertCodemodeReady: runtimeCapability?.assertReady ?? extensions.assertCodemodeReady,
  })
  const controller = new AbortController()
  const authorized: AuthorizedToolExecution[] = []
  const denied: DeniedToolExecution[] = []
  return {
    root,
    cwd,
    session,
    reusable,
    requests,
    preview: () => createIsolatedBuddyContextSnapshot(options),
    events,
    waiting,
    cleanup,
    waits,
    cleanupPromises,
    cleanupPending: () => Promise.all(cleanupPromises),
    disposeCodemode: () => runtimeCapability?.dispose?.(),
    approvals: services.approvalService,
    gates,
    maximumActive: () => maximumActive,
    controller,
    authorized,
    denied,
    apply: (codemode: boolean) => reusable.applyPreferences({ ...DEFAULT_RUNTIME_PREFERENCES, codemode }),
    lastResult: () => session.messages.filter(message => message.role === 'toolResult').at(-1)?.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '',
    async turn(call?: typeof nextCall) {
      nextCall = call
      first = true
      const release = await reusable.activateTurn({
        generation: 0,
        runId: `run-${++run}`,
        provider: model.provider,
        model: model.id,
        contextWindow: null,
        maxTokens: null,
        signal: controller.signal,
        flushProjectedEvents: async () => {},
        onToolExecutionAuthorized: async (call) => { authorized.push(call) },
        onToolExecutionDenied: async (call) => { denied.push(call) },
      })
      try {
        await reusable.prompt('Run the requested operation')
      }
      finally {
        release()
      }
    },
  }
}

function response(model: Model<Api>, call: FixtureCall | FixtureCall[] | undefined, run: number) {
  const calls: ToolCall[] = call
    ? Array.isArray(call)
      ? call.map((item, index) => ({ type: 'toolCall', id: `call-${run}-${index}`, ...item }))
      : [{ type: 'toolCall', id: `call-${run}`, ...call }]
    : []
  const message: AssistantMessage = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    role: 'assistant',
    timestamp: Date.now(),
    content: call ? calls : [{ type: 'text', text: 'Done' }],
    stopReason: call ? 'toolUse' : 'stop',
    usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message }))
  return stream
}
