import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { DatabaseSync } from 'node:sqlite'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PhotonImage } from '@silvia-odwyer/photon-node'
import { afterEach, expect, it } from 'vitest'
import { PermissionEngine } from '../../permissions/PermissionEngine'
import { createBuddyRepository } from '../../storage/buddyRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createBuddiesCapability } from '../buddiesExtension'
import { BuddiesService } from '../BuddiesService'

let root: string
let database: DatabaseSync
let service: BuddiesService
afterEach(async () => {
  service?.dispose()
  database?.close()
  if (root)
    await rm(root, { force: true, recursive: true })
})

async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'lexora-buddies-tools-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  database = openBuddyDatabase({ databasePath: ':memory:' })
  service = new BuddiesService(createBuddyRepository(database))
  const context = { conversationId: 'test', cwd: workspace, executionProfile: 'workspace_write' as const, grants: [{ kind: 'workspace' as const, root: workspace, canonicalRoot: workspace, grantId: 'test' }], getRunId: () => 'run', sessionMode: 'interactive' as const, signal: new AbortController().signal }
  const capability = createBuddiesCapability(context, service, () => 'default')
  const tools = new Map<string, ToolDefinition>()
  await capability.extension.factory({
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool)
    },
  } as never)
  return {
    workspace,
    initial: service.get('default'),
    context,
    capability,
    call: (name: string, input: unknown) => tools.get(`lexora_buddy_${name}`)!.execute('call', input as never, undefined, undefined, {} as never),
  }
}

it('edits through the registered tools, hides avatar bytes and preserves concurrent changes', async () => {
  const f = await fixture()
  const image = new PhotonImage(new Uint8Array(4 * 4 * 4).fill(255), 4, 4)
  try {
    await writeFile(join(f.workspace, 'avatar.png'), Buffer.from(image.get_bytes()))
  }
  finally {
    image.free()
  }
  const updated = await f.call('update', { buddyId: 'default', expectedRevision: f.initial.revision, name: '小海', avatarPath: 'avatar.png' })
  expect(updated.details).toEqual({ ok: true })
  expect(service.get('default')).toMatchObject({ name: '小海', revision: f.initial.revision + 1, avatar: expect.stringMatching(/^data:image\/png;base64,/) })
  const snapshot = await f.call('get', { buddyId: 'default' })
  expect(JSON.stringify(snapshot)).toContain('hasCustomAvatar')
  expect(JSON.stringify(snapshot)).not.toContain('base64')
  const stale = await f.call('update', { buddyId: 'default', expectedRevision: f.initial.revision, name: 'Old draft' })
  expect(stale.details).toMatchObject({ ok: false, code: 'BUDDY_CONFLICT' })
  expect(service.get('default').name).toBe('小海')
  await f.call('update', { buddyId: 'default', expectedRevision: f.initial.revision + 1, avatarPath: null })
  expect(service.get('default')).toMatchObject({ avatar: null, name: '小海' })
})

