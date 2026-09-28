import type { ToolCallEvent, ToolCallEventResult } from '@earendil-works/pi-coding-agent'
import type { BuddyExecutionProfile } from '../../../../shared/permissions/executionProfile'
import type { SandboxDirectoryRequest } from '../../../../shared/permissions/shellSandbox'
import type { BuddyExtensionRunContext } from '../../agent/extensions/BuddyExtensionRunContext'
import type { ApprovalService } from '../../approvals/ApprovalService'
import type { GrantProposal } from '../../permissions/permissionContract'
import { mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createToolPolicyExtension } from '../../agent/extensions/toolPolicyExtension'
import { ApprovalCancelledError } from '../../approvals/ApprovalService'
import { PermissionEngine } from '../../permissions/PermissionEngine'
import { createSensitivePathMatcher } from '../../permissions/sensitivePaths'
import { ToolAuthorizationService } from '../../permissions/ToolAuthorizationService'
import { SandboxDirectoryPermissions, validateSandboxDirectory } from '../SandboxDirectoryPermissions'

describe('run-scoped shell directory permissions', () => {
  let root: string
  let workspace: string
  let outside: string
  let sensitive: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'buddy-directory-permissions-'))
    workspace = join(root, 'workspace')
    outside = join(root, 'outside')
    sensitive = join(root, '.ssh')
    await Promise.all([workspace, outside, sensitive].map(path => mkdir(path)))
  })

  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  function createHarness(options: {
    profile?: BuddyExecutionProfile
    approvalAvailable?: boolean
    approve?: () => Promise<'approved_once' | 'approved_for_turn' | 'denied'>
  } = {}) {
    const controller = new AbortController()
    const permissions = new SandboxDirectoryPermissions()
    const reviews: Parameters<ApprovalService['request']>[0][] = []
    const authorized: string[] = []
    const persisted: GrantProposal[] = []
    const run: BuddyExtensionRunContext = {
      runId: 'run-1',
      signal: controller.signal,
      flushProjectedEvents: async () => {},
      onToolExecutionAuthorized: async (event) => { authorized.push(event.toolCallId) },
    }
    let handler: ((event: ToolCallEvent) => Promise<ToolCallEventResult | void>) | undefined
    const extension = createToolPolicyExtension({
      authorization: new ToolAuthorizationService({
        applyGrant: (grant) => { persisted.push(grant) },
        applySandboxDirectory: (context, grant) => permissions.grant(context, grant),
        approvalAvailable: options.approvalAvailable ?? true,
        approvalPolicy: 'policy',
        approvalService: {
          request: async (request) => {
            reviews.push(request)
            return { approvalId: `approval-${reviews.length}`, decision: await options.approve?.() ?? 'approved_once' }
          },
        },
        cwd: workspace,
        engine: new PermissionEngine({ sensitive: createSensitivePathMatcher({ home: root, environment: {} }) }),
        executionProfile: options.profile ?? 'workspace_write',
        getGrants: () => [{ canonicalRoot: workspace, root: workspace, kind: 'workspace', grantId: 'workspace' }],
        owner: { kind: 'conversation', id: 'conversation' },
      }),
      classifyTool: () => ({ shellBoundary: 'sandbox' }),
      getRunContext: () => run,
    })
    extension.factory({
      on: (_name: string, callback: typeof handler) => { handler = callback },
    } as never)
    return {
      authorized,
      controller,
      permissions,
      persisted,
      reviews,
      run,
      invoke: (input: unknown = { path: outside, access: 'read', reason: 'Inspect the reference files' }) => handler!({
        input,
        toolCallId: `tool-${reviews.length + 1}`,
        toolName: 'lexora_authorize_directory',
      } as ToolCallEvent),
    }
  }

  it('isolates authorization snapshots, suppresses duplicate grants and releases state on disposal', async () => {
    const harness = createHarness()
    const events: unknown[] = []
    harness.permissions.onDidChange(event => events.push(event))
    const metadata = await stat(outside, { bigint: true })
    const input = { path: outside, access: 'read' as const, device: String(metadata.dev), inode: String(metadata.ino) }
    await harness.permissions.grant(harness.run, input)
    input.path = sensitive
    const snapshot = harness.permissions.get(harness.run)
    expect(Reflect.set(snapshot[0]!, 'access', 'write')).toBe(false)
    await harness.permissions.grant(harness.run, { ...snapshot[0]! })
    expect(events).toHaveLength(1)
    expect(snapshot[0]).toMatchObject({ path: outside, access: 'read' })
    harness.permissions.dispose()
    expect(harness.permissions.get(harness.run)).toEqual([])
    expect(events).toMatchObject([{ kind: 'granted', count: 1 }, { kind: 'cleared', count: 1 }])
    expect(JSON.stringify(events)).not.toContain(outside)
  })

  it('grants read access only to the reviewed directory and keeps saved grants unchanged', async () => {
    const harness = createHarness()
    await expect(harness.invoke()).resolves.toBeUndefined()
    expect(harness.reviews).toMatchObject([{
      kind: 'read',
      sandboxDirectory: { path: outside, access: 'read', reason: 'Inspect the reference files' },
    }])
    expect(harness.permissions.get(harness.run)).toEqual([{
      path: outside,
      access: 'read',
      device: expect.any(String),
      inode: expect.any(String),
    }])
    expect(harness.permissions.getWriteGrants(harness.run)).toEqual([])
    expect(harness.persisted).toEqual([])
    expect(harness.authorized).toEqual(['tool-1'])
  })

  it('requires a fresh approval to upgrade read access to write and captures only write grants', async () => {
    const harness = createHarness()
    await harness.invoke()
    await harness.invoke({ path: outside, access: 'write', reason: 'Update the requested output' } satisfies SandboxDirectoryRequest)
    expect(harness.reviews.map(review => review.kind)).toEqual(['read', 'write'])
    expect(harness.permissions.get(harness.run)).toMatchObject([{ path: outside, access: 'write' }])
    expect(harness.permissions.getWriteGrants(harness.run)).toMatchObject([{ canonicalRoot: outside, kind: 'granted' }])
    expect(harness.persisted).toEqual([])
  })

  it('allows an explicit read expansion in read-only mode but rejects a write expansion', async () => {
    const harness = createHarness({ profile: 'read_only' })
    await expect(harness.invoke()).resolves.toBeUndefined()
    await expect(harness.invoke({ path: outside, access: 'write', reason: 'Write output' })).resolves.toMatchObject({ block: true, reason: 'READ_ONLY_PROFILE' })
    expect(harness.permissions.get(harness.run)).toMatchObject([{ access: 'read' }])
    expect(harness.reviews).toHaveLength(1)
  })

  it('does not grant access when denied', async () => {
    const harness = createHarness({ approve: async () => 'denied' })
    await expect(harness.invoke()).resolves.toMatchObject({ block: true })
    expect(harness.permissions.get(harness.run)).toEqual([])
    expect(harness.authorized).toEqual([])
    expect(harness.persisted).toEqual([])
  })

  it('applies a turn approval to the reviewed directory without persisting it', async () => {
    const harness = createHarness({ approve: async () => 'approved_for_turn' })
    await expect(harness.invoke()).resolves.toBeUndefined()
    expect(harness.permissions.get(harness.run)).toMatchObject([{ path: outside, access: 'read' }])
    expect(harness.persisted).toEqual([])
  })

  it('rejects expansion without an interactive approval surface', async () => {
    const harness = createHarness({ approvalAvailable: false })
    await expect(harness.invoke()).resolves.toMatchObject({ block: true, reason: 'APPROVAL_UNAVAILABLE_IN_BACKGROUND' })
    expect(harness.permissions.get(harness.run)).toEqual([])
    expect(harness.reviews).toEqual([])
  })

  it('does not retain permissions after cancellation or share them with the next run or another session', async () => {
    const harness = createHarness()
    await harness.invoke()
    const nextRun = { ...harness.run, runId: 'run-2' }
    const anotherSession = { ...harness.run }
    expect(harness.permissions.get(nextRun)).toEqual([])
    expect(harness.permissions.get(anotherSession)).toEqual([])
    expect(new SandboxDirectoryPermissions().get(harness.run)).toEqual([])
    harness.controller.abort()
    expect(harness.permissions.get(harness.run)).toEqual([])
    expect(harness.permissions.getWriteGrants(harness.run)).toEqual([])
    expect(harness.permissions.get(null)).toEqual([])
  })

  it('keeps ChangeSet directory identity stable across separately authorized runs', async () => {
    const harness = createHarness()
    await harness.invoke({ path: outside, access: 'write', reason: 'Update requested files' })
    const nextRun = { ...harness.run, runId: 'run-2' }
    expect(harness.permissions.getWriteGrants(nextRun)).toEqual([])
    await harness.permissions.grant(nextRun, harness.permissions.get(harness.run)[0]!)
    expect(harness.permissions.getWriteGrants(nextRun)).toEqual(harness.permissions.getWriteGrants(harness.run))
  })

  it('does not grant when an approval is cancelled', async () => {
    const harness = createHarness({ approve: async () => {
      throw new ApprovalCancelledError()
    } })
    await expect(harness.invoke()).resolves.toMatchObject({ block: true, reason: 'APPROVAL_CANCELLED' })
    expect(harness.permissions.get(harness.run)).toEqual([])
    expect(harness.authorized).toEqual([])
  })

  it('does not apply an approval that arrives after the run was cancelled', async () => {
    const harness = createHarness({ approve: async () => {
      harness.controller.abort()
      return 'approved_once'
    } })
    await expect(harness.invoke()).resolves.toMatchObject({ block: true })
    expect(harness.permissions.get(harness.run)).toEqual([])
    expect(harness.authorized).toEqual([])
  })

  it('revalidates directory identity after approval and before subsequent execution', async () => {
    const harness = createHarness({
      approve: async () => {
        await rename(outside, `${outside}-original`)
        await mkdir(outside)
        return 'approved_once'
      },
    })
    await expect(harness.invoke()).resolves.toMatchObject({ block: true, reason: 'SANDBOX_DIRECTORY_CHANGED' })
    expect(harness.permissions.get(harness.run)).toEqual([])
    expect(harness.authorized).toEqual([])

    const metadata = await stat(outside, { bigint: true })
    const grant = { path: outside, access: 'read' as const, device: String(metadata.dev), inode: String(metadata.ino) }
    await validateSandboxDirectory(grant)
    await rename(outside, `${outside}-replacement`)
    await symlink(workspace, outside)
    await expect(validateSandboxDirectory(grant)).rejects.toMatchObject({ code: 'SANDBOX_DIRECTORY_CHANGED' })
  })

  it('rejects credentials, symbolic redirects, files and unrecognized request fields', async () => {
    const harness = createHarness()
    await writeFile(join(outside, 'file'), 'not a directory')
    await symlink(sensitive, join(workspace, 'alias'))
    for (const path of [sensitive, join(workspace, 'alias')])
      await expect(harness.invoke({ path, access: 'read', reason: 'Read files' })).resolves.toMatchObject({ block: true, reason: 'SENSITIVE_PATH' })
    await expect(harness.invoke({ path: join(outside, 'file'), access: 'read', reason: 'Read files' })).resolves.toMatchObject({ block: true, reason: 'INVALID_PATH' })
    await expect(harness.invoke({ path: outside, access: 'write', reason: 'Write files', scope: 'permanent' })).resolves.toMatchObject({ block: true, reason: 'VALIDATION_FAILED' })
    expect(harness.permissions.get(harness.run)).toEqual([])
    expect(harness.reviews).toEqual([])
  })
})
