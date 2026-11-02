import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { BuddyExecutionProfile } from '../../../../../shared/permissions/executionProfile'
import type { ToolExecutionPhaseChange } from '../../../../../shared/runs/toolExecutionPhase'
import type { BuddyToolClassification } from '../../../approvals/toolClassification'
import type { BuddyExtensionRunContext } from '../BuddyExtensionRunContext'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { afterEach, describe, expect, it } from 'vitest'
import { runSupervisedShellProcess } from '../../../../../platform/process/supervisedShellProcess'
import { createCapturedFileWriter } from '../../../changes/CapturedFileWriter'
import { ChangeCaptureService } from '../../../changes/ChangeCaptureService'
import { createChangeSetRepository } from '../../../changes/changeSetRepository'
import { MutationCoordinator } from '../../../changes/MutationCoordinator'
import { createMutationRepository } from '../../../changes/mutationRepository'
import { ToolAuthorizationService } from '../../../permissions/ToolAuthorizationService'
import { ToolExecutionPermissions } from '../../../permissions/ToolExecutionPermissions'
import { BuddyDataPaths } from '../../../storage/BuddyDataPaths'
import { createConversationRepository } from '../../../storage/conversationRepository'
import { openBuddyDatabase } from '../../../storage/database'
import { createRunRepository } from '../../../storage/runRepository'
import { createMutationToolWrapper } from '../changeCaptureExtension'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('authorized mutation execution', () => {
  it('cancels a concurrent full-access shell without any late writes', async () => {
    const fixture = await setup()
    const active = await fixture.mutations.acquire({ runId: 'run-1', invocationId: 'held', lifetime: 'external', claims: [{ kind: 'tree', canonicalPath: fixture.root }], signal: new AbortController().signal })
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const actor = fixture.actor('run-2', async (path, content, signal) => {
      entered.resolve()
      await delay(10_000, undefined, { signal })
      await writeFile(path, content)
    }, 'lexora_shell', { profile: 'full_access', signal: controller.signal })
    const operation = actor.execute({ path: fixture.path, content: 'LATE_WRITE', timeout: 10 })
    const rejected = expect(operation).rejects.toThrow(/abort|SHELL_RESOURCE_TIMEOUT/i)
    try {
      await entered.promise
      expect(fixture.mutations.getRunState('run-2')).toMatchObject({ active: 1, pending: 0 })
      expect(actor.phases.some(event => event.phase === 'resource')).toBe(false)
      controller.abort()
      await rejected
      expect(actor.phases.at(-1)).toMatchObject({ phase: 'finished', outcome: 'cancelled' })
    }
    finally { active.release() }
    expect(await readFile(fixture.path, 'utf8')).toBe('A')
    expect(fixture.mutations.getRunState('run-2')).toEqual({ pending: 0, active: 0, hazards: [] })
    expect(fixture.repository.listCaptures('run-2')).toEqual([])
  })

  it('preserves a tool failure when cancellation arrives during capture cleanup', async () => {
    const controller = new AbortController()
    const fixture = await setup({ beforeFinish: () => controller.abort() })
    const actor = fixture.actor('run-1', async () => {
      throw new Error('WRITE_FAILED')
    }, 'write', { signal: controller.signal })
    await expect(actor.execute({ path: fixture.path, content: '' })).rejects.toThrow('WRITE_FAILED')
    expect(actor.phases.at(-1)).toMatchObject({ phase: 'finished', outcome: 'failed' })
    expect(await readFile(fixture.path, 'utf8')).toBe('A')
    expect(fixture.mutations.getRunState('run-1')).toEqual({ pending: 0, active: 0, hazards: [] })
  })

  it('passes the remaining command budget to the backend after asynchronous preparation', async () => {
    const fixture = await setup()
    let remaining = 0
    const actor = fixture.actor('run-2', async (path, content, _signal, timeout) => {
      remaining = timeout!
      await writeFile(path, content)
    }, 'lexora_shell', { profile: 'full_access', validateBeforeExecution: async () => {
      await delay(180)
      return null
    } })
    const operation = actor.execute({ path: fixture.path, content: 'WITHIN_BUDGET', timeout: 5 })
    await operation
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThan(4.85)
    expect(await readFile(fixture.path, 'utf8')).toBe('WITHIN_BUDGET')
    expect(fixture.mutations.getRunState('run-2')).toEqual({ pending: 0, active: 0, hazards: [] })
  })

  it('preserves tool effects and process settlement when capture fails', async () => {
    const fixture = await setup({ afterCapture: () => {
      throw new Error('CAPTURE_STORAGE_FAILED')
    } })
    const writer = fixture.actor('run-1', (path, content) => writeFile(path, content), 'write')
    await writer.execute({ path: fixture.path, content: 'SAVED' })
    await fixture.changes.finalizeRun('run-1')
    expect(await readFile(fixture.path, 'utf8')).toBe('SAVED')
    expect((await fixture.changes.getForRuns(['run-1'])).coverage).toBe('partial')
    expect(fixture.mutationRepository.listUnreleased()).toEqual([])
    expect(fixture.mutations.getHazards()).toEqual([])
  })

  it('admits a shell with trusted read-only classification alongside a writer while keeping process ownership', async () => {
    const fixture = await setup()
    const active = await fixture.mutations.acquire({ runId: 'run-1', invocationId: 'writer', lifetime: 'runtime', claims: [{ kind: 'tree', canonicalPath: fixture.root }], signal: new AbortController().signal })
    try {
      const reader = fixture.actor('run-2', async () => {
        expect(fixture.mutations.getRunState('run-1').active).toBe(1)
        expect(fixture.mutationRepository.listUnreleased()).toMatchObject([{ claims: expect.any(Array) }, { claims: [] }])
        expect(await readFile(fixture.path, 'utf8')).toBe('A')
      }, 'bash', { readOnly: true })
      await reader.execute({ path: fixture.path, content: '' })
      expect(fixture.repository.listCaptures('run-2')).toEqual([])
      expect((await fixture.changes.getForRuns(['run-2'])).coverage).toBe('complete')
      expect(fixture.mutations.getRunState('run-2')).toEqual({ pending: 0, active: 0, hazards: [] })
    }
    finally { active.release() }
  })

  it('splits exact changes at an untracked writer even when the file content returns to the same value', async () => {
    const fixture = await setup()
    const writer = fixture.actor('run-1', (path, content) => writeFile(path, content), 'write')
    await writer.execute({ path: fixture.path, content: 'B' })
    const shell = fixture.actor('run-1', async (path) => {
      await writeFile(path, 'UNTRACKED')
      await writeFile(path, 'B')
    }, 'bash')
    await shell.execute({ path: fixture.path, content: '' })
    await writer.execute({ path: fixture.path, content: 'C' })
    const result = await fixture.changes.getForRuns(['run-1'])
    expect(result.files.map(file => [file.beforeText, file.afterText])).toEqual([['A', 'B'], ['B', 'C']])
    expect(result).toMatchObject({ coverage: 'partial', coverageReasons: ['untracked'] })
  })

  it.each(['bash', 'mcp__fixture__write'])('lets a long %s overlap exact writes without claiming exclusive attribution', async (toolName) => {
    const fixture = await setup()
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const background = fixture.actor('run-2', async () => {
      entered.resolve()
      await released.promise
    }, toolName)
    const running = background.execute({ path: fixture.path, content: '' })
    const writer = fixture.actor('run-1', (path, content) => writeFile(path, content), 'write')
    try {
      await entered.promise
      await writer.execute({ path: fixture.path, content: 'B' })
      expect(fixture.mutations.getRunState('run-2')).toMatchObject({ active: 1, pending: 0 })
      expect(writer.phases.some(event => event.waitingFor)).toBe(false)
      expect(await fixture.changes.getForRuns(['run-1'])).toMatchObject({ coverage: 'partial', coverageReasons: ['untracked'] })
      expect(fixture.repository.listCaptures('run-1')[0]?.invocation?.status).toBe('partial')
    }
    finally {
      released.resolve()
      await running
    }
    await writer.execute({ path: fixture.path, content: 'C' })
    const captures = fixture.repository.listCaptures('run-1')
    expect(captures.map(capture => capture.invocation?.status)).toEqual(['partial', 'completed'])
    expect(new Set(captures.map(capture => capture.invocation?.segmentId)).size).toBe(2)
    expect((await fixture.changes.getForRuns(['run-1'])).files.map(file => [file.beforeText, file.afterText])).toEqual([['A', 'B'], ['B', 'C']])
  })

  it('allows an external invocation to call a nested file writer without a host-lock deadlock', async () => {
    const fixture = await setup()
    const writer = fixture.actor('run-1', (path, content) => writeFile(path, content), 'write')
    const external = fixture.actor('run-2', async () => {
      await writer.execute({ path: fixture.path, content: 'NESTED' })
    }, 'mcp__fixture__write')
    await external.execute({ path: fixture.path, content: '' })
    expect(await readFile(fixture.path, 'utf8')).toBe('NESTED')
    expect(fixture.mutationRepository.listUnreleased()).toEqual([])
    expect(await fixture.changes.getForRuns(['run-1', 'run-2'])).toMatchObject({ coverage: 'partial', coverageReasons: ['untracked'] })
  })

  it('acquires image output locks only at publication and captures writes completed before an error', async () => {
    const fixture = await setup()
    const actor = fixture.actor('run-1', async () => {}, 'lexora_image_generate')
    const input = { path: fixture.path, content: '' }
    await actor.authorize(input)
    const write = actor.createWriter(input)
    const other = fixture.actor('run-2', (path, content) => writeFile(path, content), 'write')
    await other.execute({ path: fixture.path, content: 'B' })
    expect(fixture.mutations.getRunState('run-1').active).toBe(0)
    const second = join(fixture.root, 'second.png')
    await expect(write([fixture.path, second], async () => {
      await writeFile(fixture.path, 'C')
      throw new Error('SECOND_IMAGE_FAILED')
    })).rejects.toThrow('SECOND_IMAGE_FAILED')
    const result = await fixture.changes.getForRuns(['run-1'])
    expect(result.files.map(file => [file.beforeText, file.afterText])).toEqual([['B', 'C']])
    expect(fixture.mutationRepository.listUnreleased()).toEqual([])
  })

  it('rejects image publication after its original authorization is revoked', async () => {
    const fixture = await setup()
    const actor = fixture.actor('run-1', async () => {}, 'lexora_image_generate')
    const input = { path: fixture.path, content: '' }
    await actor.authorize(input)
    const write = actor.createWriter(input)
    actor.authorization.updatePermissionSettings({ approvalPolicy: 'policy', executionProfile: 'read_only' })
    await expect(write([fixture.path], () => writeFile(fixture.path, 'MUST_NOT_WRITE'))).rejects.toThrow('TOOL_AUTHORIZATION_UNAVAILABLE')
    expect(await readFile(fixture.path, 'utf8')).toBe('A')
    expect(fixture.mutationRepository.listUnreleased()).toEqual([])
  })

  it('does not start a cancelled waiter when the active lease becomes unknown', async () => {
    const fixture = await setup()
    const controller = new AbortController()
    const active = await fixture.mutations.acquire({ runId: 'run-1', invocationId: 'active', lifetime: 'runtime', claims: [{ kind: 'file', canonicalPath: fixture.path }], signal: controller.signal })
    const writer = fixture.actor('run-2', (path, content) => writeFile(path, content), 'write', { signal: controller.signal })
    const waiting = writer.execute({ path: fixture.path, content: 'MUST_NOT_WRITE' })
    const rejected = expect(waiting).rejects.toThrow()
    try {
      await expect.poll(() => fixture.mutations.getRunState('run-2').pending).toBe(1)
      controller.abort()
    }
    finally { active.markHazard('FILE_RESOURCE_SETTLEMENT_FAILED') }
    await rejected
    expect(await readFile(fixture.path, 'utf8')).toBe('A')
    expect(fixture.repository.listCaptures('run-2')).toEqual([])
    expect(fixture.mutations.getRunState('run-2')).toEqual({ pending: 0, active: 0, hazards: [] })
    expect(fixture.mutations.getHazards()).toHaveLength(1)
  })

  it('admits a new MCP call while a prior external outcome remains unknown', async () => {
    const fixture = await setup()
    const old = await fixture.mutations.acquire({ runId: 'run-1', invocationId: 'old', lifetime: 'external', claims: [{ kind: 'host' }], signal: new AbortController().signal })
    fixture.mutations.recordOwnedProcessSettlement({ invocationId: 'old', processId: 'unverified-external', settlement: 'unknown' })
    old.markHazard('OWNED_PROCESS_CLEANUP_UNCONFIRMED')
    const writer = fixture.actor('run-2', (path, content) => writeFile(path, content), 'mcp__fixture__write')
    await writer.execute({ path: fixture.path, content: 'NEW' })
    expect(await readFile(fixture.path, 'utf8')).toBe('NEW')
    expect(await fixture.changes.getForRuns(['run-2'])).toMatchObject({ coverage: 'partial', coverageReasons: ['untracked'] })
    expect(fixture.mutations.getHazards()).toHaveLength(1)
    expect(fixture.mutations.getOwnedProcesses('old')).toEqual([{ processId: 'unverified-external', settlement: 'unknown' }])
    expect(fixture.mutationRepository.listUnreleased().map(item => item.invocationId)).toEqual(['old'])
  })

  it('revalidates tool availability after asynchronous change capture before executing', async () => {
    let available = true
    const fixture = await setup({ afterCapture: () => {
      available = false
    } })
    const writer = fixture.actor('run-1', (path, content) => writeFile(path, content), 'mutate', {
      validateBeforeExecution: async () => available ? null : { blocked: true, reason: 'TOOL_NO_LONGER_AVAILABLE' },
    })
    await expect(writer.execute({ path: fixture.path, content: 'MUST_NOT_WRITE' })).rejects.toThrow('TOOL_NO_LONGER_AVAILABLE')
    expect(await readFile(fixture.path, 'utf8')).toBe('A')
    expect(fixture.mutationRepository.listUnreleased()).toEqual([])
  })

  it('releases a supervised invocation rejected before process dispatch without poisoning later writes', async () => {
    const fixture = await setup()
    const shell = fixture.actor('run-1', async () => {
      await runSupervisedShellProcess({ shell: '/bin/bash', args: ['-c'], command: 'true', cwd: fixture.root, environment: {} }, {
        executable: '/not-launched',
        timeout: 0,
        onData() {},
        onSettlement: (settlement) => { fixture.mutations.recordOwnedProcessSettlement(settlement) },
      })
    }, 'bash')
    await expect(shell.execute({ path: fixture.path, content: 'unused' })).rejects.toThrow('Invalid shell timeout')
    expect(fixture.mutationRepository.listUnreleased()).toEqual([])
    const writer = fixture.actor('run-2', (path, content) => writeFile(path, content), 'write')
    await writer.execute({ path: fixture.path, content: 'after-validation-failure' })
    expect(await readFile(fixture.path, 'utf8')).toBe('after-validation-failure')
  })

  it('serializes overlapping grants across different working directories and preserves root, child and resumed root diffs', async () => {
    const fixture = await setup()
    await symlink(fixture.path, join(fixture.root, 'alias.txt'))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const root = fixture.actor('run-1', async (path, content) => {
      await writeFile(path, content)
      if (content === 'B') {
        entered.resolve()
        await release.promise
        throw new Error('TOOL_FAILED_AFTER_WRITE')
      }
    })
    const child = fixture.actor('run-2', (path, content) => writeFile(path, content))
    const a = { path: fixture.path, content: 'B' }
    const b = { path: join(fixture.root, 'alias.txt'), content: 'C' }
    await Promise.all([root.authorize(a), child.authorize(b)])
    const first = root.execute(a)
    const failed = expect(first).rejects.toThrow('TOOL_FAILED_AFTER_WRITE')
    await entered.promise
    let settled = false
    const stable = fixture.mutations.waitForRun('run-1').then(() => {
      settled = true
    })
    const waiting = child.execute(b)
    await expect.poll(() => fixture.mutations.getRunState('run-2').pending).toBe(1)
    expect(await readFile(fixture.path, 'utf8')).toBe('B')
    expect(settled).toBe(false)
    release.resolve()
    await failed
    await stable
    await waiting
    await root.execute({ path: fixture.path, content: 'D' })
    await fixture.changes.finalizeRun('run-1')
    await fixture.changes.finalizeRun('run-2')
    const changes = await fixture.changes.getForRuns(['run-1', 'run-2'])
    expect(changes.files.map(file => [file.source?.runId, file.beforeText, file.afterText])).toEqual([
      ['run-1', 'A', 'B'],
      ['run-2', 'B', 'C'],
      ['run-1', 'C', 'D'],
    ])
    expect(changes.coverage).toBe('complete')
    expect(fixture.repository.listCaptures('run-1')[0]?.toolReportedError).toBe(true)
    expect(fixture.mutations.getRunState('run-1')).toEqual({ pending: 0, active: 0, hazards: [] })
  })

  it.each(['write', 'mcp__fixture__write'])('persists the recovery lifetime of %s before its side effects', async (toolName) => {
    const fixture = await setup()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const actor = fixture.actor('run-1', async (path, content) => {
      entered.resolve()
      await release.promise
      await writeFile(path, content)
    }, toolName)
    const operation = actor.execute({ path: fixture.path, content: 'B' })
    try {
      await entered.promise
      expect(fixture.mutationRepository.listUnreleased()).toMatchObject([{
        runId: 'run-1',
        lifetime: toolName === 'write' ? 'runtime' : 'external',
        processes: [],
      }])
      expect(await readFile(fixture.path, 'utf8')).toBe('A')
    }
    finally {
      release.resolve()
      await operation
    }
    expect(fixture.mutationRepository.listUnreleased()).toEqual([])
  })

  it('rechecks revoked permissions after waiting and never executes the previously authorized write', async () => {
    const fixture = await setup()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const root = fixture.actor('run-1', async (path, content) => {
      await writeFile(path, content)
      entered.resolve()
      await release.promise
    })
    const child = fixture.actor('run-2', (path, content) => writeFile(path, content))
    const first = root.execute({ path: fixture.path, content: 'B' })
    await entered.promise
    const waiting = child.execute({ path: fixture.path, content: 'UNAUTHORIZED' })
    const denied = expect(waiting).rejects.toThrow()
    await expect.poll(() => fixture.mutations.getRunState('run-2').pending).toBe(1)
    child.authorization.updatePermissionSettings({ approvalPolicy: 'policy', executionProfile: 'read_only' })
    release.resolve()
    await first
    await denied
    expect(await readFile(fixture.path, 'utf8')).toBe('B')
    expect(fixture.repository.listCaptures('run-2')).toEqual([])
    expect(fixture.mutations.getRunState('run-2')).toEqual({ pending: 0, active: 0, hazards: [] })
  })
})

