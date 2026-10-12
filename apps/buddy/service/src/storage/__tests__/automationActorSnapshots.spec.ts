import type { Api, Model } from '@earendil-works/pi-ai'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buddySettingsSchema } from '../../../../shared/buddies/buddySettings'
import { ApprovalService } from '../../approvals/ApprovalService'
import { AgentTaskAutomationAction } from '../../automations/AgentTaskAutomationAction'
import { AutomationService } from '../../automations/AutomationService'
import { resolveAutomationModelSelection } from '../../automations/resolveAutomationModelSelection'
import { createRunEventLog } from '../../events/createRunEventLog'
import { createApprovalRepository } from '../approvalRepository'
import { createAutomationRepositories } from '../automationRepository'
import { createAutomationTurnRepository } from '../automationTurnRepository'
import { createBuddyRepository } from '../buddyRepository'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'
import { createRunRepository } from '../runRepository'
import { BUDDY_SCHEMA_MIGRATIONS } from '../schema'
import { openMigrationFixtureDatabase } from './migrationFixture'

const databases: ReturnType<typeof openBuddyDatabase>[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))
const now = '2026-08-24T00:00:00.000Z'
const roleModel = { modelId: 'role-model', providerId: 'provider', reasoning: 'high' as const, serviceTier: null }
function fixture(actorId: string | null = null) {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  let next = 0
  const service = new AutomationService({ clock: { now: () => Temporal.Instant.from(now) }, createId: () => `automation-${++next}`, repositories: createAutomationRepositories(database) })
  const buddies = createBuddyRepository(database)
  const automation = service.create({ requestId: 'create', draft: {
    actorId,
    executionProfile: 'full_access',
    model: { mode: 'default' },
    name: 'Scheduled work',
    spaceId: null,
    prompt: 'Inspect files',
    timing: { activeFrom: null, activeUntil: null, schedule: { cadence: 'daily', kind: 'calendar', localTime: '09:30' }, timezone: 'UTC' },
  } })
  const queue = (requestId: string) => service.runNow({ automationId: automation.id, expectedRevision: automation.revision, requestId }).occurrence
  const claim = (at = now, owner = 'scheduler') => service.leaseQueued({ leaseExpiresAt: Temporal.Instant.from(at).add({ minutes: 3 }).toString({ fractionalSecondDigits: 3 }), now: at, owner, limit: 10 })
  const bind = (occurrenceId: string, owner = 'scheduler') => createAutomationTurnRepository(database).bind({
    occurrenceId,
    leaseOwner: owner,
    boundAt: '2026-08-24T00:00:10.000Z',
    branchId: 'branch',
    conversationId: 'conversation',
    messageId: 'message',
    runId: 'run',
    contextWindow: 100_000,
    maxTokens: 10_000,
    model: roleModel.modelId,
    provider: roleModel.providerId,
    reasoning: roleModel.reasoning,
    executionContext: null,
    spaceId: null,
  })
  return { database, service, buddies, automation, queue, claim, bind }
}

