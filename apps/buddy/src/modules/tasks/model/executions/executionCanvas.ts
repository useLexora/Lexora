import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'

export interface ExecutionCanvasNode {
  execution: LocalExecution
  parentId: string | null
  x: number
  y: number
  width: number
  height: number
}

const ROW_GAP = 16

export function projectExecutionCanvas(records: readonly LocalExecution[], rootRunId: string): readonly ExecutionCanvasNode[] {
  const root = records.find(record => record.runId === rootRunId && record.kind === 'root')
  if (!root)
    return []
  const children = new Map<string, LocalExecution[]>()
  for (const record of records) {
    if (record.rootRunId !== rootRunId || !record.parentRunId || record.kind === 'maintenance')
      continue
    const siblings = children.get(record.parentRunId) ?? []
    siblings.push(record)
    children.set(record.parentRunId, siblings)
  }
  for (const siblings of children.values())
    siblings.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))

  const nodes: ExecutionCanvasNode[] = []
  const visited = new Set<string>()
  let nextY = 0
  function visit(execution: LocalExecution, depth: number): ExecutionCanvasNode {
    visited.add(execution.runId)
    const node: ExecutionCanvasNode = {
      execution,
      parentId: depth ? execution.parentRunId : null,
      x: depth * 312,
      y: 0,
      width: 272,
      height: execution.kind === 'npc_child' ? 96 : 56,
    }
    nodes.push(node)
    const startY = nextY
    const descendants = (children.get(execution.runId) ?? []).filter(child => !visited.has(child.runId)).map(child => visit(child, depth + 1))
    node.y = descendants.length
      ? Math.max(startY, (descendants[0]!.y + descendants[0]!.height / 2 + descendants.at(-1)!.y + descendants.at(-1)!.height / 2) / 2 - node.height / 2)
      : nextY
    nextY = Math.max(nextY, node.y + node.height + ROW_GAP)
    return node
  }
  visit(root, 0)
  return nodes
}

export function executionNeedsAnswer(execution: LocalExecution): boolean {
  return execution.phase !== 'closed' && !execution.stopping && execution.canAnswer
    && execution.questions.some(question => question.open && question.audience === 'user')
}

export function executionNeedsAttention(execution: LocalExecution): boolean {
  return executionNeedsAnswer(execution)
    || (execution.phase !== 'closed' && !execution.stopping && execution.waitingFor === 'approval')
}
