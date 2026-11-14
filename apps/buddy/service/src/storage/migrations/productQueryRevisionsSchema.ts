export const PRODUCT_QUERY_REVISION_TABLES = [
  'approvals',
  'approval_reviews',
  'approval_decisions',
  'artifacts',
  'attachments',
  'automation_occurrences',
  'chat_queue',
  'composer_drafts',
  'composer_resources',
  'conversation_branches',
  'conversation_publications',
  'conversations',
  'managed_files',
  'messages',
  'run_events',
  'run_inputs',
  'runs',
  'spaces',
  'task_attention',
  'task_marks',
  'user_questions',
] as const

type Row = 'OLD' | 'NEW'
interface RevisionSource {
  name: string
  table: string
  owners: (row: Row) => string
  columns?: readonly string[]
  visible?: (row: Row) => string
  history?: (row: Row) => string
}
const task = (id: string) => `SELECT ${id} AS conversation_id, NULL AS branch_id, NULL AS run_id`
const branch = (row: string) => `SELECT ${row}.conversation_id, ${row}.branch_id, NULL AS run_id`
const run = (id: string) => `SELECT conversation_id, branch_id, id AS run_id FROM runs WHERE id = ${id}`
const owners: Record<typeof PRODUCT_QUERY_REVISION_TABLES[number], (row: Row) => string> = {
  approvals: row => run(`${row}.run_id`),
  approval_reviews: row => `SELECT r.conversation_id, r.branch_id, r.id AS run_id FROM approvals a JOIN runs r ON r.id = a.run_id WHERE a.id = ${row}.approval_id`,
  approval_decisions: row => `SELECT r.conversation_id, r.branch_id, r.id AS run_id FROM approvals a JOIN runs r ON r.id = a.run_id WHERE a.id = ${row}.approval_id`,
  artifacts: row => task(`${row}.conversation_id`),
  attachments: row => `SELECT conversation_id, branch_id, NULL AS run_id FROM messages WHERE id = ${row}.message_id`,
  automation_occurrences: row => task(`${row}.conversation_id`),
  chat_queue: branch,
  composer_drafts: branch,
  composer_resources: row => `SELECT conversation_id, branch_id, NULL AS run_id FROM composer_drafts WHERE id = ${row}.draft_id`,
  conversation_branches: row => `SELECT ${row}.conversation_id, ${row}.id AS branch_id, NULL AS run_id`,
  conversation_publications: branch,
  conversations: row => task(`${row}.id`),
  managed_files: row => `SELECT m.conversation_id, m.branch_id, NULL AS run_id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.stored_path = ${row}.path`,
  messages: branch,
  run_events: row => run(`${row}.run_id`),
  run_inputs: row => run(`${row}.run_id`),
  runs: row => `SELECT ${row}.conversation_id, ${row}.branch_id, ${row}.id AS run_id`,
  spaces: () => 'SELECT NULL AS conversation_id, NULL AS branch_id, NULL AS run_id WHERE 0',
  task_attention: row => task(`${row}.conversation_id`),
  task_marks: () => 'SELECT NULL AS conversation_id, NULL AS branch_id, NULL AS run_id WHERE 0',
  user_questions: row => run(`${row}.run_id`),
}

