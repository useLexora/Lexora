import type { DatabaseSync } from 'node:sqlite'
import type { ChatCommandCommit } from '../ChatCommandService'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCommandRequestRepository } from '../../storage/commandRequestRepository'
import { createComposerDraftRepository } from '../../storage/composerDraftRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { ChatCommandService } from '../ChatCommandService'

const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))

describe('command acceptance facts', () => {
  it('publishes the complete transaction before launch and replays its receipt without another fact', async () => {
    const f = fixture()
    const commits: ChatCommandCommit[] = []
    f.service.onDidCommit((event) => {
      expect(f.commands.findByRequestId(event.requestId)?.runId).toBe(event.facts[1].runId)
      expect(f.drafts.findById('draft-1')?.revision).toBe(1)
      commits.push(event)
    })
    f.launch.mockRejectedValueOnce(new Error('Planner unavailable'))
    await expect(f.service.execute(f.input)).rejects.toThrow('Planner unavailable')
    expect(commits).toHaveLength(1)
    expect(commits[0]?.facts).toEqual([
      { kind: 'command.accepted', command: 'compact' },
      { kind: 'run.queued', runId: expect.any(String), purpose: 'conversation.compaction' },
      { kind: 'draft.consumed', draftId: 'draft-1', sourceRevision: 0, committedRevision: 1 },
    ])
    expect(Reflect.set(commits[0]!.facts[2], 'committedRevision', 20)).toBe(false)
    await expect(f.service.execute(f.input)).resolves.toMatchObject({ runId: commits[0]!.facts[1].runId, draftReceipt: { committedRevision: 1 } })
    expect(commits).toHaveLength(1)
    expect(f.launch).toHaveBeenCalledTimes(1)
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
    await f.service.dispose()
  })

  it('does not publish partial facts when consuming the draft rolls back the transaction', async () => {
    const f = fixture()
    const commits: ChatCommandCommit[] = []
    f.service.onDidCommit(event => commits.push(event))
    f.database.exec('CREATE TRIGGER reject_draft BEFORE UPDATE ON composer_drafts BEGIN SELECT RAISE(ABORT, \'draft unavailable\'); END')
    await expect(f.service.execute(f.input)).rejects.toThrow('draft unavailable')
    expect(commits).toEqual([])
    expect(f.commands.findByRequestId(f.input.requestId)).toBeNull()
    expect(f.drafts.findById('draft-1')?.revision).toBe(0)
    expect(f.runs.listRecent()).toHaveLength(1)
    await f.service.dispose()
  })

  it('drains an accepted operation when a commit observer requests shutdown', async () => {
    const f = fixture()
    const gate = Promise.withResolvers<void>()
    f.launch.mockImplementationOnce(async (runId, signal) => {
      expect(signal?.aborted).toBe(true)
      await gate.promise
      return { runId, completion: Promise.resolve(f.runs.findById(runId)!) }
    })
    let stopping: Promise<void> | undefined
    let stopped = false
    f.service.onDidCommit(() => {
      stopping = f.service.dispose().then(() => {
        stopped = true
      })
    })
    const operation = f.service.execute(f.input)
    await Promise.resolve()
    expect(stopped).toBe(false)
    gate.resolve()
    await operation
    await stopping
    expect(stopped).toBe(true)
    await expect(f.service.execute(f.input)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

function fixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const conversations = createConversationRepository(database)
  const now = '2026-09-28T00:00:00.000Z'
  conversations.create({ id: 'task-1', branchId: 'branch-1', title: 'Fixture', createdAt: now, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
  conversations.createMessage({ id: 'message-1', conversationId: 'task-1', branchId: 'branch-1', runId: null, role: 'user', content: { text: 'Fixture' }, createdAt: now })
  const runs = createRunRepository(database)
  runs.create({ id: 'source-run', conversationId: 'task-1', branchId: 'branch-1', triggeringMessageId: 'message-1', provider: 'fixture', model: 'fixture', piSessionFile: '/fixture/session.jsonl', purpose: 'chat', status: 'completed', startedAt: now, completedAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
  const drafts = createComposerDraftRepository(database)
  drafts.open({
    draftId: 'draft-1',
    scope: { kind: 'conversation_branch', conversationId: 'task-1', branchId: 'branch-1' },
    initialContent: { version: 1, panelResourceIds: [], body: [{ type: 'paragraph', content: [{ type: 'prompt_directive', directive: 'slash_command', commandMode: 'action', value: '/compact' }, { type: 'text', text: ' private summary' }] }] },
    initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
    initialModelSelection: null,
    now,
  })
  const commands = createCommandRequestRepository(database)
  const launch = vi.fn(async (runId: string, _signal?: AbortSignal) => ({ runId, completion: Promise.resolve(runs.findById(runId)!) }))
  const service = new ChatCommandService({ commands, conversations, drafts, runs, spaces: createSpaceRepository(database), conversationLifecycle: { isDeleting: conversations.isDeleted }, turnLauncher: { launch } })
  return { service, commands, drafts, runs, database, launch, input: { requestId: 'compact-1', draftId: 'draft-1', expectedRevision: 0 } }
}
