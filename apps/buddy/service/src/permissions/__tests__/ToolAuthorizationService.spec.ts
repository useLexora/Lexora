import type { BuddyExtensionRunContext } from '../../agent/extensions/BuddyExtensionRunContext'
import type { BuddyToolClassification } from '../../approvals/toolClassification'
import type { ApprovalRecord, ApprovalRepository } from '../../storage/approvalRepository'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalService } from '../../approvals/ApprovalService'
import { resolveGrantedPath } from '../../directories/resolveGrantedPath'
import { SandboxDirectoryPermissions } from '../../sandbox/SandboxDirectoryPermissions'
import { ToolAuthorizationService } from '../ToolAuthorizationService'
import { ToolExecutionPermissions } from '../ToolExecutionPermissions'

describe('harness tool authorization', () => {
  let root: string
  let workspace: string
  let outside: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'buddy-authorization-'))
    workspace = join(root, 'workspace')
    outside = join(root, 'outside')
    await Promise.all([workspace, outside].map(path => mkdir(path)))
    await writeFile(join(outside, '.env'), 'SYNTHETIC_VALUE=fixture')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function fixture() {
    const records = new Map<string, ApprovalRecord>()
    const events: Array<{ type: string, payload: unknown }> = []
    const repository: ApprovalRepository = {
      findById: id => records.get(id) ?? null,
      list: () => [...records.values()],
      listPending: runId => [...records.values()].filter(record => record.status === 'pending' && (!runId || runId === record.runId)),
    }
    const approvals = new ApprovalService({
      repository,
      eventLog: { append: async (event) => {
        events.push(event)
        if (event.type === 'approval.requested') {
          const record = event.payload as ApprovalRecord
          records.set(record.id, record)
        }
        if (event.type === 'approval.resolved') {
          const update = event.payload as Pick<ApprovalRecord, 'id' | 'resolvedAt' | 'status'>
          records.set(update.id, { ...records.get(update.id)!, ...update })
        }
      } },
    })
    const controller = new AbortController()
    const run: BuddyExtensionRunContext = {
      runId: 'run-1',
      signal: controller.signal,
      flushProjectedEvents: async () => {},
      onToolExecutionAuthorized: async () => {},
    }
    const executionPermissions = new ToolExecutionPermissions()
    const directories = new SandboxDirectoryPermissions()
    const grants = [{ canonicalRoot: workspace, root: workspace, grantId: 'workspace', kind: 'workspace' as const }]
    const options = {
      approvalService: approvals,
      approvalAvailable: true,
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write' as const,
      cwd: workspace,
      owner: { id: 'conversation', kind: 'conversation' as const },
      getGrants: () => grants,
      executionPermissions,
      applySandboxDirectory: (context: BuddyExtensionRunContext, grant: Parameters<SandboxDirectoryPermissions['grant']>[1]) => directories.grant(context, grant),
    }
    const authorization = new ToolAuthorizationService(options)
    let nextId = 0
    const call = (toolName: string, input: unknown) => ({ toolName, input, toolCallId: `call-${++nextId}` })
    async function approve(scope: 'approved' | 'denied' | 'approved_for_operation' | 'approved_for_source' | 'approved_for_turn') {
      await vi.waitFor(() => expect(repository.listPending()).toHaveLength(1))
      const pending = repository.listPending()[0]!
      await approvals.resolve({ id: pending.id, decision: scope })
      return pending
    }
    return { approvals, approve, authorization, call, controller, directories, events, executionPermissions, grants, options, records, repository, run }
  }

  it('revokes temporary tool grants when the required persistent application fails', async () => {
    const f = fixture()
    const authorization = new ToolAuthorizationService({ ...f.options, applyGrant: () => {
      throw new Error('owner revoked')
    } })
    const path = join(outside, 'preview.html')
    await writeFile(path, '<!doctype html><title>Preview</title>')
    const event = f.call('lexora_browser_open', { entryPath: path })
    const pending = authorization.authorize(event, f.run, { access: 'render', paths: [{ path, mode: 'existing' }] })
    await f.approve('approved')
    expect(await pending).toBe('DIRECTORY_GRANT_FAILED')
    expect(f.executionPermissions.get(f.run, event.toolCallId)).toEqual([])
  })

  it('isolates temporary tool grants and clears them at the run boundary', async () => {
    const f = fixture()
    const events: unknown[] = []
    f.executionPermissions.onDidChange(event => events.push(event))
    await f.executionPermissions.authorize(f.run, 'tool', { cwd: workspace, grants: f.grants, paths: [{ path: outside, mode: 'existing' }] })
    const snapshot = f.executionPermissions.get(f.run, 'tool')
    expect(snapshot).toHaveLength(1)
    expect(Reflect.set(snapshot[0]!, 'canonicalRoot', root)).toBe(false)
    expect(Reflect.set(snapshot, '0', { canonicalRoot: root })).toBe(false)
    expect(f.executionPermissions.get(f.run, 'other-tool')).toEqual([])
    f.controller.abort()
    expect(f.executionPermissions.get(f.run, 'tool')).toEqual([])
    expect(events).toMatchObject([{ kind: 'granted', count: 1 }, { kind: 'cleared', count: 1 }])
    expect(JSON.stringify(events)).not.toContain(outside)
  })

  it('queues concurrent network requests, reuses the destination across commands, and clears at run end', async () => {
    const f = fixture()
    const command = new AbortController()
    const resource = { network: { host: 'registry.example.com', port: 443 }, signal: command.signal }
    const first = f.authorization.authorize(f.call('bash', { command: 'pnpm lint' }), f.run, { access: 'network', requireApproval: true }, resource)
    const second = f.authorization.authorize(f.call('bash', { command: 'pnpm test' }), f.run, { access: 'network', requireApproval: true }, { network: resource.network })
    const review = await f.approve('approved_for_source')
    expect(review.payload).toMatchObject({ card: 'sandbox-network', reuseScopes: ['operation', 'source', 'turn'] })
    await expect(Promise.all([first, second])).resolves.toEqual([null, null])
    command.abort()
    await expect(f.authorization.authorize(f.call('bash', { command: 'pnpm build' }), f.run, { access: 'network', requireApproval: true }, { network: resource.network })).resolves.toBeNull()
    expect(f.records.size).toBe(1)
    expect(f.events.filter(event => event.type === 'approval.reused')).toHaveLength(2)

    const differentPort = f.authorization.authorize(f.call('bash', { command: 'pnpm test' }), f.run, { access: 'network', requireApproval: true }, { network: { ...resource.network, port: 8443 } })
    await f.approve('denied')
    await expect(differentPort).resolves.toBe('APPROVAL_DENIED')
    f.approvals.clearRunAuthorizations(f.run.runId)
    const afterClear = f.authorization.authorize(f.call('bash', { command: 'pnpm build' }), f.run, { access: 'network', requireApproval: true }, { network: resource.network })
    await f.approve('denied')
    await expect(afterClear).resolves.toBe('APPROVAL_DENIED')
  })

  it('keeps one-time approvals single-use and cancels queued requests independently', async () => {
    const f = fixture()
    const declare = { access: 'network' as const }
    const first = f.authorization.authorize(f.call('lexora_web_fetch', { url: 'https://example.com/a' }), f.run, declare)
    const queuedController = new AbortController()
    const cancelled = f.authorization.authorize(f.call('lexora_web_fetch', { url: 'https://example.com/b' }), f.run, declare, { signal: queuedController.signal })
    const cancelledResult = expect(cancelled).rejects.toMatchObject({ code: 'APPROVAL_CANCELLED' })
    await vi.waitFor(() => expect(f.repository.listPending()).toHaveLength(1))
    queuedController.abort()
    await cancelledResult
    await f.approve('approved')
    await expect(first).resolves.toBeNull()
    const next = f.authorization.authorize(f.call('lexora_web_fetch', { url: 'https://example.com/a' }), f.run, declare)
    await f.approve('denied')
    await expect(next).resolves.toBe('APPROVAL_DENIED')
    expect(f.records.size).toBe(2)
  })

  it('applies turn authorization to every approvable tool category while preserving hard denials', async () => {
    const f = fixture()
    const initial = f.authorization.authorize(f.call('lexora_web_fetch', { url: 'https://example.com' }), f.run, { access: 'network' })
    await f.approve('approved_for_turn')
    await initial

    const browser = {
      action: 'click' as const,
      actionDigest: 'a'.repeat(64),
      documentRevision: 1,
      effect: 'submit' as const,
      key: null,
      observationId: 'b3a5d63b-17b7-4b5a-863a-37f135e297d4',
      origin: 'https://example.com',
      pageId: 'ed312709-baf9-44b3-a292-108055838477',
      risk: 'commit-like' as const,
      sessionId: '6f828cc1-6549-4245-b26e-43b2917c9281',
      targetName: 'Submit',
      targetRole: 'button',
    }
    const cases: Array<[string, unknown, BuddyToolClassification]> = [
      ['lexora_host_shell', { command: 'node fixture.mjs' }, { access: 'execute', forceAsk: true }],
      ['lexora_system_action', { action: 'restart-service', target: { kind: 'service', scope: 'user', serviceId: 'fixture.service' } }, {
        access: 'execute',
        forceAsk: true,
        approval: { kind: 'system', summary: 'Restart fixture', systemAction: { action: 'restart-service', effect: 'Restart', expiresAt: new Date(Date.now() + 60000).toISOString(), interruption: 'service', reason: 'Fixture', target: { displayName: 'Fixture', serviceId: 'fixture.service' } } },
      }],
      ['lexora_browser_act', { action: { kind: 'click', ref: 'fixture' } }, { forceAsk: true, approval: { kind: 'browser', summary: 'Submit fixture', browser }, validateBeforeExecution: async () => null }],
      ['lexora_buddy_automation', { operation: 'pause', automationId: 'fixture' }, {
        forceAsk: true,
        approval: { kind: 'automation', summary: 'Pause fixture', automation: { executionProfile: 'workspace_write', modelMode: 'default', name: 'Fixture', operation: 'pause', spaceId: null, promptSummary: 'Fixture', scheduleSummary: 'Daily', timezone: 'UTC' } },
      }],
      ['read', { path: join(outside, '.env') }, {}],
      ['mcp__fixture__search', { query: 'fixture' }, { access: 'network', requireApproval: true, approval: { kind: 'mcp', summary: 'Search', reuse: { operation: ['fixture', 1, 'search'], source: ['fixture', 1] } } }],
      ['lexora_authorize_directory', { path: outside, access: 'write', reason: 'Fixture' }, { shellBoundary: 'sandbox' }],
      ['future_plugin_tool', { action: 'fixture' }, {}],
    ]
    for (const [name, input, declared] of cases)
      await expect(f.authorization.authorize(f.call(name, input), f.run, declared), name).resolves.toBeNull()

    expect(f.directories.get(f.run)).toMatchObject([{ path: outside, access: 'write' }])
    expect(f.records.size).toBe(1)
    const readOnly = new ToolAuthorizationService({ ...f.options, executionProfile: 'read_only' })
    await expect(readOnly.authorize(f.call('write', { path: join(workspace, 'blocked.txt'), content: 'no' }), f.run)).resolves.toBe('READ_ONLY_PROFILE')
    const background = new ToolAuthorizationService({ ...f.options, approvalAvailable: false })
    await expect(background.authorize(f.call('lexora_host_shell', { command: 'node fixture.mjs' }), f.run)).resolves.toBe('APPROVAL_UNAVAILABLE_IN_BACKGROUND')
    const stale = f.authorization.authorize(f.call('lexora_browser_act', {}), f.run, { forceAsk: true, approval: { kind: 'browser', summary: 'Stale', browser }, validateBeforeExecution: async () => ({ blocked: true, reason: 'BROWSER_TARGET_STALE' }) })
    await expect(stale).resolves.toBe('BROWSER_TARGET_STALE')
    expect(f.records.size).toBe(1)
  })

  it('rejects a path replaced while waiting without granting its new target', async () => {
    const f = fixture()
    const another = join(root, 'another')
    await mkdir(another)
    const link = join(workspace, 'output')
    await symlink(outside, link, 'dir')
    const event = f.call('lexora_image_generate', { outputPath: join(link, 'image.png') })
    const pending = f.authorization.authorize(event, f.run, { access: 'write', paths: [{ path: join(link, 'image.png'), mode: 'create' }] })
    await vi.waitFor(() => expect(f.repository.listPending()).toHaveLength(1))
    await unlink(link)
    await symlink(another, link, 'dir')
    await f.approve('approved_for_operation')
    await expect(pending).resolves.toBe('INVALID_PATH')
    expect(f.executionPermissions.get(f.run, event.toolCallId)).toEqual([])
    expect(f.grants).toHaveLength(1)
  })

  it('cancels resource requests when the run stops even if their command signal remains active', async () => {
    const f = fixture()
    const command = new AbortController()
    const pending = f.authorization.authorize(f.call('bash', { command: 'curl https://example.com' }), f.run, { access: 'network' }, { signal: command.signal })
    const result = expect(pending).rejects.toMatchObject({ code: 'APPROVAL_CANCELLED' })
    await vi.waitFor(() => expect(f.repository.listPending()).toHaveLength(1))
    f.controller.abort()
    await result
    expect(command.signal.aborted).toBe(false)
    expect(f.repository.listPending()).toEqual([])
  })

  it('passes temporary grants to the approved execution only without changing saved grants', async () => {
    const f = fixture()
    const output = join(outside, 'image.png')
    const event = f.call('lexora_image_generate', { outputPath: output })
    const pending = f.authorization.authorize(event, f.run, { access: 'write', paths: [{ path: output, mode: 'create' }] })
    await f.approve('approved_for_turn')
    await expect(pending).resolves.toBeNull()
    const executionGrants = [...f.grants, ...f.executionPermissions.get(f.run, event.toolCallId)]
    const resolved = await resolveGrantedPath(executionGrants, output, 'create')
    await writeFile(resolved.canonicalPath, 'synthetic image bytes')
    expect(await readFile(output, 'utf8')).toBe('synthetic image bytes')
    expect(f.grants).toHaveLength(1)
    await expect(resolveGrantedPath(f.grants, output, 'existing')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
    expect(f.executionPermissions.get(f.run, 'another-call')).toEqual([])
    expect(f.executionPermissions.get({ ...f.run, runId: 'run-2' }, event.toolCallId)).toEqual([])
    f.controller.abort()
    expect(f.executionPermissions.get(f.run, event.toolCallId)).toEqual([])
  })
})