describe('automation actor claim snapshots', () => {
  it('binds the captured actor and model after asynchronous model preparation races later edits', async () => {
    const f = fixture()
    const actor = f.buddies.get('default')
    f.buddies.update({ buddyId: actor.id, expectedRevision: actor.revision, settings: { ...buddySettingsSchema.parse(actor.settings), instructions: 'Captured instruction', model: roleModel } })
    f.queue('race')
    const occurrence = f.claim()[0]!
    const entered = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    const runs = createRunRepository(f.database)
    let id = 0
    const action = new AgentTaskAutomationAction({
      automationService: f.service,
      clock: { now: () => Temporal.Instant.from('2026-08-24T00:00:10.000Z') },
      createId: () => `turn-${++id}`,
      resolveSpace: () => null,
      turns: createAutomationTurnRepository(f.database),
      resolveModel: (target, actorModel) => resolveAutomationModelSelection({
        defaults: { getDefaultModel: async () => null },
        models: { getServiceTiers: () => [], resolveAvailable: async (input) => {
          entered.resolve()
          await ready.promise
          return { id: input.modelId, provider: input.providerId, api: 'openai-responses', baseUrl: 'https://example.test', contextWindow: 100_000, maxTokens: 10_000, reasoning: true, name: 'Fixture', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<Api>
        } },
      }, target, actorModel),
      launchTurn: async (runId) => {
        const run = runs.findById(runId)!
        expect(run.actorSnapshot).toMatchObject({ id: actor.id, settings: { instructions: 'Captured instruction' }, model: roleModel, modelSource: 'definition' })
        runs.reconcileTerminal(runId, 'completed', now, null)
        return { runId, completion: Promise.resolve(runs.findById(runId)!) }
      },
    })
    const execution = action.execute(occurrence as typeof occurrence & { leaseOwner: string })
    await entered.promise
    const current = f.buddies.get(actor.id)
    f.buddies.update({ buddyId: current.id, expectedRevision: current.revision, settings: { ...buddySettingsSchema.parse(current.settings), instructions: 'Changed during preparation', model: null } })
    const replacement = f.buddies.create({ name: 'New default' })
    f.buddies.setDefault({ buddyId: replacement.id, expectedCatalogRevision: f.buddies.state().revision })
    ready.resolve()
    await execution
    expect(f.service.getOccurrence(occurrence.id)?.status).toBe('bound')
  })

  it('upgrades queued v25 occurrences without changing their definition or scheduled payload, then captures a role on their first claim', () => {
    const f = fixture()
    const occurrence = f.queue('legacy')
    const directory = mkdtempSync(join(tmpdir(), 'lexora-automation-actors-'))
    const path = join(directory, 'buddy.sqlite3')
    const legacy = openMigrationFixtureDatabase(path)
    try {
      legacy.exec('PRAGMA foreign_keys = OFF')
      for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(value => value.version <= 25))
        legacy.exec(migration.sql)
      for (const table of ['automations', 'automation_occurrences']) {
        const row = f.database.prepare(`SELECT * FROM ${table}`).get()!
        delete row.actor_id
        delete row.actor_snapshot_json
        if (typeof row.execution_snapshot_json === 'string') {
          const snapshot = JSON.parse(row.execution_snapshot_json)
          delete snapshot.actorId
          row.execution_snapshot_json = JSON.stringify(snapshot)
        }
        const columns = Object.keys(row)
        legacy.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]!))
      }
      legacy.exec('PRAGMA user_version = 25')
    }
    finally {
      legacy.close()
    }
    const upgraded = openBuddyDatabase({ databasePath: path })
    try {
      expect(upgraded.prepare('SELECT actor_id, prompt FROM automations').get()).toEqual({ actor_id: null, prompt: 'Inspect files' })
      expect(upgraded.prepare('SELECT actor_snapshot_json, status, id FROM automation_occurrences').get()).toEqual({ actor_snapshot_json: null, status: 'queued', id: occurrence.id })
      const service = new AutomationService({ repositories: createAutomationRepositories(upgraded) })
      expect(service.leaseQueued({ now, leaseExpiresAt: '2026-08-24T00:01:00.000Z', owner: 'upgrade', limit: 1 })[0]?.actorSnapshot?.id).toBe('default')
      expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    }
    finally {
      upgraded.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps the first claimed actor, configuration and read-only ceiling through re-lease and binding, while the next occurrence follows the new default', () => {
    const f = fixture()
    let actor = f.buddies.create({ name: 'Inspector' })
    actor = f.buddies.update({ buddyId: actor.id, expectedRevision: actor.revision, settings: { ...buddySettingsSchema.parse(actor.settings), instructions: 'First claimed instructions', model: roleModel, limits: { fileAccess: 'read_only' } } })
    f.buddies.setDefault({ buddyId: actor.id, expectedCatalogRevision: f.buddies.state().revision })
    const queued = f.queue('first')
    const claimed = f.claim()[0]!
    expect(claimed.actorSnapshot).toMatchObject({ id: actor.id, revision: actor.revision, settings: { instructions: 'First claimed instructions', model: roleModel } })
    f.buddies.update({ buddyId: actor.id, expectedRevision: actor.revision, settings: { ...buddySettingsSchema.parse(actor.settings), instructions: 'Changed later', model: null, limits: { fileAccess: 'inherit' } } })
    const replacement = f.buddies.create({ name: 'Replacement' })
    f.buddies.setDefault({ buddyId: replacement.id, expectedCatalogRevision: f.buddies.state().revision })
    const reclaimed = f.claim('2026-08-24T00:03:01.000Z', 'replacement-scheduler')[0]!
    expect(reclaimed.actorSnapshot).toEqual(claimed.actorSnapshot)
    const bound = createAutomationTurnRepository(f.database).bind({
      occurrenceId: queued.id,
      leaseOwner: 'replacement-scheduler',
      boundAt: '2026-08-24T00:03:01.000Z',
      branchId: 'branch',
      conversationId: 'conversation',
      messageId: 'message',
      runId: 'run',
      contextWindow: 100_000,
      maxTokens: 10_000,
      model: roleModel.modelId,
      provider: roleModel.providerId,
      reasoning: roleModel.reasoning,
      executionContext: null,
      spaceId: null,
    })
    expect(bound.kind).toBe('bound')
    if (bound.kind !== 'bound')
      throw new Error('Expected bound occurrence')
    expect(bound.conversation.buddyId).toBe(actor.id)
    expect(bound.run).toMatchObject({ buddyId: actor.id, executionProfile: 'read_only', actorSnapshot: { ...claimed.actorSnapshot, model: roleModel, modelSource: 'definition' } })
    f.database.prepare('UPDATE runs SET status = \'completed\' WHERE id = ?').run(bound.run.id)
    f.queue('second')
    expect(f.claim()[0]!.actorSnapshot?.id).toBe(replacement.id)
    expect(f.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('captures edited role settings on the next occurrence without borrowing an interactive turn authorization', async () => {
    const f = fixture()
    const actor = f.buddies.get('default')
    const settings = buddySettingsSchema.parse(actor.settings)
    const initial = f.queue('initial')
    const first = f.claim()[0]!
    f.bind(initial.id)
    const runs = createRunRepository(f.database)
    runs.reconcileTerminal('run', 'completed', now, null)
    createConversationRepository(f.database).create({ id: 'interactive-conversation', branchId: 'interactive-branch', createdAt: now, title: 'Interactive authorization', spaceId: null, approvalPolicy: 'policy', executionProfile: 'full_access' })
    runs.create({ id: 'interactive-run', actorSnapshot: null, branchId: 'interactive-branch', conversationId: 'interactive-conversation', triggeringMessageId: 'interactive-goal', provider: 'provider', model: 'model', purpose: 'chat', status: 'running', piSessionFile: null, startedAt: now, approvalPolicy: 'policy', executionProfile: 'full_access' })
    const directory = mkdtempSync(join(tmpdir(), 'lexora-automation-approval-'))
    const events = createRunEventLog({ database: f.database, conversationsDirectory: directory })
    const repository = createApprovalRepository(f.database)
    const approvals = new ApprovalService({ eventLog: events, repository })
    const request = { reuseScopes: ['operation', 'source', 'turn'] as const, arguments: { command: 'python process.py' }, kind: 'shell' as const, signal: new AbortController().signal, summary: 'Execute an authorized operation', toolName: 'bash' }
    try {
      const interaction = approvals.request({ ...request, runId: 'interactive-run', toolCallId: 'interactive-call' })
      await vi.waitFor(() => expect(repository.listPending('interactive-run')).toHaveLength(1))
      await approvals.resolve({ id: repository.listPending('interactive-run')[0]!.id, decision: 'approved_for_turn' })
      expect(await interaction).toMatchObject({ decision: 'approved_for_turn' })
      expect(await approvals.request({ ...request, runId: 'interactive-run', toolCallId: 'interactive-again' })).toMatchObject({ decision: 'approved_by_turn' })
      f.buddies.update({ buddyId: actor.id, expectedRevision: actor.revision, settings: { ...settings, instructions: 'NEXT_OCCURRENCE_INSTRUCTIONS', model: roleModel, tools: { mode: 'none' }, npcConcurrency: { mode: 'unlimited' } } })
      const next = f.queue('next')
      const claimed = f.claim()[0]!
      expect(claimed.actorSnapshot).toMatchObject({ id: actor.id, revision: actor.revision + 1, settings: { instructions: 'NEXT_OCCURRENCE_INSTRUCTIONS', model: roleModel, tools: { mode: 'none' }, npcConcurrency: { mode: 'unlimited' } } })
      expect(first.actorSnapshot?.settings.instructions).not.toBe('NEXT_OCCURRENCE_INSTRUCTIONS')
      const bound = createAutomationTurnRepository(f.database).bind({ occurrenceId: next.id, leaseOwner: 'scheduler', boundAt: now, branchId: 'next-branch', conversationId: 'next-conversation', messageId: 'next-message', runId: 'next-run', contextWindow: 100_000, maxTokens: 10_000, model: roleModel.modelId, provider: roleModel.providerId, reasoning: roleModel.reasoning, executionContext: null, spaceId: null })
      expect(bound.kind).toBe('bound')
      expect(runs.findById('next-run')).toMatchObject({ purpose: 'automation', approvalPolicy: 'policy', actorSnapshot: { settings: { instructions: 'NEXT_OCCURRENCE_INSTRUCTIONS' } } })
      const background = approvals.request({ ...request, runId: 'next-run', toolCallId: 'automation-call' })
      await vi.waitFor(() => expect(repository.listPending('next-run')).toHaveLength(1))
      expect(repository.list({ runId: 'next-run' })).toHaveLength(1)
      await approvals.resolve({ id: repository.listPending('next-run')[0]!.id, decision: 'denied' })
      expect(await background).toMatchObject({ decision: 'denied' })
      expect((await events.read('next-run')).some(event => event.type === 'approval.reused')).toBe(false)
    }
    finally {
      await approvals.dispose()
      await events.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['missing', 'npc-explorer'])('skips an unavailable or non-actor target %s without falling back to the application default', (actorId) => {
    const f = fixture(actorId)
    const queued = f.queue('invalid')
    expect(f.claim()).toEqual([])
    expect(f.service.getOccurrence(queued.id)).toMatchObject({ status: 'skipped', errorCode: 'AUTOMATION_ACTOR_UNAVAILABLE', actorSnapshot: null, leaseOwner: null })
    expect(f.database.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 0 })
  })

  it('keeps an explicit actor despite default changes and skips binding if that actor has been disabled', () => {
    const f = fixture()
    const actor = f.buddies.create({ name: 'Explicit actor' })
    const updated = f.service.update({ automationId: f.automation.id, expectedRevision: f.automation.revision, requestId: 'update', draft: { actorId: actor.id, executionProfile: f.automation.executionProfile, model: f.automation.model, name: f.automation.name, prompt: f.automation.prompt, spaceId: f.automation.spaceId, timing: f.automation.timing } })
    const queued = f.service.runNow({ automationId: updated.id, expectedRevision: updated.revision, requestId: 'explicit' }).occurrence
    expect(f.claim()[0]!.actorSnapshot?.id).toBe(actor.id)
    f.buddies.update({ buddyId: actor.id, expectedRevision: actor.revision, enabled: false })
    expect(f.bind(queued.id)).toMatchObject({ kind: 'actor_unavailable' })
    expect(f.database.prepare('SELECT count(*) AS count FROM conversations').get()).toEqual({ count: 0 })
  })
})
