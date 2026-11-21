import type { LocalRun } from '@buddy-shared/runs/runApi'
import type { ChatTurnAnchor } from '../modules/tasks/reader'
import type { ReaderEntry } from './readerBridge'
import { orderChatTurnRows } from '../modules/tasks/reader'

export function orderReaderTurns(rows: ReaderEntry[], runs: LocalRun[]) {
  const inputs = new Map(rows.flatMap(row => row.messages.filter(message => message.role === 'user').map(message => [message.id, message] as const)))
  if (inputs.size < 1)
    return rows
  const anchors = new Map<string, ChatTurnAnchor>(runs.filter(run => inputs.has(run.triggeringMessageId)).map(run => [run.id, { ...run, runId: run.id }]))
  const owners = new Map<string, string>()
  for (const row of rows) {
    for (const m of row.messages) {
      if (!m.turnRootId || !m.turnInputId)
        continue
      if (m.runId)
        owners.set(m.runId, m.turnRootId)
      const trigger = inputs.get(m.turnInputId)
      if (trigger?.createdAt && trigger.branchId && !anchors.has(m.turnRootId)) {
        anchors.set(m.turnRootId, { runId: m.turnRootId, triggeringMessageId: trigger.id, startedAt: trigger.createdAt, completedAt: null, branchId: trigger.branchId })
      }
    }
  }
  if (anchors.size < 2)
    return rows
  return orderChatTurnRows(rows, [...anchors.values()], row => row.messages.find(m => m.role === 'user'), (row) => {
    const message = row.messages[0]
    if (message?.turnRootId)
      return message.turnRootId
    const runId = row.activityGroup?.runId ?? row.runStatus?.run.id ?? message?.runId
    return runId && (owners.get(runId) ?? runId)
  })
}
