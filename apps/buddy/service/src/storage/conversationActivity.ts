export const USER_ACTIVITY_MAILBOX_SQL = `
  activity_mailbox.source_run_id = activity_mailbox.target_run_id
  AND (
    (json_extract(activity_mailbox.payload_json, '$.kind') = 'supplement'
      AND json_extract(activity_mailbox.payload_json, '$.origin') = 'user'
      AND COALESCE(json_extract(activity_mailbox.payload_json, '$.purpose'), '') <> 'question_answer'
      AND NOT EXISTS (SELECT 1 FROM messages WHERE id = activity_mailbox.id))
    OR (json_extract(activity_mailbox.payload_json, '$.kind') = 'answer'
      AND EXISTS (
        SELECT 1 FROM execution_mailbox_sources question
        WHERE question.source_run_id = activity_mailbox.target_run_id
          AND json_extract(question.payload_json, '$.kind') = 'question'
          AND json_extract(question.payload_json, '$.audience') = 'user'
          AND json_extract(question.payload_json, '$.questionId') = json_extract(activity_mailbox.payload_json, '$.questionId')
      ))
  )
`

function conversationActivityFactsSql(inScope: (column: string) => string) {
  return `
    WITH queued_inputs AS MATERIALIZED (
      SELECT conversation_id, CAST(json_extract(prepared_json, '$.userMessageId') AS TEXT) AS message_id
      FROM chat_queue WHERE json_extract(prepared_json, '$.userMessageId') IS NOT NULL
        AND ${inScope('conversation_id')}
    )
    SELECT input.conversation_id, input.created_at AS activity_at FROM messages input
    WHERE input.role = 'user'
      AND (input.run_id IS NULL OR EXISTS (SELECT 1 FROM runs WHERE id = input.run_id AND execution_kind = 'root' AND purpose <> 'conversation.compaction'))
      AND json_extract(input.content_json, '$.questionReply') IS NULL
      AND NOT EXISTS (SELECT 1 FROM queued_inputs queued WHERE queued.conversation_id = input.conversation_id AND queued.message_id = input.id)
      AND ${inScope('input.conversation_id')}
    UNION ALL
    SELECT conversation_id, created_at FROM chat_queue WHERE ${inScope('conversation_id')}
    UNION ALL
    SELECT conversation_id, completed_at FROM runs
    WHERE execution_kind = 'root' AND purpose <> 'conversation.compaction'
      AND status IN ('completed', 'failed', 'cancelled') AND ${inScope('conversation_id')}
    UNION ALL
    SELECT activity_run.conversation_id, activity_mailbox.created_at FROM execution_mailbox_sources activity_mailbox
    JOIN runs activity_run ON activity_run.id = activity_mailbox.target_run_id
    WHERE ${USER_ACTIVITY_MAILBOX_SQL} AND ${inScope('activity_run.conversation_id')}
    UNION ALL
    SELECT question_run.conversation_id, json_extract(question.request_json, '$.resolvedAt') FROM user_questions question
    JOIN runs question_run ON question_run.id = question.run_id
    WHERE json_extract(question.request_json, '$.status') = 'answered' AND ${inScope('question_run.conversation_id')}
  `
}

export const HISTORY_CANDIDATE_ACTIVITY_SQL = `
  SELECT conversation_id, MAX(activity_at) AS latest_fact_at
  FROM (${conversationActivityFactsSql(column => `${column} IN (SELECT id FROM history_candidates)`)})
  GROUP BY conversation_id
`

export const CONVERSATION_LAST_ACTIVITY_SQL = `MAX(conversations.created_at, COALESCE((
  SELECT MAX(activity_at) FROM (${conversationActivityFactsSql(column => `${column} = conversations.id`)})
), conversations.created_at))`
