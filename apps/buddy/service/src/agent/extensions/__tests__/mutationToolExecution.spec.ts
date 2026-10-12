import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { BuddyExtensionRunContext } from '../BuddyExtensionRunContext'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { afterEach, describe, expect, it } from 'vitest'
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

  it.each(['write', 'edit', 'mcp__fixture__write', 'mutate'])('persists the recovery lifetime of %s before its side effects', async (toolName) => {
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
        lifetime: toolName === 'write' || toolName === 'edit' ? 'runtime' : 'external',
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

async function setup() {
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
  function actor(runId: string, mutate: (path: string, content: string) => Promise<void>, toolName = 'mutate') {
    const cwd = join(root, runId)
    const run: BuddyExtensionRunContext = { runId, signal: new AbortController().signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {} }
    const executionPermissions = new ToolExecutionPermissions()
    cleanups.push(() => executionPermissions.dispose())
    const authorization = new ToolAuthorizationService({ approvalService: { request: async () => {
      throw new Error('UNEXPECTED_APPROVAL')
    } }, approvalAvailable: false, approvalPolicy: 'policy', executionProfile: 'workspace_write', cwd, owner: { kind: 'conversation', id: 'conversation' }, getGrants: () => grants, executionPermissions })
    const classify = (input: { path: string }) => ({ access: 'write' as const, paths: [{ path: input.path, mode: 'existing' as const }] })
    const tool = defineTool({ name: toolName, label: 'Mutate', description: 'Write controlled files', executionMode: 'parallel', parameters: Type.Object({ path: Type.String(), content: Type.String() }), async execute(_id, input) {
      await mutate(input.path, input.content)
      return { content: [{ type: 'text', text: 'updated' }], details: {} }
    } })
    const wrapped = createMutationToolWrapper({ conversationId: 'conversation', cwd, authorization, changes, mutations, getRunContext: () => run, getGrants: () => grants, getWorkspaceGrants: () => grants, classify: async event => classify(event.input as { path: string }), workspaceMutationTools: [] })(tool)
    return {
      authorization,
      authorize: (input: { path: string, content: string }) => authorization.authorize({ input, toolCallId: 'same-provider-id', toolName: tool.name }, run, classify(input)),
      execute: (input: { path: string, content: string }) => wrapped.execute('same-provider-id', input, run.signal, undefined, {} as Parameters<ToolDefinition['execute']>[4]),
    }
  }
  return { root, path, changes, repository, mutationRepository, mutations, actor }
}
