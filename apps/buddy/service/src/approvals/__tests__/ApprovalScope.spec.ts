import type { AppendBuddyRunEventInput } from '../../events/BuddyRunEvent'
import type {
  ApprovalRecord,
  ApprovalRepository,
  ApprovalStatus,
} from '../../storage/approvalRepository'
import type { ApprovalLifecycleFact } from '../ApprovalService'
import { describe, expect, it, vi } from 'vitest'

import { ApprovalService } from '../ApprovalService'

describe('turn approval scope', () => {
  it('releases an aborted queued request without installing a waiter or persisting an approval', async () => {
    const records = new Map<string, ApprovalRecord>()
    const repository = createRepository(records)
    const service = new ApprovalService({ eventLog: { append: input => appendApprovalEvent(records, input) }, repository })
    const facts: ApprovalLifecycleFact[] = []
    service.onDidChange(event => facts.push(event))
    const first = service.request(shellRequest('run-queue', 'tool-first', 'pnpm test', new AbortController().signal))
    await vi.waitFor(() => expect(repository.listPending()).toHaveLength(1))
    const controller = new AbortController()
    const queued = service.request(shellRequest('run-queue', 'tool-queued', 'pnpm lint', controller.signal))
    controller.abort()
    await expect(queued).rejects.toMatchObject({ code: 'APPROVAL_CANCELLED' })
    expect(facts.filter(event => 'toolCallId' in event && event.toolCallId === 'tool-queued')).toEqual([
      expect.objectContaining({ kind: 'request.queued' }),
      expect.objectContaining({ kind: 'request.released', reason: 'cancelled' }),
    ])
    await service.resolve({ id: repository.listPending()[0]!.id, decision: 'denied' })
    await first
    await service.dispose()
    expect(records.size).toBe(1)
    expect(facts.filter(event => event.kind === 'waiter.started')).toHaveLength(1)
  })

  it('reports released waiters separately from failed durable cancellation and drains shutdown', async () => {
    const records = new Map<string, ApprovalRecord>()
    const repository = createRepository(records)
    const service = new ApprovalService({
      eventLog: { append: input => input.type === 'approval.resolved' ? Promise.reject(new Error('Store unavailable')) : appendApprovalEvent(records, input) },
      repository,
    })
    const facts: ApprovalLifecycleFact[] = []
    service.onDidChange(event => facts.push(event))
    const first = service.request(shellRequest('run-stop', 'tool-active', 'pnpm test', new AbortController().signal))
    const decisions = Promise.allSettled([first, service.request(shellRequest('run-stop', 'tool-queued', 'pnpm lint', new AbortController().signal))])
    await vi.waitFor(() => expect(repository.listPending()).toHaveLength(1))
    await expect(service.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect((await decisions).map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(repository.listPending()).toHaveLength(1)
    expect(facts).toContainEqual(expect.objectContaining({ kind: 'waiter.released', reason: 'shutdown', persistence: 'failed' }))
    expect(facts).toContainEqual(expect.objectContaining({ kind: 'request.released', toolCallId: 'tool-queued', reason: 'shutdown' }))
    await expect(service.request(shellRequest('run-stop', 'tool-late', 'pnpm test', new AbortController().signal))).rejects.toMatchObject({ code: 'APPROVAL_CANCELLED' })
  })

  it('drains the required expiry cancellation after the waiter has been released', async () => {
    const records = new Map<string, ApprovalRecord>()
    const repository = createRepository(records)
    const expired = Promise.withResolvers<void>()
    const onExpired = vi.fn(() => expired.promise)
    const service = new ApprovalService({ approvalTimeoutMs: 5, onExpired, eventLog: { append: input => appendApprovalEvent(records, input) }, repository })
    const facts: ApprovalLifecycleFact[] = []
    service.onDidChange(event => facts.push(event))
    await expect(service.request(shellRequest('run-expiry', 'tool-expiry', 'pnpm test', new AbortController().signal))).rejects.toMatchObject({ code: 'AUTOMATION_APPROVAL_EXPIRED' })
    expect(facts).toContainEqual(expect.objectContaining({ kind: 'waiter.released', reason: 'expired', persistence: 'committed' }))
    let stopped = false
    const stopping = service.dispose().then(() => {
      stopped = true
    })
    await vi.waitFor(() => expect(onExpired).toHaveBeenCalledOnce())
    expect(stopped).toBe(false)
    expired.resolve()
    await stopping
    expect(stopped).toBe(true)
  })

  it('reuses approval for later approvable operations in the same turn only', async () => {
    const records = new Map<string, ApprovalRecord>()
    const repository = createRepository(records)
    const service = new ApprovalService({
      eventLog: { append: input => appendApprovalEvent(records, input) },
      repository,
    })
    const facts: ApprovalLifecycleFact[] = []
    service.onDidChange(event => facts.push(event))
    const controller = new AbortController()
    const initial = service.request({
      reuseScopes: ['operation', 'source', 'turn'],
      arguments: { command: 'npm view package version' },
      kind: 'network',
      runId: 'run-1',
      signal: controller.signal,
      summary: 'Access package metadata',
      toolCallId: 'tool-1',
      toolName: 'bash',
    })
    await vi.waitFor(() => expect(repository.listPending('run-1')).toHaveLength(1))
    await service.resolve({
      decision: 'approved_for_turn',
      id: repository.listPending('run-1')[0]!.id,
    })
    const sourceApprovalId = repository.list({ runId: 'run-1' })[0]!.id
    await expect(initial).resolves.toEqual({
      approvalId: sourceApprovalId,
      decision: 'approved_for_turn',
    })

    await expect(service.request({
      reuseScopes: ['operation', 'source', 'turn'],
      arguments: { command: 'python process.py' },
      kind: 'shell',
      runId: 'run-1',
      signal: new AbortController().signal,
      summary: 'Run image processor',
      toolCallId: 'tool-2',
      toolName: 'bash',
    })).resolves.toEqual({
      decision: 'approved_by_turn',
      sourceApprovalId,
    })
    expect(repository.list({ runId: 'run-1' })).toHaveLength(1)

    const nextTurn = service.request({
      reuseScopes: ['operation', 'source', 'turn'],
      arguments: { command: 'python process.py' },
      kind: 'shell',
      runId: 'run-2',
      signal: controller.signal,
      summary: 'Run image processor',
      toolCallId: 'tool-3',
      toolName: 'bash',
    })
    await vi.waitFor(() => expect(repository.listPending('run-2')).toHaveLength(1))
    const pending = repository.listPending('run-2')[0]!
    await service.resolve({ decision: 'denied', id: pending.id })
    await expect(nextTurn).resolves.toEqual({
      approvalId: pending.id,
      decision: 'denied',
    })

    service.clearRunAuthorizations('run-1')
    service.clearRunAuthorizations('run-1')
    expect(facts.filter(event => event.kind === 'authorization.established')).toEqual([
      expect.objectContaining({ runId: 'run-1', scope: 'turn', approvalId: sourceApprovalId }),
    ])
    expect(facts.filter(event => event.kind === 'authorization.cleared')).toEqual([
      { kind: 'authorization.cleared', runId: 'run-1', reason: 'run_settled', count: 1 },
    ])
    const clearedTurn = service.request({
      reuseScopes: ['operation', 'source', 'turn'],
      arguments: { command: 'python process.py' },
      kind: 'shell',
      runId: 'run-1',
      signal: new AbortController().signal,
      summary: 'Run image processor',
      toolCallId: 'tool-4',
      toolName: 'bash',
    })
    await vi.waitFor(() => expect(repository.listPending('run-1')).toHaveLength(1))
    const clearedPending = repository.listPending('run-1')[0]!
    await service.resolve({ decision: 'denied', id: clearedPending.id })
    await expect(clearedTurn).resolves.toEqual({
      approvalId: clearedPending.id,
      decision: 'denied',
    })
  })

  it('distinguishes exact operations from their current source', async () => {
    const records = new Map<string, ApprovalRecord>()
    const repository = createRepository(records)
    const service = new ApprovalService({
      eventLog: { append: input => appendApprovalEvent(records, input) },
      repository,
    })
    const controller = new AbortController()
    const first = service.request(shellRequest('run-operation', 'tool-1', 'pnpm test', controller.signal))
    await vi.waitFor(() => expect(repository.listPending('run-operation')).toHaveLength(1))
    const operationApproval = repository.listPending('run-operation')[0]!
    await service.resolve({ decision: 'approved_for_operation', id: operationApproval.id })
    await expect(first).resolves.toMatchObject({ decision: 'approved_for_operation' })
    await expect(service.request(shellRequest('run-operation', 'tool-2', 'pnpm test', controller.signal))).resolves.toEqual({
      decision: 'approved_by_operation',
      sourceApprovalId: operationApproval.id,
    })

    const differentOperation = service.request(shellRequest('run-operation', 'tool-3', 'pnpm lint', controller.signal))
    await vi.waitFor(() => expect(repository.listPending('run-operation')).toHaveLength(1))
    const denied = repository.listPending('run-operation')[0]!
    await service.resolve({ decision: 'denied', id: denied.id })
    await expect(differentOperation).resolves.toMatchObject({ decision: 'denied' })

    const sourceRequest = service.request(shellRequest('run-source', 'tool-4', 'pnpm test', controller.signal))
    await vi.waitFor(() => expect(repository.listPending('run-source')).toHaveLength(1))
    const sourceApproval = repository.listPending('run-source')[0]!
    await service.resolve({ decision: 'approved_for_source', id: sourceApproval.id })
    await expect(sourceRequest).resolves.toMatchObject({ decision: 'approved_for_source' })
    await expect(service.request(shellRequest('run-source', 'tool-5', 'pnpm lint', controller.signal))).resolves.toEqual({
      decision: 'approved_by_source',
      sourceApprovalId: sourceApproval.id,
    })
  })

  it('normalizes file targets before reusing an operation approval', async () => {
    const records = new Map<string, ApprovalRecord>()
    const repository = createRepository(records)
    const service = new ApprovalService({
      eventLog: { append: input => appendApprovalEvent(records, input) },
      repository,
    })
    const signal = new AbortController().signal
    const first = service.request(pathRequest('run-path', 'tool-path-1', 'notes/todo.md', signal))
    await vi.waitFor(() => expect(repository.listPending('run-path')).toHaveLength(1))
    const approved = repository.listPending('run-path')[0]!
    await service.resolve({ decision: 'approved_for_operation', id: approved.id })
    await first

    await expect(service.request(pathRequest('run-path', 'tool-path-2', '/workspace/notes/todo.md', signal))).resolves.toEqual({
      decision: 'approved_by_operation',
      sourceApprovalId: approved.id,
    })

    const changed = service.request(pathRequest('run-path', 'tool-path-3', '/workspace/notes/done.md', signal))
    await vi.waitFor(() => expect(repository.listPending('run-path')).toHaveLength(1))
    const changedApproval = repository.listPending('run-path')[0]!
    await service.resolve({ decision: 'denied', id: changedApproval.id })
    await expect(changed).resolves.toMatchObject({ decision: 'denied' })
  })

  it('reuses MCP tools across arguments but invalidates connector generations', async () => {
    const records = new Map<string, ApprovalRecord>()
    const repository = createRepository(records)
    const service = new ApprovalService({
      eventLog: { append: input => appendApprovalEvent(records, input) },
      repository,
    })
    const signal = new AbortController().signal
    const initial = service.request({
      reuseScopes: ['operation', 'source', 'turn'],
      arguments: { query: 'first' },
      kind: 'mcp',
      reuse: { operation: ['calendar', 3, 'search'], source: ['calendar', 3] },
      runId: 'run-mcp',
      signal,
      summary: 'Calendar: search',
      toolCallId: 'tool-mcp-1',
      toolName: 'mcp__calendar__search',
    })
    await vi.waitFor(() => expect(repository.listPending('run-mcp')).toHaveLength(1))
    const approved = repository.listPending('run-mcp')[0]!
    await service.resolve({ decision: 'approved_for_operation', id: approved.id })
    await initial
    await expect(service.request({
      reuseScopes: ['operation', 'source', 'turn'],
      arguments: { query: 'second' },
      kind: 'mcp',
      reuse: { operation: ['calendar', 3, 'search'], source: ['calendar', 3] },
      runId: 'run-mcp',
      signal,
      summary: 'Calendar: search',
      toolCallId: 'tool-mcp-2',
      toolName: 'mcp__calendar__search',
    })).resolves.toMatchObject({ decision: 'approved_by_operation' })

    const changed = service.request({
      reuseScopes: ['operation', 'source', 'turn'],
      arguments: { query: 'third' },
      kind: 'mcp',
      reuse: { operation: ['calendar', 4, 'search'], source: ['calendar', 4] },
      runId: 'run-mcp',
      signal,
      summary: 'Calendar: search',
      toolCallId: 'tool-mcp-3',
      toolName: 'mcp__calendar__search',
    })
    await vi.waitFor(() => expect(repository.listPending('run-mcp')).toHaveLength(1))
    const changedApproval = repository.listPending('run-mcp')[0]!
    await service.resolve({ decision: 'denied', id: changedApproval.id })
    await expect(changed).resolves.toMatchObject({ decision: 'denied' })
  })

  it('rejects every reusable scope for explicitly single-use approvals', async () => {
    const records = new Map<string, ApprovalRecord>()
    const repository = createRepository(records)
    const service = new ApprovalService({
      eventLog: { append: input => appendApprovalEvent(records, input) },
      repository,
    })
    const request = service.request({
      reuseScopes: [],
      arguments: { command: 'systemctl restart fixture' },
      kind: 'shell',
      runId: 'run-single-use',
      signal: new AbortController().signal,
      summary: 'Restart a system service',
      toolCallId: 'tool-single-use',
      toolName: 'bash',
    })
    await vi.waitFor(() => expect(repository.listPending('run-single-use')).toHaveLength(1))
    const approval = repository.listPending('run-single-use')[0]!
    for (const scope of ['operation', 'source', 'turn'] as const) {
      await expect(service.resolve({ decision: `approved_for_${scope}`, id: approval.id }))
        .rejects
        .toMatchObject({ code: 'APPROVAL_NOT_PENDING' })
    }
    await service.resolve({ decision: 'denied', id: approval.id })
    await expect(request).resolves.toMatchObject({ decision: 'denied' })
  })
})

function shellRequest(runId: string, toolCallId: string, command: string, signal: AbortSignal) {
  return {
    allowForTurn: true,
    arguments: { command },
    kind: 'shell' as const,
    runId,
    signal,
    shell: { cwd: '/workspace', reason: 'manual-policy' as const },
    summary: 'Run a host shell command',
    toolCallId,
    toolName: 'bash',
  }
}

function pathRequest(runId: string, toolCallId: string, path: string, signal: AbortSignal) {
  return {
    allowForTurn: true,
    arguments: { path },
    cwd: '/workspace',
    kind: 'write' as const,
    paths: {
      access: 'write' as const,
      grant: null,
      targets: [{ path, zone: 'workspace' as const }],
    },
    runId,
    signal,
    summary: 'Write a file',
    toolCallId,
    toolName: 'write_file',
  }
}

function createRepository(records: Map<string, ApprovalRecord>): ApprovalRepository {
  return {
    findById: id => records.get(id) ?? null,
    list: (options = {}) => [...records.values()]
      .filter(record => options.runId == null || record.runId === options.runId)
      .filter(record => options.status == null || record.status === options.status)
      .slice(0, options.limit ?? 100),
    listPending: runId => [...records.values()].filter(record => (
      record.status === 'pending' && (runId === undefined || record.runId === runId)
    )),
  }
}

function appendApprovalEvent(
  records: Map<string, ApprovalRecord>,
  input: AppendBuddyRunEventInput,
): Promise<unknown> {
  if (input.type === 'approval.requested') {
    const approval = input.payload as ApprovalRecord
    records.set(approval.id, approval)
  }
  if (input.type === 'approval.resolved') {
    const resolution = input.payload as {
      id: string
      resolvedAt: string
      status: ApprovalStatus
    }
    const approval = records.get(resolution.id)
    if (approval) {
      records.set(resolution.id, {
        ...approval,
        resolvedAt: resolution.resolvedAt,
        status: resolution.status,
      })
    }
  }
  return Promise.resolve(input)
}
