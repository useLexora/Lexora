import type { BuddyPermissionSettings } from '../../../../../shared/permissions/permissionMode'
import type { BuddyExtensionRunContext } from '../../extensions/BuddyExtensionRunContext'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buddySettingsSchema } from '../../../../../shared/buddies/buddySettings'
import { BuddyDefinitionResolver } from '../../../buddies/BuddyDefinitionResolver'
import { createExecutionStorageFixture } from '../../../storage/__tests__/executionFixture'
import { createConversationMemberRepository } from '../../../storage/conversationMemberRepository'
import { createMailboxRepository } from '../../../storage/mailboxRepository'
import { getPiShellToolName } from '../../extensions/piBuiltinTools'
import { ExecutionDelegationService } from '../ExecutionDelegationService'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()))

function fixture() {
  const f = createExecutionStorageFixture()
  cleanups.push(() => f.database.close())
  const members = createConversationMemberRepository(f.database)
  const definitions = new BuddyDefinitionResolver({ buddies: f.buddies, members, providers: { getDefaultModel: async () => null, executionModels: { resolveAvailable: async () => {
    throw new Error('Preflight must follow durable admission')
  }, getServiceTiers: () => [] } } })
  const readResult = vi.fn(async () => 'Completed report')
  const send = vi.fn()
  const service = new ExecutionDelegationService({
    readResult,
    readToolOptions: async () => ['read', 'write', getPiShellToolName(process.platform)].map(name => ({ name, id: JSON.stringify(['builtin', 'core', name]), title: name, source: { kind: 'builtin', id: 'core', title: 'Core' } })),
    buddies: f.buddies,
    members,
    definitions,
    executions: f.executions,
    mailbox: createMailboxRepository(f.database),
    coordinator: {
      assertShellExecutionAllowed: () => {},
      admitChild: async input => f.executions.admitChild(input).execution,
      send,
      wait: vi.fn(),
      answerQuestion: vi.fn(),
      cancel: async () => false,
    },
    stopExecution: async () => false,
  })
  const controller = new AbortController()
  const run: BuddyExtensionRunContext = { runId: 'root', signal: controller.signal, requestModel: { providerId: 'current-provider', modelId: 'M1', reasoning: 'high', serviceTier: null }, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {} }
  let permissions: BuddyPermissionSettings = { approvalPolicy: 'policy', executionProfile: 'workspace_write' }
  const caller = { run, getPermissions: () => permissions }
  return { ...f, caller, controller, service, send, readResult, setPermissions: (value: BuddyPermissionSettings) => {
    permissions = value
  } }
}