it('keeps mutations behind write permission and rejects avatar symlinks outside grants', async () => {
  const f = await fixture()
  const input = { buddyId: 'default', expectedRevision: f.initial.revision, name: 'Denied' }
  const classification = await f.capability.classify({ type: 'tool_call', toolCallId: 'call', toolName: 'lexora_buddy_update', input } as never, f.context.signal)
  if (!classification || 'blocked' in classification)
    throw new Error('Expected a classified profile mutation')
  const decision = await new PermissionEngine().decide({ ...classification, approvalPolicy: 'policy', approvalAvailable: true, arguments: input, cwd: f.workspace, grants: f.context.grants, owner: { kind: 'conversation', id: 'test' }, profile: 'read_only', toolName: 'lexora_buddy_update' })
  expect(decision).toMatchObject({ type: 'deny', code: 'READ_ONLY_PROFILE' })
  const request = { ...classification, approvalPolicy: 'policy' as const, approvalAvailable: true, arguments: input, cwd: f.workspace, grants: f.context.grants, owner: { kind: 'conversation' as const, id: 'test' }, profile: 'workspace_write' as const, toolName: 'lexora_buddy_update' }
  await expect(new PermissionEngine().decide(request)).resolves.toEqual({ type: 'allow' })
  await expect(new PermissionEngine().decide({ ...request, approvalPolicy: 'manual' })).resolves.toMatchObject({ type: 'ask' })
  await expect(new PermissionEngine().decide({ ...request, toolName: 'write' })).resolves.toMatchObject({ type: 'deny', code: 'VALIDATION_FAILED' })
  const outside = join(root, 'outside.png')
  await writeFile(outside, 'private content')
  await symlink(outside, join(f.workspace, 'linked.png'))
  const result = await f.call('update', { buddyId: 'default', expectedRevision: f.initial.revision, name: 'Denied', avatarPath: 'linked.png' })
  expect(result.details).toMatchObject({ ok: false, code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
  expect(service.get('default')).toMatchObject({ name: 'Lexora', avatar: null, revision: f.initial.revision })
})

it('supports the companion lifecycle through tools without exposing avatar payloads', async () => {
  const f = await fixture()
  const result = await f.call('create', { name: 'Reviewer', description: 'Checks changes' })
  expect(result.details).toEqual({ ok: true })
  const created = service.list().buddies.find(buddy => buddy.name === 'Reviewer' && buddy.kind === 'actor')!
  expect(created).toMatchObject({ name: 'Reviewer', description: 'Checks changes' })
  const list = await f.call('list', {})
  expect(JSON.stringify(list)).toContain('defaultBuddyId')
  expect(JSON.parse(list.content.filter(part => part.type === 'text').map(part => part.text).join('')).currentBuddyId).toBe('default')
  expect((await f.call('set_default', { buddyId: created.id, expectedCatalogRevision: service.list().revision })).details).toEqual({ ok: true })
  const current = await f.call('list', {})
  expect(JSON.parse(current.content.filter(part => part.type === 'text').map(part => part.text).join(''))).toMatchObject({ defaultBuddyId: created.id, currentBuddyId: 'default' })
  expect((await f.call('delete', { buddyId: created.id, expectedRevision: 1 })).details).toMatchObject({ code: 'BUDDY_DEFAULT_PROTECTED' })
  expect((await f.call('reset_profile', { buddyId: created.id, expectedRevision: 1 })).details).toMatchObject({ code: 'BUDDY_RESET_UNAVAILABLE' })
  await f.call('set_default', { buddyId: 'default', expectedCatalogRevision: service.list().revision })
  expect((await f.call('delete', { buddyId: created.id, expectedRevision: 1 })).details).toEqual({ ok: true })
  expect((await f.call('get', { buddyId: created.id })).details).toEqual({ ok: true })
  expect(service.get(created.id).deletedAt).not.toBeNull()
  for (const [name, input] of [
    ['create', { name: 'New' }],
    ['delete', { buddyId: created.id, expectedRevision: 1 }],
    ['reset_profile', { buddyId: 'default', expectedRevision: f.initial.revision }],
    ['set_default', { buddyId: created.id, expectedCatalogRevision: 1 }],
  ] as const) {
    const toolName = `lexora_buddy_${name}`
    const classification = await f.capability.classify({ type: 'tool_call', toolCallId: 'call', toolName, input } as never, f.context.signal)
    if (!classification || 'blocked' in classification)
      throw new Error('Expected a classified profile mutation')
    await expect(new PermissionEngine().decide({ ...classification, approvalPolicy: 'policy', approvalAvailable: true, arguments: input, cwd: f.workspace, grants: f.context.grants, owner: { kind: 'conversation', id: 'test' }, profile: 'read_only', toolName })).resolves.toMatchObject({ type: 'deny', code: 'READ_ONLY_PROFILE' })
  }
})
