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

export const CONVERSATION_LAST_ACTIVITY_SQL = `MAX(
  conversations.created_at,
  COALESCE((WITH queued_inputs AS MATERIALIZED (
    SELECT conversation_id, CAST(json_extract(prepared_json, '$.userMessageId') AS TEXT) AS message_id
    FROM chat_queue WHERE json_extract(prepared_json, '$.userMessageId') IS NOT NULL
  ) SELECT MAX(input.created_at) FROM messages input
    WHERE input.conversation_id = conversations.id AND input.role = 'user'
      AND (input.run_id IS NULL OR EXISTS (SELECT 1 FROM runs WHERE id = input.run_id AND execution_kind = 'root' AND purpose <> 'conversation.compaction'))
      AND json_extract(input.content_json, '$.questionReply') IS NULL
      AND NOT EXISTS (SELECT 1 FROM queued_inputs queued WHERE queued.conversation_id = input.conversation_id AND queued.message_id = input.id)
  ), conversations.created_at),
  COALESCE((SELECT MAX(created_at) FROM chat_queue WHERE conversation_id = conversations.id), conversations.created_at),
  COALESCE((SELECT MAX(completed_at) FROM runs
    WHERE conversation_id = conversations.id AND execution_kind = 'root'
      AND purpose <> 'conversation.compaction' AND status IN ('completed', 'failed', 'cancelled')
  ), conversations.created_at),
  COALESCE((SELECT MAX(activity_mailbox.created_at) FROM runs activity_run
    JOIN execution_mailbox_sources activity_mailbox ON activity_mailbox.target_run_id = activity_run.id
    WHERE activity_run.conversation_id = conversations.id AND ${USER_ACTIVITY_MAILBOX_SQL}
  ), conversations.created_at),
  COALESCE((SELECT MAX(json_extract(question.request_json, '$.resolvedAt')) FROM runs question_run
    JOIN user_questions question ON question.run_id = question_run.id
    WHERE question_run.conversation_id = conversations.id AND json_extract(question.request_json, '$.status') = 'answered'
  ), conversations.created_at)
)`
