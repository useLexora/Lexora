const pollingMethods = new Set([
  'chat.queue.list',
  'approvals.list',
  'conversations.listTimeline',
  'taskMarks.states',
  'taskMarks.list',
  'notifications.list',
])

export function isRoutineRpc(method: string): boolean {
  return pollingMethods.has(method)
}

export function isRoutineRpcRecord(record: { event: string, method?: string, level: string }): boolean {
  return record.event.startsWith('rpc.') && !!record.method && isRoutineRpc(record.method) && ['debug', 'info'].includes(record.level)
}
