import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import { createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { projectExecutionGroups } from '../../../model/executions/executionGroups'
import { useActorInputTarget } from '../useActorInputTarget'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
function execution(runId: string, overrides: Partial<LocalExecution> = {}): LocalExecution {
  return {
    runId,
    rootRunId: 'root',
    parentRunId: 'root',
    buddyId: 'partner',
    buddyName: 'Partner',
    ordinal: 1,
    toolCount: 0,
    usage: null,
    kind: 'actor_child',
    phase: 'working',
    status: 'running',
    startedAt: '2026-10-13T00:00:00.000Z',
    completedAt: null,
    updatedAt: '2026-10-13T00:00:00.000Z',
    progress: null,
    stopping: false,
    task: 'Task',
    waitingFor: null,
    activeChildren: 0,
    canCancel: true,
    canAnswer: false,
    canSend: true,
    cleanup: 'pending',
    errorCode: null,
    affectedResources: [],
    questions: [],
    ...overrides,
  }
}
function setup(children: LocalExecution[]) {
  const root = execution('root', { kind: 'root', buddyId: 'lead', parentRunId: null })
  const groups = shallowRef(projectExecutionGroups([root, ...children]))
  const content = shallowRef(createBuddyUserContent())
  const scopeKey = shallowRef('conversation:conversation:branch')
  const defaultActorId = shallowRef<string | null>('lead')
  const scope = effectScope()
  cleanups.push(() => scope.stop())
  const state = scope.run(() => useActorInputTarget({ content, scopeKey, defaultActorId, tree: { groups, target: record => ({ conversationId: 'conversation', branchId: 'branch', rootRunId: record.rootRunId, runId: record.runId }) } }))!
  const mention = (actorId = 'partner') => {
    content.value = { ...createBuddyUserContent(), body: [{ type: 'paragraph', content: [{ type: 'actor_ref', actorId, name: 'Partner' }, { type: 'text', text: ' Additional request' }] }] }
  }
  return { state, content, scopeKey, defaultActorId, mention, update: (children: LocalExecution[]) => groups.value = projectExecutionGroups([root, ...children]) }
}

describe('actor composer routing', () => {
  it('finds an earlier root child after an independent newer root finishes', () => {
    const f = setup([
      execution('first'),
      execution('new-root', { kind: 'root', rootRunId: 'new-root', parentRunId: null, buddyId: 'other', phase: 'closed', status: 'completed', startedAt: '2026-10-13T00:01:00.000Z' }),
    ])
    f.mention()
    expect(f.state.mailboxTarget.value?.runId).toBe('first')
    expect(f.state.delivery.value).toEqual({ mode: 'current', actorId: 'partner', target: { rootRunId: 'root', runId: 'first' } })
  })

  it('keeps the actor target for rich input without pretending it is a mailbox answer', () => {
    const f = setup([execution('first')])
    f.mention()
    f.content.value = { ...f.content.value, panelResourceIds: ['file'] }
    expect(f.state.target.value?.runId).toBe('first')
    expect(f.state.mailboxTarget.value).toBeNull()
    expect(f.state.delivery.value?.target?.runId).toBe('first')
  })

  it('does not choose NPCs, closed runs or an ambiguous active actor', () => {
    const f = setup([execution('private', { kind: 'npc_child' })])
    f.mention()
    expect(f.state.target.value).toBeNull()
    f.update([execution('closed', { phase: 'closed' })])
    expect(f.state.delivery.value?.target).toBeNull()
    f.update([execution('one'), execution('two')])
    expect(f.state.target.value).toBeNull()
    f.update([execution('one')])
    expect(f.state.target.value?.runId).toBe('one')
  })

  it('retains a closing target for authority checks instead of treating it as a new turn', () => {
    const f = setup([execution('closing', { phase: 'closing', stopping: true, canSend: false })])
    f.mention()
    expect(f.state.target.value?.runId).toBe('closing')
    expect(f.state.mailboxTarget.value).toBeNull()
  })

  it('derives the default destination and follows recipient or draft scope changes', () => {
    const f = setup([execution('first')])
    expect(f.state.execution.value?.runId).toBe('root')
    expect(f.state.mailboxTarget.value).toBeNull()
    expect(f.state.delivery.value).toEqual({ mode: 'current', actorId: 'lead', target: { rootRunId: 'root', runId: 'root' } })
    f.mention()
    expect(f.state.delivery.value).toEqual({ mode: 'current', actorId: 'partner', target: { rootRunId: 'root', runId: 'first' } })
    f.mention('lead')
    expect(f.state.delivery.value).toEqual({ mode: 'current', actorId: 'lead', target: { rootRunId: 'root', runId: 'root' } })
    f.mention('idle')
    expect(f.state.delivery.value).toEqual({ mode: 'current', actorId: 'idle', target: null })
    f.scopeKey.value = 'message-edit:conversation:branch:message'
    expect(f.state.target.value).toBeNull()
    expect(f.state.delivery.value).toBeUndefined()
  })

  it('routes multiple mentions to the leader without using an actor mailbox', () => {
    const f = setup([execution('first')])
    f.mention()
    f.content.value = { ...f.content.value, body: [{ type: 'paragraph', content: [...f.content.value.body[0]!.content, { type: 'actor_ref', actorId: 'other', name: 'Other' }] }] }
    expect(f.state.actorId.value).toBe('lead')
    expect(f.state.target.value?.runId).toBe('root')
    expect(f.state.mailboxTarget.value).toBeNull()
  })
})