describe('execution delegation boundary', () => {
  it('revokes and restores NPC targets for an already accepted caller without removing actor partners or bindings', async () => {
    const f = fixture()
    const before = f.buddies.get('default').settings
    const setEnabled = (npcTeamEnabled: boolean) => {
      const actor = f.buddies.get('default')
      f.buddies.update({ buddyId: actor.id, expectedRevision: actor.revision, settings: buddySettingsSchema.parse({ ...actor.settings, npcTeamEnabled }) })
    }
    setEnabled(false)
    await expect(f.service.execute(f.caller, 'off-list', { operation: 'list' }, f.controller.signal)).resolves.toMatchObject({ actors: [{ id: f.actor.id }], npcs: [] })
    await expect(f.service.execute(f.caller, 'off-delegate', { operation: 'delegate', targetId: f.npc.id, text: 'Inspect' }, f.controller.signal)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(f.executions.listTree('root')).toHaveLength(1)
    expect(f.buddies.get('default').settings).toEqual({ ...before, npcTeamEnabled: false })
    setEnabled(true)
    await expect(f.service.execute(f.caller, 'on-list', { operation: 'list' }, f.controller.signal)).resolves.toMatchObject({ npcs: [{ id: f.npc.id }] })
    const accepted = await f.service.execute(f.caller, 'on-delegate', { operation: 'delegate', targetId: f.npc.id, text: 'Inspect' }, f.controller.signal) as { runId: string }
    setEnabled(false)
    expect(f.executions.find(accepted.runId)?.phase).toBe('queued')
    expect(f.buddies.get('default').settings.npcIds).toEqual(before.npcIds)
  })

  it('routes child progress only to its caller and preserves separate inspection permissions', async () => {
    const f = fixture()
    f.executions.admitChild(f.child('child'))
    f.executions.claimWorking(f.fence('child'))
    const child = { ...f.caller, run: { ...f.caller.run, runId: 'child' } }
    const report = { operation: 'report', text: 'Validated the first boundary; continuing the task' }
    await expect(f.service.execute(child, 'progress', report, f.controller.signal)).resolves.toEqual({ runId: 'root', status: 'queued' })
    expect(f.send.mock.calls[0]).toEqual(['child', expect.objectContaining({ kind: 'supplement', purpose: 'progress', targetRunId: 'root', text: report.text })])
    await expect(f.service.execute(child, 'legacy', { operation: 'send', runId: 'root', text: 'More progress' }, f.controller.signal)).resolves.toMatchObject({ status: 'queued' })
    await expect(f.service.execute(child, 'inspect-parent', { operation: 'status', runId: 'root' }, f.controller.signal)).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(f.service.execute(child, 'override', { ...report, runId: 'root' }, f.controller.signal)).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(f.service.execute(f.caller, 'root-report', report, f.controller.signal)).rejects.toMatchObject({ code: 'unauthorized' })
    f.executions.admitChild(f.child('sibling'))
    await expect(f.service.execute(child, 'sibling', { operation: 'send', runId: 'sibling', text: 'Forbidden' }, f.controller.signal)).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('reads completed reports in pages without reopening the child or reading siblings', async () => {
    const f = fixture()
    f.executions.admitChild(f.child('child'))
    await expect(f.service.execute(f.caller, 'pending-result', { operation: 'result', runId: 'child' }, f.controller.signal)).resolves.toMatchObject({ result: null })
    expect(f.readResult).not.toHaveBeenCalled()
    f.executions.beginClosing(f.fence('child'), 'failure')
    f.executions.finishClosing(f.fence('child'), 'failed', '2026-10-12T00:01:00.000Z', 'MODEL_UNAVAILABLE')
    f.readResult.mockResolvedValue('A'.repeat(32000).concat('Complete remaining findings'))
    const first = await f.service.execute(f.caller, 'result', { operation: 'result', runId: 'child' }, f.controller.signal)
    expect(first).toMatchObject({ status: 'failed', result: 'A'.repeat(32000), nextOffset: 32000 })
    await expect(f.service.execute(f.caller, 'remaining', { operation: 'result', runId: 'child', offset: 32000 }, f.controller.signal)).resolves.toMatchObject({ result: 'Complete remaining findings', nextOffset: null })
    expect(f.executions.find('child')?.phase).toBe('closed')
    expect(f.send).not.toHaveBeenCalled()
  })
  it('accepts an isolated child before capability preflight and captures the actual request model', async () => {
    const f = fixture()
    const request = { operation: 'delegate', targetId: f.npc.id, text: 'Inspect only the named file' }
    const first = await f.service.execute(f.caller, 'first-call', request, f.controller.signal) as { runId: string }
    const original = f.executions.find(first.runId)!
    expect(original).toMatchObject({ phase: 'queued', run: { parentRunId: 'root', model: 'M1', provider: 'current-provider', actorSnapshot: { modelSource: 'caller', model: { reasoning: 'high' } } }, initialInput: { prompt: request.text, attachmentIds: [], contextItems: [] } })
    const duplicate = await f.service.execute(f.caller, 'first-call', request, f.controller.signal)
    expect(duplicate).toMatchObject({ runId: first.runId })
    f.caller.run.requestModel = { providerId: 'next-provider', modelId: 'M2', reasoning: 'medium', serviceTier: 'priority' }
    const second = await f.service.execute(f.caller, 'second-call', request, f.controller.signal) as { runId: string }
    expect(f.executions.find(second.runId)?.run.actorSnapshot?.model).toEqual(f.caller.run.requestModel)
    expect(f.executions.find(first.runId)?.run.model).toBe('M1')
    expect(f.executions.find(second.runId)?.run.threadId).not.toBe(original.run.threadId)
    expect(f.database.prepare('SELECT count(*) AS count FROM messages').get()?.count).toBe(0)
  })

  it('uses current caller authorization while enforcing inherited file limits', async () => {
    const f = fixture()
    f.executions.setFileAccessCeiling('root')
    f.setPermissions({ approvalPolicy: 'manual', executionProfile: 'full_access' })
    const result = await f.service.execute(f.caller, 'readonly', { operation: 'delegate', targetId: f.npc.id, text: 'Inspect' }, f.controller.signal) as { runId: string }
    expect(f.executions.find(result.runId)).toMatchObject({ fileAccessCeiling: 'read_only', run: { executionProfile: 'read_only', approvalPolicy: 'manual' } })
  })

  it('describes selected tools and inherited read-only sandbox access without granting missing tools', async () => {
    const f = fixture()
    const shell = getPiShellToolName(process.platform)
    const missing = JSON.stringify(['plugin', 'removed', 'missing'])
    const npc = f.buddies.get(f.npc.id)
    f.buddies.update({ buddyId: npc.id, expectedRevision: npc.revision, settings: { ...buddySettingsSchema.parse(npc.settings), tools: { mode: 'selected', ids: ['read', 'write', shell].map(name => JSON.stringify(['builtin', 'core', name])).concat(missing) } } })
    f.executions.setFileAccessCeiling('root')
    f.setPermissions({ approvalPolicy: 'policy', executionProfile: 'full_access' })
    const catalog = await f.service.execute(f.caller, 'catalog', { operation: 'list' }, f.controller.signal)
    expect(catalog).toMatchObject({ npcs: [{
      id: npc.id,
      tools: process.platform === 'darwin' ? ['read'] : ['read', shell],
      unavailableToolIds: [missing],
      executionProfile: 'read_only',
      shell: process.platform === 'darwin' ? null : { tool: shell, boundary: 'sandbox', readOnly: true },
    }] })
  })

  it('rejects unbound targets, NPC spawning, and unrelated execution inspection', async () => {
    const f = fixture()
    const foreign = f.buddies.create({ name: 'Unbound', kind: 'npc' })
    await expect(f.service.execute(f.caller, 'unbound', { operation: 'delegate', targetId: foreign.id, text: 'Inspect' }, f.controller.signal)).rejects.toMatchObject({ code: 'unauthorized' })
    const result = await f.service.execute(f.caller, 'first', { operation: 'delegate', targetId: f.npc.id, text: 'Inspect' }, f.controller.signal) as { runId: string }
    const child = f.executions.find(result.runId)!
    f.executions.claimWorking({ runId: child.run.id, generation: 0, phaseVersion: child.phaseVersion, rootGeneration: 0 })
    const npcCaller = { ...f.caller, run: { ...f.caller.run, runId: child.run.id } }
    await expect(f.service.execute(npcCaller, 'nested', { operation: 'delegate', targetId: f.npc.id, text: 'Inspect' }, f.controller.signal)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(() => f.service.status(child.run.id, 'root')).toThrow()
  })
})
