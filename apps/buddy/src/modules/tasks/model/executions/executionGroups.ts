import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'

export interface ExecutionGroup {
  root: LocalExecution
  records: readonly LocalExecution[]
  actors: readonly LocalExecution[]
  activeActors: readonly LocalExecution[]
  participantCount: number
  subtasks: readonly LocalExecution[]
  mode: 'single' | 'subtasks' | 'collaboration'
}

export interface ExecutionGroups {
  byRoot: ReadonlyMap<string, ExecutionGroup>
  byRun: ReadonlyMap<string, LocalExecution>
}

export function projectExecutionGroups(records: readonly LocalExecution[]): ExecutionGroups {
  const byRun = new Map(records.map(record => [record.runId, record]))
  const members = new Map<string, LocalExecution[]>()
  for (const record of records) {
    if (record.kind === 'maintenance')
      continue
    const group = members.get(record.rootRunId) ?? []
    group.push(record)
    members.set(record.rootRunId, group)
  }
  const byRoot = new Map<string, ExecutionGroup>()
  for (const [rootId, membersOfRoot] of members) {
    const root = byRun.get(rootId)
    if (root?.kind !== 'root')
      continue
    const ordered = membersOfRoot.sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0))
    const actors = ordered.filter(record => record.kind === 'root' || record.kind === 'actor_child')
    const subtasks = ordered.filter(record => record.kind === 'npc_child')
    byRoot.set(rootId, {
      root,
      records: ordered,
      actors,
      activeActors: actors.filter(record => record.phase !== 'closed'),
      participantCount: new Set(actors.filter(record => record.kind === 'actor_child').map(record => record.buddyId)).size,
      subtasks,
      mode: actors.length > 1 ? 'collaboration' : subtasks.length ? 'subtasks' : 'single',
    })
  }
  return { byRoot, byRun }
}

export function projectTaskPartners(groups: ExecutionGroups) {
  const latest = [...groups.byRoot.values()].sort((a, b) => b.root.startedAt.localeCompare(a.root.startedAt))[0]
  const byBuddy = new Map<string, LocalExecution[]>()
  const activityByBuddy = new Map<string, 'working' | 'waiting'>()
  const active = new Set<string>()
  for (const actor of latest?.actors ?? []) {
    const records = byBuddy.get(actor.buddyId) ?? []
    records.push(actor)
    byBuddy.set(actor.buddyId, records)
    if (actor.phase !== 'closed') {
      const activity = actor.phase === 'working' && !actor.waitingFor && !actor.stopping ? 'working' : 'waiting'
      if (activityByBuddy.get(actor.buddyId) !== 'working')
        activityByBuddy.set(actor.buddyId, activity)
    }
    if (actor.phase !== 'closed' && actor.buddyId !== latest?.root.buddyId)
      active.add(actor.buddyId)
  }
  return { byBuddy, activityByBuddy, activeCount: active.size }
}
