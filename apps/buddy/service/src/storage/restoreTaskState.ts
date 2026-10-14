import type { DatabaseSync } from 'node:sqlite'

export function reconcileRestoredTaskState(target: DatabaseSync, source: DatabaseSync): void {
  const updateHead = target.prepare(`
    INSERT INTO conversation_public_heads (conversation_id, sequence)
    SELECT ?, MAX(?, COALESCE(MAX(sequence), 0)) FROM conversation_publications WHERE conversation_id = ?
    ON CONFLICT(conversation_id) DO UPDATE SET sequence = MAX(sequence, excluded.sequence)
  `)
  for (const row of source.prepare('SELECT conversation.id, COALESCE(head.sequence, 0) AS sequence FROM conversations conversation LEFT JOIN conversation_public_heads head ON head.conversation_id = conversation.id').iterate())
    updateHead.run(row.id!, row.sequence!, row.id!)
  const invalidate = target.prepare('DELETE FROM run_event_checkpoints WHERE run_id = ?')
  for (const row of source.prepare('SELECT id FROM runs').iterate())
    invalidate.run(row.id!)
}
