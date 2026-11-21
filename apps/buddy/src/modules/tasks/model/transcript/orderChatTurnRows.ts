export interface ChatTurnAnchor {
  runId: string
  triggeringMessageId: string
  startedAt: string
  completedAt: string | null
  branchId: string
}

interface InputRow { id: string, branchId?: string, createdAt?: string | null }

export function orderChatTurnRows<T>(rows: readonly T[], anchors: readonly ChatTurnAnchor[], inputOf: (row: T) => InputRow | undefined, ownerOf: (row: T) => string | null | undefined): T[] {
  const inputs = new Set(rows.map(inputOf).filter(input => input !== undefined).map(input => input.id))
  const roots = anchors.filter(root => inputs.has(root.triggeringMessageId)).toSorted((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId))
  if (roots.length < 2)
    return [...rows]
  const byRoot = new Map(roots.map(root => [root.runId, [] as T[]]))
  const byInput = new Map<string, string[]>()
  for (const root of roots) {
    const siblings = byInput.get(root.triggeringMessageId) ?? []
    siblings.push(root.runId)
    byInput.set(root.triggeringMessageId, siblings)
  }
  for (const row of rows) {
    const input = inputOf(row)
    if (input && byInput.has(input.id))
      continue
    const owner = ownerOf(row)
    if (owner && byRoot.has(owner)) {
      byRoot.get(owner)!.push(row)
      continue
    }
    if (input?.createdAt && roots.some(root => input.branchId === root.branchId && input.createdAt! >= root.startedAt && (!root.completedAt || input.createdAt! <= root.completedAt)))
      return [...rows]
  }
  return rows.flatMap((row) => {
    const input = inputOf(row)
    const siblings = input && byInput.get(input.id)
    if (siblings)
      return [row, ...siblings.flatMap(runId => byRoot.get(runId)!)]
    const owner = ownerOf(row)
    return owner && byRoot.has(owner) ? [] : [row]
  })
}
