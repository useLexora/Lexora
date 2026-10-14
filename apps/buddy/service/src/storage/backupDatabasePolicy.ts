import type { SQLOutputValue } from 'node:sqlite'
import type { BackupScope } from '../../../shared/storage/backupScope'

const domains: Partial<Record<BackupScope, readonly string[]>> = {
  buddies: ['buddies', 'buddy_catalog'],
  providers: ['provider_configs', 'builtin_provider_configs', 'provider_states', 'provider_model_states', 'default_model_setting'],
  connections: ['mcp_servers'],
  skills: ['skill_installations', 'skill_space_exclusions'],
  automations: ['automations'],
  tasks: ['conversation_branches', 'messages', 'run_events', 'turn_requests', 'run_inputs', 'command_requests', 'approvals', 'attachments', 'space_events', 'automation_occurrences', 'automation_mutation_requests', 'run_change_sets', 'space_directory_bindings', 'spaces', 'conversations', 'runs', 'conversation_directory_grants', 'artifacts', 'run_file_change_captures', 'composer_resources', 'conversation_pi_trees', 'run_tree_sources', 'task_marks', 'task_attention', 'composer_drafts', 'extension_invocations', 'usage_records', 'conversation_members', 'execution_threads', 'execution_thread_bindings', 'execution_state', 'execution_mailbox_sources', 'execution_mailbox_receipts', 'run_change_invocations', 'conversation_public_heads', 'conversation_publications', 'run_public_snapshots', 'run_session_reference_scopes', 'session_reference_exclusions', 'actor_public_cursors'],
}
export const backupTableScopes = new Map(Object.entries(domains).flatMap(([scope, tables]) => tables.map(table => [table, scope as BackupScope] as const)))
export const backupTables = [...backupTableScopes.keys(), 'workspace_settings']

export function databaseRowScope(table: string, row: Record<string, SQLOutputValue>): BackupScope | null {
  if (table === 'workspace_settings')
    return row.key === 'buddy.web' ? 'connections' : row.key === 'buddy.chat.workspace.v2' ? 'settings' : null
  return backupTableScopes.get(table) ?? null
}

export function backupMergeColumns(table: string, columns: { name: string, pk: number }[]) {
  if (table === 'conversation_public_heads')
    return null
  if (table === 'run_change_invocations')
    return { keys: ['id'], names: columns.filter(column => column.name !== 'sequence').map(column => column.name), order: ['sequence'] }
  return {
    keys: columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name),
    names: columns.map(column => column.name),
    order: [],
  }
}
