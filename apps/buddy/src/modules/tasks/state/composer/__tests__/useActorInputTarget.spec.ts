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
    canAnswer: true,
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
  const scope = effectScope()
  cleanups.push(() => scope.stop())
  const state = scope.run(() => useActorInputTarget({ content, scopeKey, tree: { groups, target: record => ({ conversationId: 'conversation', branchId: 'branch', rootRunId: record.rootRunId, runId: record.runId }) } }))!
  const mention = (actorId = 'partner') => {
    content.value = { ...createBuddyUserContent(), body: [{ type: 'paragraph', content: [{ type: 'actor_ref', actorId, name: 'Partner' }, { type: 'text', text: ' Additional request' }] }] }
  }
  return {
    state,
    content,
    scopeKey,
    mention,
    update: (children: LocalExecution[]) => {
      groups.value = projectExecutionGroups([root, ...children])
    },
  }
}

describe('actor composer routing', () => {
  it('addresses the role after its execution ends and uses a later active execution when available', () => {
    const f = setup([execution('first')])
    f.mention()
    expect(f.state.target.value?.runId).toBe('first')
    f.update([execution('first', { phase: 'closed', canSend: false })])
    expect(f.state.target.value).toBeNull()
    expect(f.content.value.body[0]?.content[0]).toMatchObject({ actorId: 'partner' })
    f.update([execution('second')])
    expect(f.state.target.value?.runId).toBe('second')
  })

  it('uses normal message routing for resources while preserving the addressed role', () => {
    const f = setup([execution('first')])
    f.mention()
    f.content.value = { ...f.content.value, panelResourceIds: ['file'] }
    expect(f.state.target.value).toBeNull()
    expect(f.content.value.body[0]?.content[0]).toMatchObject({ actorId: 'partner' })
  })

  it('keeps NPCs and root-only conversations out of live actor input and clears the target on navigation', () => {
    const f = setup([execution('private', { kind: 'npc_child' })])
    f.mention()
    expect(f.state.target.value).toBeNull()
    f.mention('lead')
    expect(f.state.target.value).toBeNull()
    f.update([execution('public')])
    f.mention()
    expect(f.state.target.value?.runId).toBe('public')
    f.scopeKey.value = 'message-edit:conversation:branch:message'
    expect(f.state.target.value).toBeNull()
  })
})
