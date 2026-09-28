import { afterEach, describe, expect, it } from 'vitest'
import { openBuddyDatabase } from '../../storage/database'
import { createWorkspaceRepository } from '../../storage/workspaceRepository'
import { WorkspaceStateService } from '../WorkspaceStateService'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
function setup(normalize?: (value: unknown) => Promise<unknown>) {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const service = new WorkspaceStateService({ repository: createWorkspaceRepository(database), normalize })
  cleanups.push(async () => {
    await service.dispose()
    database.close()
  })
  const events: string[] = []
  service.onDidChange(event => events.push(event.kind))
  return { service, events }
}

describe('workspace state ownership', () => {
  it('validates before persistence and only emits a real commit, with an owned read snapshot', async () => {
    const { service, events } = setup()
    expect(() => service.write({ invalid: true })).toThrow()
    expect(await service.read()).toBeNull()
    const value = { activeConversationId: 'conversation-1', spaceId: null }
    const first = service.write(value)
    value.activeConversationId = 'external-mutation'
    expect(service.write({ activeConversationId: 'conversation-1', spaceId: null })).toEqual(first)
    expect((await service.read())?.value).toEqual({ activeConversationId: 'conversation-1', spaceId: null })
    expect(Object.isFrozen(first.value)).toBe(true)
    expect(events).toEqual(['committed'])
  })

  it('distinguishes normalization from persistence and drains accepted normalization before disposal', async () => {
    const pending = Promise.withResolvers<unknown>()
    const { service, events } = setup(() => pending.promise)
    service.write({ activeConversationId: null, spaceId: null })
    const reading = service.read()
    const stopping = service.dispose()
    await expect(service.read()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    pending.resolve({ activeConversationId: 'recovered', spaceId: null })
    expect((await reading)?.value).toEqual({ activeConversationId: 'recovered', spaceId: null })
    await stopping
    expect(events).toEqual(['committed', 'normalized'])
    expect(service.snapshot.record?.value).toEqual({ activeConversationId: null, spaceId: null })
  })

  it('retains the committed workspace when a later compatibility normalization fails', async () => {
    const { service, events } = setup(async () => {
      throw new Error('failed after resource import')
    })
    service.write({ activeConversationId: null, spaceId: null })
    await expect(service.read()).rejects.toThrow('failed after resource import')
    expect(events).toEqual(['committed', 'normalization-failed'])
    expect(service.snapshot.record).not.toBeNull()
  })
})
