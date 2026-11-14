import type { DatabaseSync } from 'node:sqlite'

export type ExecutionResourceState = 'released' | 'occupied' | 'unknown'

const resourceSeverity = `MAX(
  CASE WHEN e.run_id IS NULL OR e.cleanup_state = 'degraded' THEN 2
    WHEN r.status IN ('queued', 'running') OR e.phase <> 'closed' OR e.cleanup_state <> 'clean' THEN 1
    ELSE 0 END,
  COALESCE((SELECT MAX(CASE WHEN l.status = 'hazard' THEN 2 ELSE 1 END)
    FROM run_mutation_leases l WHERE l.run_id = r.id AND l.status IN ('active', 'hazard')), 0))`

export const conversationExecutionResourcesReleased = `NOT EXISTS (
  SELECT 1 FROM runs r LEFT JOIN execution_state e ON e.run_id = r.id
  WHERE r.conversation_id = c.id AND ${resourceSeverity} > 0)`

function resourceState(severity: unknown): ExecutionResourceState {
  return Number(severity) === 2 ? 'unknown' : Number(severity) === 1 ? 'occupied' : 'released'
}

export class ExecutionResourceQueries {
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
  }

  conversations(conversationIds: readonly string[]): ReadonlyMap<string, ExecutionResourceState> {
    const states = new Map<string, ExecutionResourceState>(conversationIds.map(id => [id, 'released']))
    if (!states.size)
      return states
    const rows = this.#database.prepare(`SELECT r.conversation_id, MAX(${resourceSeverity}) AS severity
      FROM runs r LEFT JOIN execution_state e ON e.run_id = r.id
      WHERE r.conversation_id IN (SELECT value FROM json_each(?)) GROUP BY r.conversation_id`)
      .all(JSON.stringify([...states.keys()]))
    for (const row of rows)
      states.set(String(row.conversation_id), resourceState(row.severity))
    return states
  }

  conversation(conversationId: string): ExecutionResourceState {
    return this.conversations([conversationId]).get(conversationId)!
  }

  subtree(runId: string): ExecutionResourceState {
    const row = this.#database.prepare(`WITH RECURSIVE subtree(id) AS (
      SELECT id FROM runs WHERE id = ?
      UNION SELECT r.id FROM runs r JOIN subtree s ON r.parent_run_id = s.id
    ) SELECT COUNT(*) AS count, MAX(${resourceSeverity}) AS severity
      FROM subtree s JOIN runs r ON r.id = s.id LEFT JOIN execution_state e ON e.run_id = r.id`).get(runId)!
    return Number(row.count) ? resourceState(row.severity) : 'unknown'
  }

  service(): ExecutionResourceState {
    const row = this.#database.prepare(`SELECT MAX(${resourceSeverity}) AS severity
      FROM runs r LEFT JOIN execution_state e ON e.run_id = r.id`).get()!
    return resourceState(row.severity)
  }
}
