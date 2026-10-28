import type { BuddyExtensionRunContext } from '../../agent/extensions/BuddyExtensionRunContext'
import type { BuddyToolClassification } from '../../approvals/toolClassification'
import type { ApprovalRecord, ApprovalRepository } from '../../storage/approvalRepository'
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as userHomePaths from '../../../../platform/filesystem/userHomePaths'
import { DEFAULT_NETWORK_PERMISSIONS, upsertNetworkPermission } from '../../../../shared/permissions/networkPermissions'
import { SessionToolScope } from '../../agent/extensions/discovery/SessionToolScope'
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
      hasPending: runId => [...records.values()].some(record => record.runId === runId && record.status === 'pending'),
      findById: id => records.get(id) ?? null,
      list: () => [...records.values()],
      listPending: runId => [...records.values()].filter(record => record.status === 'pending' && (!runId || runId === record.runId)),
    }
    let failResolution = false
    const approvals = new ApprovalService({
      repository,
      eventLog: { append: async (event) => {
        if (event.type === 'approval.resolved' && failResolution) {
          failResolution = false
          throw new Error('Audit storage temporarily unavailable')
        }
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
      getSandboxDirectories: (context: BuddyExtensionRunContext) => directories.get(context),
      executionPermissions,
      applySandboxDirectory: (context: BuddyExtensionRunContext, grant: Parameters<SandboxDirectoryPermissions['grant']>[1]) => directories.grant(context, grant),
    }
    const authorization = new ToolAuthorizationService(options)
    let nextId = 0
    const call = (toolName: string, input: unknown) => ({ toolName, input, toolCallId: `call-${++nextId}` })
    async function approve(scope: 'approved' | 'denied' | 'approved_for_operation' | 'approved_for_source' | 'approved_for_turn' | 'approved_persistently') {
      await vi.waitFor(() => expect(repository.listPending()).toHaveLength(1))
      const pending = repository.listPending()[0]!
      await approvals.resolve({ id: pending.id, decision: scope })
      return pending
    }
    const failNextResolution = () => {
      failResolution = true
    }
    return { failNextResolution, approvals, approve, authorization, call, controller, directories, events, executionPermissions, grants, options, records, repository, run }
  }

  it.each([
    ['ask', 'policy', 'workspace_write', 'APPROVAL_UNAVAILABLE_IN_BACKGROUND'],
    ['ask', 'policy', 'full_access', null],
    ['allow', 'policy', 'workspace_write', null],
    ['allow', 'policy', 'read_only', null],
    ['allow', 'manual', 'workspace_write', 'APPROVAL_UNAVAILABLE_IN_BACKGROUND'],
    ['deny', 'policy', 'full_access', 'NETWORK_PERMISSION_DENIED'],
  ] as const)('applies %s network rules with %s / %s in unattended runs', async (access, approvalPolicy, executionProfile, expected) => {
    const f = fixture()
    const settings = structuredClone(DEFAULT_NETWORK_PERMISSIONS)
    settings.defaults.access = access
    const authorization = new ToolAuthorizationService({
      ...f.options,
      approvalPolicy,
      executionProfile,
      approvalAvailable: false,
      networkPermissions: { get: async () => settings, allow: async () => { throw new Error('Unattended permissions must not mutate') } },
    })
    const result = await authorization.authorize(f.call('bash', { command: 'curl https://example.com' }), f.run, { access: 'network' }, { network: { host: 'example.com', port: 443 } })
    expect(result).toBe(expected)
    expect(f.repository.list()).toEqual([])
  })

  it('saves only the requested network action and reuses it in a later unattended run', async () => {
    const f = fixture()
    let settings = structuredClone(DEFAULT_NETWORK_PERMISSIONS)
    const networkPermissions = {
      get: async () => settings,
      allow: async (host: string, operation: 'access' | 'download' | 'upload') => { settings = upsertNetworkPermission(settings, host, operation) },
    }
    const authorization = new ToolAuthorizationService({ ...f.options, networkPermissions })
    const target = { host: 'files.example.com', port: 443 }
    const pending = authorization.authorize(f.call('lexora_web_fetch', { url: 'https://files.example.com/report' }), f.run, { access: 'network' }, { network: target, networkOperation: 'download' })
    const review = await f.approve('approved_persistently')
    expect(review.payload).toMatchObject({ card: 'network-permission', host: target.host, operation: 'download', canPersist: true })
    expect(await pending).toBeNull()
    expect(settings.rules[0]).toMatchObject({ pattern: target.host, match: 'exact', access: 'ask', download: 'allow', upload: 'ask' })
    const background = new ToolAuthorizationService({ ...f.options, networkPermissions, approvalAvailable: false })
    const nextRun = { ...f.run, runId: 'later-run' }
    expect(await background.authorize(f.call('lexora_web_fetch', {}), nextRun, { access: 'network' }, { network: target, networkOperation: 'download' })).toBeNull()
    expect(await background.authorize(f.call('lexora_web_fetch', {}), nextRun, { access: 'network' }, { network: target, networkOperation: 'upload' })).toBe('APPROVAL_UNAVAILABLE_IN_BACKGROUND')
  })

  it('checks changed rules before reusing even a turn or same-call network permission', async () => {
    const f = fixture()
    let settings = structuredClone(DEFAULT_NETWORK_PERMISSIONS)
    const authorization = new ToolAuthorizationService({
      ...f.options,
      networkPermissions: { get: async () => settings, allow: async () => {} },
    })
    const call = f.call('bash', { command: 'curl https://example.com' })
    const resource = { network: { host: 'example.com', port: 443 } }
    const pending = authorization.authorize(call, f.run, { access: 'network' }, resource)
    await f.approve('approved_for_turn')
    expect(await pending).toBeNull()
    settings = upsertNetworkPermission(settings, 'example.com', 'access', 'deny')
    expect(await authorization.authorize(call, f.run, { access: 'network' }, resource)).toBe('NETWORK_PERMISSION_DENIED')
    expect(await authorization.authorize(f.call('bash', call.input), f.run, { access: 'network' }, resource)).toBe('NETWORK_PERMISSION_DENIED')
  })

  it.each([true, false])('revokes old turn grants when domain settings change, first request network=%s', async (networkFirst) => {
    const f = fixture()
    let settings = structuredClone(DEFAULT_NETWORK_PERMISSIONS)
    const authorization = new ToolAuthorizationService({ ...f.options, networkPermissions: { get: async () => settings, allow: async () => {} } })
    const resource = { network: { host: 'example.com', port: 443 } }
    const first = networkFirst
      ? authorization.authorize(f.call('bash', {}), f.run, { access: 'network' }, resource)
      : authorization.authorize(f.call('lexora_host_shell', { command: 'fixture' }), f.run, { access: 'execute' })
    await f.approve('approved_for_turn')
    expect(await first).toBeNull()
    settings = upsertNetworkPermission(settings, 'example.com', 'access', 'ask')
    const next = authorization.authorize(f.call('bash', {}), f.run, { access: 'network' }, resource)
    await f.approve('denied')
    expect(await next).toBe('APPROVAL_DENIED')
    expect(f.records.size).toBe(2)
  })

  it('rechecks allow changed to ask before releasing or caching the request', async () => {
    const f = fixture()
    let settings = upsertNetworkPermission(DEFAULT_NETWORK_PERMISSIONS, 'example.com', 'access', 'allow')
    let changed = false
    f.run.flushProjectedEvents = async () => {
      if (!changed) {
        changed = true
        settings = upsertNetworkPermission(settings, 'example.com', 'access', 'ask')
      }
    }
    const authorization = new ToolAuthorizationService({ ...f.options, networkPermissions: { get: async () => settings, allow: async () => {} } })
    const call = f.call('bash', {})
    const resource = { network: { host: 'example.com', port: 443 } }
    const pending = authorization.authorize(call, f.run, { access: 'network' }, resource)
    await f.approve('denied')
    expect(await pending).toBe('APPROVAL_DENIED')
    const retried = authorization.authorize(call, f.run, { access: 'network' }, resource)
    await f.approve('denied')
    expect(await retried).toBe('APPROVAL_DENIED')
  })

  it.each([false, true])('keeps successful directory persistence audited when cancellation races, audit retry=%s', async (failAudit) => {
    const f = fixture()
    const started = Promise.withResolvers<void>()
    const commit = Promise.withResolvers<void>()
    const authorization = new ToolAuthorizationService({
      ...f.options,
      applyGrant: async (grant) => {
        started.resolve()
        await commit.promise
        f.grants.push({ canonicalRoot: grant.root, root: grant.root, grantId: 'saved', kind: 'workspace' })
      },
    })
    const call = f.call('write', { path: join(outside, 'saved.txt'), content: 'fixture' })
    const pending = authorization.authorize(call, f.run)
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    if (failAudit)
      f.failNextResolution()
    const saving = f.approve('approved_persistently')
    const resolution = failAudit ? expect(saving).rejects.toThrow('Audit storage temporarily unavailable') : saving
    await started.promise
    f.controller.abort()
    commit.resolve()
    await resolution
    await cancelled
    await vi.waitFor(() => expect(f.repository.listPending()).toHaveLength(0))
    expect(f.repository.list()[0]).toMatchObject({ status: 'approved', resolution: 'approved_persistently' })
    expect(f.grants.filter(grant => grant.root === outside)).toHaveLength(1)
    expect(f.executionPermissions.get(f.run, call.toolCallId)).toEqual([])
    expect(f.events.filter(event => event.type === 'approval.resolved')).toHaveLength(1)
  })

  it('does not turn a one-time path approval into a saved directory', async () => {
    const f = fixture()
    const authorization = new ToolAuthorizationService({
      ...f.options,
      applyGrant: (grant) => { f.grants.push({ canonicalRoot: grant.root, root: grant.root, grantId: 'saved', kind: 'workspace' }) },
    })
    const path = join(outside, 'one-time.txt')
    const call = f.call('write', { path, content: 'fixture' })
    const pending = authorization.authorize(call, f.run)
    await f.approve('approved')
    expect(await pending).toBeNull()
    expect(f.grants.map(grant => grant.root)).toEqual([workspace])
    expect(f.executionPermissions.get(f.run, call.toolCallId)).toHaveLength(1)
    authorization.releaseExecutionPermit(call, f.run)
    expect(f.executionPermissions.get(f.run, call.toolCallId)).toEqual([])
  })

  it('keeps role tool and file access limits through permission updates', async () => {
    const f = fixture()
    const authorization = new ToolAuthorizationService({ ...f.options, fileAccessLimit: 'read_only' })
    authorization.updatePermissionSettings({ approvalPolicy: 'policy', executionProfile: 'full_access' })
    expect(await authorization.authorize(f.call('write', { path: join(workspace, 'result.txt'), content: 'blocked' }), f.run)).toBe('READ_ONLY_PROFILE')
    expect(await authorization.authorize(f.call('bash', { command: 'git diff --cached' }), f.run, { access: 'execute', shellBoundary: 'sandbox' })).toBeNull()
    expect(await authorization.authorize(f.call('bash', { command: 'git diff --cached' }), f.run, { access: 'execute' })).toBe('ROLE_FILE_ACCESS_READ_ONLY')
    expect(await authorization.authorize(f.call('lexora_unknown', {}), f.run)).toBe('ROLE_FILE_ACCESS_READ_ONLY')
    const scope = new SessionToolScope([], { mode: 'selected', ids: [JSON.stringify(['builtin', 'core', 'read'])] })
    const scoped = new ToolAuthorizationService({ ...f.options, executionProfile: 'full_access', getToolScopeDenial: name => scope.denial(name) })
    await expect(scoped.authorize(f.call('write', { path: join(workspace, 'result.txt'), content: 'outside scope' }), f.run, { access: 'read', paths: [] })).resolves.toBe('TOOL_OUTSIDE_ROLE_SCOPE')
    expect(f.events).toEqual([])
  })

  it('revokes temporary tool grants when the required persistent application fails', async () => {
    const f = fixture()
    const authorization = new ToolAuthorizationService({ ...f.options, applyGrant: () => {
      throw new Error('owner revoked')
    } })
    const path = join(outside, 'preview.html')
    await writeFile(path, '<!doctype html><title>Preview</title>')
    const event = f.call('lexora_browser_open', { entryPath: path })
    const pending = authorization.authorize(event, f.run, { access: 'render', paths: [{ path, mode: 'existing' }] })
    await expect(f.approve('approved_persistently')).rejects.toThrow('owner revoked')
    expect(f.repository.listPending()).toHaveLength(1)
    expect(f.executionPermissions.get(f.run, event.toolCallId)).toEqual([])
    await f.approve('denied')
    expect(await pending).toBe('APPROVAL_DENIED')
  })

  it('queues concurrent network requests, reuses the destination across commands, and clears at run end', async () => {
    const f = fixture()
    const command = new AbortController()
    const resource = { network: { host: 'registry.example.com', port: 443 }, signal: command.signal }
    const first = f.authorization.authorize(f.call('bash', { command: 'pnpm lint' }), f.run, { access: 'network', requireApproval: true }, resource)
    const second = f.authorization.authorize(f.call('bash', { command: 'pnpm test' }), f.run, { access: 'network', requireApproval: true }, { network: resource.network })
    const review = await f.approve('approved_for_source')
    expect(review.payload).toMatchObject({ card: 'network-permission', reuseScopes: ['operation', 'source', 'turn'] })
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

  it('rechecks pending writes after a permission change and revokes the old approval whether allowed or denied', async () => {
    for (const executionProfile of ['read_only', 'workspace_write'] as const) {
      const f = fixture()
      f.authorization.updatePermissionSettings({ approvalPolicy: 'manual', executionProfile: 'workspace_write' })
      const pending = f.authorization.authorize(f.call('write', { path: join(workspace, 'result.txt'), content: 'fixture' }), f.run)
      await vi.waitFor(() => expect(f.repository.listPending()).toHaveLength(1))
      const previous = f.repository.listPending()[0]!
      f.authorization.updatePermissionSettings({ approvalPolicy: 'policy', executionProfile })
      expect(await pending).toBe(executionProfile === 'read_only' ? 'READ_ONLY_PROFILE' : null)
      await vi.waitFor(() => expect(f.repository.findById(previous.id)?.status).toBe('cancelled'))
      expect(f.repository.listPending()).toHaveLength(0)
      await expect(f.approvals.resolve({ id: previous.id, decision: 'approved' })).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' })
    }
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

  it('rechecks a pending host command after full access is enabled and revokes the old approval', async () => {
    const f = fixture()
    const pending = f.authorization.authorize(f.call('lexora_host_shell', { command: 'node build.mjs' }), f.run, { access: 'execute' })
    await vi.waitFor(() => expect(f.repository.listPending()).toHaveLength(1))
    const previous = f.repository.listPending()[0]!
    expect(previous.payload).toMatchObject({ card: 'shell', context: { reason: 'sandbox-bypass' } })
    f.authorization.updatePermissionSettings({ approvalPolicy: 'policy', executionProfile: 'full_access' })
    await expect(pending).resolves.toBeNull()
    await vi.waitFor(() => expect(f.repository.findById(previous.id)?.status).toBe('cancelled'))
    await expect(f.approvals.resolve({ id: previous.id, decision: 'approved' })).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' })
    expect(f.repository.listPending()).toEqual([])
    expect(f.records.size).toBe(1)
    await f.approvals.dispose()
  })

  it.each(['turn', 'full_access', 'full_access_background'] as const)('applies %s to every tool category while preserving denials and validation', async (mode) => {
    const f = fixture()
    const authorization = mode === 'turn'
      ? f.authorization
      : new ToolAuthorizationService({
          ...f.options,
          executionProfile: 'full_access',
          approvalAvailable: mode !== 'full_access_background',
        })
    if (mode === 'turn') {
      const initial = authorization.authorize(f.call('lexora_web_fetch', { url: 'https://example.com' }), f.run, { access: 'network' })
      await f.approve('approved_for_turn')
      await initial
    }

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
      await expect(authorization.authorize(f.call(name, input), f.run, declared), name).resolves.toBeNull()

    expect(f.directories.get(f.run)).toMatchObject(mode === 'turn' ? [{ path: outside, access: 'write' }] : [])
    expect(f.records.size).toBe(mode === 'turn' ? 1 : 0)
    const readOnly = new ToolAuthorizationService({ ...f.options, executionProfile: 'read_only' })
    await expect(readOnly.authorize(f.call('write', { path: join(workspace, 'blocked.txt'), content: 'no' }), f.run)).resolves.toBe('READ_ONLY_PROFILE')
    const background = new ToolAuthorizationService({ ...f.options, approvalAvailable: false })
    await expect(background.authorize(f.call('lexora_host_shell', { command: 'node fixture.mjs' }), f.run)).resolves.toBe('APPROVAL_UNAVAILABLE_IN_BACKGROUND')
    const stale = authorization.authorize(f.call('lexora_browser_act', {}), f.run, { forceAsk: true, approval: { kind: 'browser', summary: 'Stale', browser }, validateBeforeExecution: async () => ({ blocked: true, reason: 'BROWSER_TARGET_STALE' }) })
    await expect(stale).resolves.toBe('BROWSER_TARGET_STALE')
    expect(f.records.size).toBe(mode === 'turn' ? 1 : 0)
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

  it('grants full-access sensitive targets only to the current execution and revokes them on release', async () => {
    const homes = vi.spyOn(userHomePaths, 'resolveUserHomePaths').mockReturnValue([root])
    try {
      const sensitive = join(root, '.ssh')
      await mkdir(sensitive)
      const output = join(sensitive, 'fixture.txt')
      const f = fixture()
      const authorization = new ToolAuthorizationService({ ...f.options, executionProfile: 'full_access', approvalAvailable: false })
      const event = f.call('lexora_image_generate', { outputPath: output })
      await expect(authorization.authorize(event, f.run, { access: 'write', paths: [{ path: output, mode: 'create' }] })).resolves.toBeNull()
      const executionGrants = [...f.grants, ...f.executionPermissions.get(f.run, event.toolCallId)]
      await expect(resolveGrantedPath(executionGrants, output, 'create')).resolves.toMatchObject({ canonicalPath: output })
      await expect(resolveGrantedPath(f.grants, output, 'create')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
      expect(f.executionPermissions.get(f.run, 'another-call')).toEqual([])
      expect(f.repository.list()).toEqual([])
      authorization.releaseExecutionPermit(event, f.run)
      expect(f.executionPermissions.get(f.run, event.toolCallId)).toEqual([])
      expect(authorization.getExecutionPermit(event, f.run)).toBeNull()
      authorization.updatePermissionSettings({ approvalPolicy: 'policy', executionProfile: 'workspace_write' })
      await expect(authorization.authorize(event, f.run, { access: 'write', paths: [{ path: output, mode: 'create' }] })).resolves.toBe('SENSITIVE_PATH')
      expect(f.executionPermissions.get(f.run, event.toolCallId)).toEqual([])
    }
    finally { homes.mockRestore() }
  })

  it('passes temporary grants to the approved execution only without changing saved grants', async () => {
    const f = fixture()
    const events: unknown[] = []
    f.executionPermissions.onDidChange(event => events.push(event))
    const output = join(outside, 'image.png')
    const event = f.call('lexora_image_generate', { outputPath: output })
    const pending = f.authorization.authorize(event, f.run, { access: 'write', paths: [{ path: output, mode: 'create' }] })
    await f.approve('approved_for_turn')
    await expect(pending).resolves.toBeNull()
    const snapshot = f.executionPermissions.get(f.run, event.toolCallId)
    const executionGrants = [...f.grants, ...snapshot]
    await expect(resolveGrantedPath(executionGrants, output, 'create')).resolves.toMatchObject({ canonicalPath: output })
    expect(f.grants).toHaveLength(1)
    await expect(resolveGrantedPath(f.grants, output, 'create')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
    expect(f.executionPermissions.get(f.run, 'another-call')).toEqual([])
    expect(f.executionPermissions.get({ ...f.run, runId: 'run-2' }, event.toolCallId)).toEqual([])
    f.controller.abort()
    expect(f.executionPermissions.get(f.run, event.toolCallId)).toEqual([])
    expect(events).toMatchObject([{ kind: 'granted', count: 1 }, { kind: 'cleared', count: 1 }])
    expect(JSON.stringify(events)).not.toContain(outside)
  })
})
