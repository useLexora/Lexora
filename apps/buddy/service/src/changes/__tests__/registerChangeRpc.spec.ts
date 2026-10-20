import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { changesRpc } from '../../../../shared/changes/changeApi'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { ChangeCaptureService } from '../ChangeCaptureService'
import { createChangeSetRepository } from '../changeSetRepository'
import { MutationCoordinator } from '../MutationCoordinator'
import { MutationRecoveryService } from '../MutationRecoveryService'
import { registerChangeRpc } from '../registerChangeRpc'

describe('branch changes overview', () => {
  it('includes inherited runs up to the fork and excludes sibling and later ancestor changes', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const root = await mkdtemp(join(tmpdir(), 'buddy-overview-'))
    try {
      const conversations = createConversationRepository(database)
      const runs = createRunRepository(database)
      const repository = createChangeSetRepository(database)
      const service = new ChangeCaptureService({ paths: new BuddyDataPaths(root), repository })
      const now = '2026-09-09T00:00:00.000Z'
      conversations.create({ id: 'conversation', branchId: 'root', createdAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write', spaceId: null, title: 'Files' })
      function turn(id: string, branchId: string, createdAt: string, parentRunId?: string) {
        if (!parentRunId)
          conversations.createMessage({ id: `question-${id}`, conversationId: 'conversation', branchId, role: 'user', runId: null, createdAt, content: { text: id } })
        runs.create({ id, conversationId: 'conversation', branchId, triggeringMessageId: `question-${parentRunId ?? id}`, rootRunId: parentRunId, parentRunId, executionKind: parentRunId ? 'npc_child' : 'root', provider: 'fixture', model: 'fixture', purpose: 'chat', status: 'completed', startedAt: createdAt, completedAt: createdAt, approvalPolicy: 'policy', executionProfile: 'workspace_write', piSessionFile: null })
        if (!parentRunId)
          conversations.createMessage({ id: `answer-${id}`, conversationId: 'conversation', branchId, role: 'assistant', runId: id, createdAt, content: { text: id } })
        repository.ensureSet({ id, runId: id, conversationId: 'conversation', coverage: 'complete', status: 'completed', fileCount: 1, createdAt, updatedAt: createdAt })
        repository.createCapture({ id: `capture-${id}`, changeSetId: id, directoryGrantId: 'workspace', canonicalPath: join(root, `${id}.bin`), relativePath: `${id}.bin`, toolCallId: `tool-${id}`, toolName: 'write', status: 'completed', toolReportedError: false, createdAt, completedAt: createdAt, before: { kind: 'missing', hash: null, sizeBytes: null, snapshotPath: null, redacted: false }, after: { kind: 'binary', hash: id, sizeBytes: 16, snapshotPath: null, redacted: false } })
      }
      turn('first', 'root', now)
      turn('first-npc', 'root', now, 'first')
      turn('later', 'root', '2026-09-09T00:01:00.000Z')
      turn('later-npc', 'root', '2026-09-09T00:01:00.000Z', 'later')
      conversations.createBranch({ id: 'child', conversationId: 'conversation', parentBranchId: 'root', forkedFromMessageId: 'answer-first', createdAt: now, activate: true })
      turn('child-only', 'child', '2026-09-09T00:02:00.000Z')
      const handlers = new Map<string, RuntimeRequestHandler>()
      const dispose = registerChangeRpc({ conversations, runs, service, recovery: new MutationRecoveryService({ mutations: new MutationCoordinator() }), rpc: { onRequest: (method, handler) => {
        handlers.set(method, handler)
        return () => handlers.delete(method)
      } } })
      const overview = async (branchId: string) => changesRpc.overview.response.parse(await handlers.get(changesRpc.overview.method)!({ conversationId: 'conversation', branchId }))
      expect((await overview('child')).files.map(file => file.path)).toEqual(['first.bin', 'first-npc.bin', 'child-only.bin'])
      expect((await overview('root')).files.map(file => file.path)).toEqual(['first.bin', 'first-npc.bin', 'later.bin', 'later-npc.bin'])
      expect((await service.getVisibleDetail('first')).files.map(file => file.path)).toEqual(['first.bin', 'first-npc.bin'])
      expect(service.listSummariesForRuns(['first'])).toMatchObject([{ changeSetId: 'first', fileCount: 2 }])
      database.prepare('DELETE FROM run_change_sets WHERE run_id = ?').run('first')
      expect((await service.getVisibleDetail('first')).files.map(file => file.path)).toEqual(['first-npc.bin'])
      expect(service.listSummariesForRuns(['first'])).toMatchObject([{ changeSetId: 'first', fileCount: 1 }])
      conversations.markDeleted('conversation', now)
      await expect(overview('child')).rejects.toThrow()
      dispose()
    }
    finally {
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