const sources: RevisionSource[] = [
  ...PRODUCT_QUERY_REVISION_TABLES.map(table => ({ name: table, table, owners: owners[table] })),
  { name: 'conversation_visibility', table: 'conversations', owners: owners.conversations, columns: ['id', 'deleted_at'] },
  { name: 'run_summaries', table: 'runs', owners: owners.runs, columns: ['id', 'conversation_id', 'branch_id', 'status', 'execution_kind', 'purpose', 'started_at', 'completed_at', 'generation'] },
  { name: 'run_history', table: 'runs', owners: owners.runs, columns: ['id', 'conversation_id', 'branch_id', 'execution_kind', 'actor_snapshot_json'] },
  { name: 'history_tools', table: 'run_events', owners: owners.run_events, visible: row => `${row}.event_type = 'tool.completed'` },
  { name: 'message_summaries', table: 'messages', owners: owners.messages, visible: row => `${row}.role IN ('user', 'assistant') AND (${row}.run_id IS NULL OR EXISTS (SELECT 1 FROM runs WHERE id = ${row}.run_id AND execution_kind IN ('root', 'actor_child')))` },
  { name: 'publication_summaries', table: 'conversation_publications', owners: owners.conversation_publications, visible: row => `${row}.kind = 'message'` },
]
function attachmentReference(content: string, id: string) {
  const json = `CASE WHEN json_valid(${content}) THEN ${content} ELSE '{}' END`
  return `EXISTS (SELECT 1 FROM json_each(${json}, '$.resourceSnapshots') snapshot
    WHERE CASE WHEN snapshot.type = 'object' THEN json_extract(snapshot.value, '$.attachmentId') END = ${id})
    OR EXISTS (SELECT 1 FROM json_each(${json}, '$.attachmentIds') reference WHERE reference.value = ${id})`
}
const history: Record<string, (row: Row) => string> = {
  messages: row => `SELECT ${row}.id AS id`,
  conversation_publications: row => `SELECT ${row}.message_id AS id WHERE ${row}.kind = 'message'`,
  run_history: row => `SELECT id FROM messages WHERE run_id = ${row}.id`,
  history_tools: row => `SELECT id FROM messages WHERE run_id = ${row}.run_id AND role = 'tool'`,
  attachments: row => `SELECT id FROM messages WHERE id = ${row}.message_id OR ${attachmentReference('messages.content_json', `${row}.id`)}`,
  managed_files: row => `SELECT DISTINCT m.id FROM attachments a JOIN messages m ON m.id = a.message_id
    OR ${attachmentReference('m.content_json', 'a.id')}
    WHERE a.stored_path = ${row}.path`,
}
for (const source of sources) source.history = history[source.name]
const operations = ['insert', 'update', 'delete'] as const
export const SCOPED_QUERY_REVISION_SOURCES = [...sources.map(source => source.name), 'history_messages', 'history_branches']
export const SCOPED_QUERY_REVISION_TRIGGER_NAMES = sources.flatMap(source => operations.map(operation => `product_query_revision_${source.name}_${operation}`))

function scopes(source: RevisionSource, row: Row) {
  const select = source.owners(row)
  return `SELECT '' AS scope
    UNION SELECT json_array('task', conversation_id) FROM (${select}) WHERE conversation_id IS NOT NULL
    UNION SELECT json_array('branch', conversation_id, branch_id) FROM (${select}) WHERE conversation_id IS NOT NULL AND branch_id IS NOT NULL
    UNION SELECT json_array('run', run_id) FROM (${select}) WHERE run_id IS NOT NULL`
}

export const PRODUCT_QUERY_REVISIONS_SCHEMA_SQL = `
CREATE TABLE product_query_revisions (
  table_name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (table_name, scope)
);
${SCOPED_QUERY_REVISION_SOURCES.map(name => `INSERT OR IGNORE INTO product_query_revisions (table_name) VALUES ('${name}');`).join('\n')}
${sources.flatMap(source => operations.map((operation) => {
  const rows: Row[] = operation === 'insert' ? ['NEW'] : operation === 'delete' ? ['OLD'] : ['OLD', 'NEW']
  const changed = operation === 'update' && source.columns ? `(${source.columns.map(column => `NEW.${column} IS NOT OLD.${column}`).join(' OR ')})` : '1'
  const visible = source.visible ? `(${rows.map(row => `(${source.visible!(row)})`).join(' OR ')})` : '1'
  return `CREATE TRIGGER product_query_revision_${source.name}_${operation} AFTER ${operation.toUpperCase()} ON ${source.table}
    WHEN ${changed} AND ${visible}
    BEGIN
      INSERT INTO product_query_revisions (table_name, scope, revision)
        SELECT '${source.name}', scope, 1 FROM (${rows.map(row => scopes(source, row)).join(' UNION ')}) WHERE 1
        ON CONFLICT (table_name, scope) DO UPDATE SET revision = revision + 1;
      ${source.history
        ? `INSERT INTO product_query_revisions (table_name, scope, revision)
        SELECT 'history_messages', json_array('message', id), 1 FROM (${rows.map(row => source.history!(row)).join(' UNION ')}) WHERE id IS NOT NULL
        ON CONFLICT (table_name, scope) DO UPDATE SET revision = revision + 1;
      INSERT INTO product_query_revisions (table_name, scope, revision)
        ${source.name === 'messages'
          ? `SELECT 'history_branches', scope, 1
        FROM (${rows.map(row => `SELECT json_array('branch', ${row}.conversation_id, ${row}.branch_id) AS scope`).join(' UNION ')}) WHERE 1`
          : `SELECT DISTINCT 'history_branches', json_array('branch', m.conversation_id, m.branch_id), 1
        FROM messages m WHERE m.id IN (${rows.map(row => source.history!(row)).join(' UNION ')})
        `}
        ON CONFLICT (table_name, scope) DO UPDATE SET revision = revision + 1;`
        : ''}
    END;`
})).join('\n')}
`
