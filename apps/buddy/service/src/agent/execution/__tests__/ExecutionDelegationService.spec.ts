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
  const service = new ExecutionDelegationService({
    readToolOptions: async () => ['read', 'write', getPiShellToolName(process.platform)].map(name => ({ name, id: JSON.stringify(['builtin', 'core', name]), title: name, source: { kind: 'builtin', id: 'core', title: 'Core' } })),
    buddies: f.buddies,
    members,
    definitions,
    executions: f.executions,
    mailbox: createMailboxRepository(f.database),
    coordinator: {
      assertShellExecutionAllowed: () => {},
      admitChild: async input => f.executions.admitChild(input).execution,
      send: vi.fn(),
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
  return { ...f, caller, controller, service, setPermissions: (value: BuddyPermissionSettings) => {
    permissions = value
  } }
}

describe('execution delegation boundary', () => {
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
