import type { DatabaseSync } from 'node:sqlite'
import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import type { RunEventLogPort } from '../../events/RunEventPorts'
import type { RuntimeRequestRegistrar } from '../../rpc/runtimeRequest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRunEventLog } from '../../events/createRunEventLog'
import { prepareTestTurnRequest } from '../../storage/__tests__/composerDraftTestFixture'
import { createExecutionStorageFixture } from '../../storage/__tests__/executionFixture'
import { createApprovalRepository } from '../../storage/approvalRepository'
import { openBuddyDatabase } from '../../storage/database'
import { ApprovalService } from '../ApprovalService'
import { registerApprovalRpc } from '../registerApprovalRpc'

const databases: DatabaseSync[] = []
const directories: string[] = []
const eventLogs: RunEventLogPort[] = []

afterEach(async () => {
  await Promise.all(eventLogs.splice(0).map(eventLog => eventLog.close()))
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('registerApprovalRpc', () => {
  it('scopes pending approvals to the requested root tree before applying the limit', async () => {
    const f = createExecutionStorageFixture()
    const database = f.database
    databases.push(database)
    f.executions.admitChild(f.child('child'))
    prepareRun(database)
    const repository = createApprovalRepository(database)
    const eventLog = await createEventLog(database)
    const service = new ApprovalService({ eventLog, repository })
    const harness = createRpcHarness()
    registerApprovalRpc({ repository, rpc: harness.rpc, service })
    for (const [index, runId] of ['root', 'child', 'run-approval'].entries()) {
      await eventLog.append({ runId, type: 'approval.requested', payload: {
        id: `approval-${runId}`,
        runId,
        toolCallId: `tool-${runId}`,
        kind: 'shell',
        status: 'pending',
        summary: 'Confirm this execution',
        payload: { card: 'shell', command: 'pwd', toolName: 'bash', allowForTurn: true, reuseScopes: ['turn'] },
        createdAt: `2026-10-12T00:00:0${index}.000Z`,
        resolvedAt: null,
      } })
    }
    const scope = { conversationId: 'conversation', branchId: 'branch', status: 'pending' }
    await expect(harness.invoke('approvals.list', scope)).resolves.toEqual([
      expect.objectContaining({ runId: 'child' }),
      expect.objectContaining({ runId: 'root' }),
    ])
    await expect(harness.invoke('approvals.list', { ...scope, limit: 1 })).resolves.toEqual([expect.objectContaining({ runId: 'child' })])
    await expect(harness.invoke('approvals.list', { status: 'pending', limit: 1 })).resolves.toEqual([expect.objectContaining({ runId: 'run-approval' })])
    await expect(harness.invoke('approvals.list', { ...scope, runId: 'run-approval' })).resolves.toEqual([])
    await expect(harness.invoke('approvals.list', { ...scope, branchId: 'another-branch' })).resolves.toEqual([])
    await expect(harness.invoke('approvals.list', { conversationId: 'conversation' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(harness.invoke('approvals.list', { branchId: 'branch' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    f.conversations.markDeleted('conversation', '2026-10-12T00:00:03.000Z')
    await expect(harness.invoke('approvals.list', scope)).resolves.toEqual([])
    expect(repository.listPending()).toHaveLength(3)
    await service.dispose()
  })

  it('owns approval validation and resolves the durable request through ApprovalService', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    prepareRun(database)
    const repository = createApprovalRepository(database)
    const eventLog = await createEventLog(database)
    const service = new ApprovalService({ eventLog, repository })
    const harness = createRpcHarness()
    registerApprovalRpc({ repository, rpc: harness.rpc, service })

    const decision = service.request({
      reuseScopes: ['operation', 'source', 'turn'],
      arguments: {
        command: 'API_TOKEN=super-secret curl --token another-secret https://example.com',
      },
      kind: 'shell',
      runId: 'run-approval',
      signal: new AbortController().signal,
      summary: 'Call the remote service',
      toolCallId: 'tool-shell',
      toolName: 'bash',
    })
    await vi.waitFor(() => expect(repository.listPending('run-approval')).toHaveLength(1))
    const pending = repository.listPending('run-approval')[0]!

    const listed = await harness.invoke('approvals.list', {
      limit: 1,
      runId: 'run-approval',
      status: 'pending',
    })
    expect(listed).toEqual([expect.objectContaining({
      id: pending.id,
      kind: 'shell',
      payload: {
        allowForTurn: true,
        card: 'shell',
        command: 'API_TOKEN=[redacted] curl --token=[redacted] https://example.com',
        reuseScopes: ['operation', 'source', 'turn'],
        toolName: 'bash',
      },
      status: 'pending',
    })])
    expect(JSON.stringify(listed)).not.toContain('super-secret')
    expect(JSON.stringify(listed)).not.toContain('another-secret')

    const approved = await harness.invoke('approvals.approve', { approvalId: pending.id, scope: 'turn' })
    expect(approved).toMatchObject({ id: pending.id, kind: 'shell', status: 'approved' })
    await expect(decision).resolves.toEqual({
      approvalId: pending.id,
      decision: 'approved_for_turn',
    })
    expect(repository.findById(pending.id)).toMatchObject({ status: 'approved' })

    const approvalEvents = (await eventLog.read('run-approval')).filter(
      event => event.type.startsWith('approval.'),
    )
    expect(approvalEvents.map(event => event.type)).toEqual([
      'approval.requested',
      'approval.resolved',
    ])
    expect(approvalEvents[1]?.payload).toMatchObject({
      id: pending.id,
      status: 'approved',
    })
    await expect(harness.invoke('approvals.list', { status: 'approved' }))
      .resolves
      .toEqual([approved])
    await expect(harness.invoke('approvals.list', { status: 'waiting' }))
      .rejects
      .toMatchObject({ code: 'VALIDATION_FAILED' })

    const renderDecision = service.request({
      reuseScopes: [],
      arguments: { path: '/workspace/report.html' },
      kind: 'render',
      paths: {
        access: 'render',
        grant: null,
        targets: [{ path: '/workspace/report.html', zone: 'workspace' }],
      },
      runId: 'run-approval',
      signal: new AbortController().signal,
      summary: 'Open local page',
      toolCallId: 'tool-render',
      toolName: 'lexora_browser_open',
    })
    await vi.waitFor(() => expect(repository.listPending('run-approval')).toHaveLength(1))
    const renderApproval = repository.listPending('run-approval')[0]!
    await expect(harness.invoke('approvals.list', {
      runId: 'run-approval',
      status: 'pending',
    })).resolves.toEqual([
      expect.objectContaining({ id: renderApproval.id, kind: 'render' }),
    ])
    await harness.invoke('approvals.deny', { approvalId: renderApproval.id })
    await expect(renderDecision).resolves.toEqual({
      approvalId: renderApproval.id,
      decision: 'denied',
    })
  })
})

function prepareRun(database: DatabaseSync) {
  prepareTestTurnRequest(database, {
    attachmentBindings: [],
    branchId: 'branch-approval',
    conversationId: 'conversation-approval',
    createdAt: '2026-08-27T00:00:00.000Z',
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write',
    model: 'model-1',
    spaceId: null,
    provider: 'provider-1',
    requestFingerprint: 'fingerprint-approval',
    requestId: 'request-approval',
    runInput: {
      attachmentIds: [],
      contextItems: [],
      prompt: 'hello',
      reasoning: null,
      serviceTier: null,
    },
    runId: 'run-approval',
    title: null,
    userMessageContent: { text: 'hello' },
    userMessageId: 'message-approval',
  })
}

async function createEventLog(database: DatabaseSync): Promise<RunEventLogPort> {
  const root = await mkdtemp(join(tmpdir(), 'lexora-buddy-approval-rpc-'))
  directories.push(root)
  const eventLog = createRunEventLog({
    conversationsDirectory: join(root, 'conversations'),
    database,
  })
  eventLogs.push(eventLog)
  return eventLog
}

function createRpcHarness() {
  const handlers = new Map<string, RuntimeRequestHandler>()
  const rpc: RuntimeRequestRegistrar = {
    onRequest(method, handler) {
      handlers.set(method, handler)
      return () => handlers.delete(method)
    },
  }
  return {
    async invoke(method: string, params: unknown) {
      const handler = handlers.get(method)
      if (!handler)
        throw new Error(`Missing handler: ${method}`)
      return await handler(params)
    },
    rpc,
  }
}
