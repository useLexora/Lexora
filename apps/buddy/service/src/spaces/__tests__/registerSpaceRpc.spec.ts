import type { DatabaseSync } from 'node:sqlite'
import type { AutomationDefinitionDraft } from '../../../../shared/automation'
import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import type { RuntimeRequestRegistrar } from '../../rpc/runtimeRequest'
import type { SpaceRecord } from '../../storage/spaceRepository'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Emitter } from '../../../../shared/events/Emitter'
import { AutomationChangeCoordinator } from '../../automations/AutomationChangeCoordinator'
import { AutomationService } from '../../automations/AutomationService'
import { createAutomationRepositories } from '../../storage/automationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { registerSpaceRpc } from '../registerSpaceRpc'
import { SpaceDependents } from '../SpaceDependents'
import { SpaceService } from '../SpaceService'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('registerSpaceRpc', () => {
  it('serves committed Space changes consumed by session and automation services', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-space-rpc-')))
    directories.push(root)
    const firstRoot = join(root, 'first')
    const secondRoot = join(root, 'second')
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])
    await writeFile(join(firstRoot, 'notes.md'), 'Space notes')

    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const spaces = createSpaceRepository(database)
    const service = new SpaceService(spaces)
    const automations = new AutomationService({
      clock: { now: () => Temporal.Instant.from('2026-08-27T00:00:00.000Z') },
      createId: () => 'automation-1',
      repositories: createAutomationRepositories(database),
    })
    const effects: string[] = []
    const automationChanges = new AutomationChangeCoordinator({
      notify: automationId => effects.push(`automation:${automationId}`),
      service: automations,
      wakeScheduler: () => {
        effects.push('scheduler:wake')
      },
    })
    const harness = createRpcHarness()
    const consumer = new SpaceDependents({
      source: service,
      grants: { quiesce: async () => {}, onDidCommit: new Emitter<never>(() => {}).event },
      sessions: { snapshot: () => [], onDidChange: new Emitter<never>(() => {}).event },
      resources: {
        async reconcileInvalidation(input) {
          effects.push(`session:${input.scope}`)
          return { matched: 0, pending: 0, degraded: 0 }
        },
        async resync() {},
        snapshot: () => [],
      },
      automations: automationChanges,
      record: () => {},
    })
    registerSpaceRpc({ rpc: harness.rpc, service })

    const created = await harness.invoke('spaces.create', {
      memoryScope: 'space_only',
      name: 'Space',
      primaryDirectory: { id: null, root: firstRoot },
      primaryDirectorySelectionVerified: true,
    }) as SpaceRecord
    expect(created).toMatchObject({
      activeRunCount: 0,
      primaryDirectory: { canonicalRoot: firstRoot, resourcesTrustedAt: expect.any(String) },
      revokedAt: null,
    })
    await expect(harness.invoke('spaces.list', {})).resolves.toEqual([created])
    await expect(harness.invoke('spaces.searchFiles', {
      query: 'notes',
      spaceId: created.id,
    })).resolves.toEqual([
      expect.objectContaining({ name: 'notes.md', relativePath: 'notes.md' }),
    ])

    const automation = automations.create({
      draft: dailyDraft(created.id),
      requestId: 'create-automation',
    })
    await automationChanges.whenIdle()
    expect(effects).toEqual([`automation:${automation.id}`, 'scheduler:wake'])
    effects.length = 0
    const updated = await harness.invoke('spaces.update', {
      memoryScope: 'personal_and_space',
      name: 'Renamed Space',
      primaryDirectory: { id: null, root: secondRoot },
      primaryDirectorySelectionVerified: true,
      spaceId: created.id,
    }) as SpaceRecord
    expect(updated).toMatchObject({
      memoryScope: 'personal_and_space',
      name: 'Renamed Space',
      primaryDirectory: { canonicalRoot: secondRoot },
    })
    await consumer.whenIdle()
    expect(effects).toEqual([`session:${created.id}`])

    effects.length = 0
    await expect(harness.invoke('spaces.delete', { spaceId: created.id }))
      .resolves
      .toEqual({ ok: true })
    await consumer.whenIdle()
    expect(spaces.findById(created.id)).toMatchObject({ revokedAt: expect.any(String) })
    expect(automations.get(automation.id)).toMatchObject({
      blockedReason: 'AUTOMATION_SPACE_UNAVAILABLE',
      status: 'blocked',
    })
    expect([...effects].sort()).toEqual([
      `automation:${automation.id}`,
      'scheduler:wake',
      `session:${created.id}`,
    ].sort())

    await expect(harness.invoke('spaces.list', { unexpected: true }))
      .rejects
      .toMatchObject({ code: 'VALIDATION_FAILED' })
    await consumer.dispose()
    await automationChanges.dispose()
    await service.dispose()
  })
})

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

function dailyDraft(spaceId: string): AutomationDefinitionDraft {
  return {
    executionProfile: 'workspace_write',
    model: { mode: 'default' },
    name: 'Space automation',
    prompt: 'Review the Space',
    spaceId,
    timing: {
      activeFrom: null,
      activeUntil: null,
      schedule: { cadence: 'daily', kind: 'calendar', localTime: '12:00' },
      timezone: 'Asia/Shanghai',
    },
  }
}