async function setup(options: { afterCapture?: () => void, beforeFinish?: () => void } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-tool-mutations-')))
  cleanups.push(() => rm(root, { force: true, recursive: true }))
  const path = join(root, 'shared.txt')
  await writeFile(path, 'A')
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  cleanups.push(() => database.close())
  const now = '2026-10-12T00:00:00.000Z'
  const conversations = createConversationRepository(database)
  const runs = createRunRepository(database)
  conversations.create({ id: 'conversation', branchId: 'branch', createdAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write', spaceId: null, title: 'Changes' })
  for (const id of ['run-1', 'run-2']) {
    await mkdir(join(root, id))
    conversations.createMessage({ id: `message-${id}`, conversationId: 'conversation', branchId: 'branch', role: 'user', runId: null, createdAt: now, content: { text: 'Change the file' } })
    runs.create({ id, conversationId: 'conversation', branchId: 'branch', triggeringMessageId: `message-${id}`, provider: 'fixture', model: 'fixture', purpose: 'chat', status: 'completed', startedAt: now, completedAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write', piSessionFile: null })
  }
  const repository = createChangeSetRepository(database)
  const changes = new ChangeCaptureService({ paths: new BuddyDataPaths(join(root, 'data')), repository })
  cleanups.push(() => changes.dispose())
  const mutationRepository = createMutationRepository(database)
  const mutations = new MutationCoordinator({ repository: mutationRepository })
  cleanups.push(() => mutations.dispose())
  const grants = [{ canonicalRoot: root, root, grantId: 'workspace', kind: 'workspace' as const }]
  function actor(runId: string, mutate: (path: string, content: string, signal?: AbortSignal, timeout?: number) => Promise<void>, toolName = 'mutate', toolOptions: { profile?: BuddyExecutionProfile, readOnly?: boolean, signal?: AbortSignal, validateBeforeExecution?: BuddyToolClassification['validateBeforeExecution'] } = {}) {
    const cwd = join(root, runId)
    const phases: ToolExecutionPhaseChange[] = []
    const run: BuddyExtensionRunContext = { runId, signal: toolOptions.signal ?? new AbortController().signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {}, onToolExecutionPhase: event => phases.push(event) }
    const executionPermissions = new ToolExecutionPermissions()
    cleanups.push(() => executionPermissions.dispose())
    const authorization = new ToolAuthorizationService({ approvalService: { request: async () => {
      throw new Error('UNEXPECTED_APPROVAL')
    } }, approvalAvailable: false, approvalPolicy: 'policy', executionProfile: toolOptions.profile ?? 'workspace_write', cwd, owner: { kind: 'conversation', id: 'conversation' }, getGrants: () => grants, executionPermissions })
    const classify = (input: { path: string }) => ({ shellReadOnly: toolOptions.readOnly, access: 'write' as const, paths: [{ path: input.path, mode: 'existing' as const }], validateBeforeExecution: toolOptions.validateBeforeExecution })
    const tool = defineTool({ name: toolName, label: 'Mutate', description: 'Write controlled files', executionMode: 'parallel', parameters: Type.Object({ path: Type.String(), content: Type.String(), timeout: Type.Optional(Type.Number()) }), async execute(_id, input, signal) {
      await mutate(input.path, input.content, signal, input.timeout)
      return { content: [{ type: 'text', text: 'updated' }], details: {} }
    } })
    const wrapped = createMutationToolWrapper({
      conversationId: 'conversation',
      cwd,
      authorization,
      mutations,
      getRunContext: () => run,
      getGrants: () => grants,
      getWorkspaceGrants: () => grants,
      classify: async event => classify(event.input as { path: string }),
      workspaceMutationTools: [],
      changes: {
        beginInvocation: async (input) => {
          const handle = await changes.beginInvocation(input)
          options.afterCapture?.()
          return handle
        },
        finishInvocation: (handle, input) => {
          options.beforeFinish?.()
          return changes.finishInvocation(handle, input)
        },
        markPartial: runId => changes.markPartial(runId),
      },
    })(tool)
    return {
      phases,
      authorization,
      createWriter: (input: { path: string, content: string }) => createCapturedFileWriter({ conversationId: 'conversation', cwd, run, event: { type: 'tool_call', toolCallId: 'same-provider-id', toolName, input }, authorization, mutations, changes, files: { withStagingDirectory: operation => operation(join(root, 'staging')), fileWriteClaims: async paths => paths.map(canonicalPath => ({ kind: 'file', canonicalPath })), writeFile: async () => { throw new Error('NATIVE_PUBLICATION_NOT_CONFIGURED') } }, getGrants: () => grants }),
      authorize: (input: { path: string, content: string }) => authorization.authorize({ input, toolCallId: 'same-provider-id', toolName: tool.name }, run, classify(input)),
      execute: (input: { path: string, content: string, timeout?: number }) => wrapped.execute('same-provider-id', input, run.signal, undefined, {} as Parameters<ToolDefinition['execute']>[4]),
    }
  }
  return { root, path, changes, repository, mutationRepository, mutations, actor }
}
