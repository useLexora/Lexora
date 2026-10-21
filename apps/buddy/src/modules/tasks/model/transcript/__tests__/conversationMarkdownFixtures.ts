import type { LocalConversation, LocalConversationTimelinePage, LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'

export const at = '2026-10-21T08:00:00.000Z'
export function conversation(patch: Partial<LocalConversation> = {}): LocalConversation {
  return { id: 'conversation', buddyId: 'default', title: '排查启动失败', activeBranchId: 'branch', spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', modelSelection: null, createdAt: at, updatedAt: at, deletedAt: null, ...patch }
}
export function page(patch: Partial<LocalConversationTimelinePage> = {}): LocalConversationTimelinePage {
  return { items: [], runs: [], runEvents: [], outputs: [], changeSets: [], nextCursor: null, ...patch }
}
export function message(id: string, role: LocalMessage['role'], content: LocalMessage['content'], patch: Partial<LocalMessage> = {}): LocalMessage & { kind: 'message' } {
  return { kind: 'message', id, role, content, conversationId: 'conversation', branchId: 'branch', runId: role === 'user' ? null : 'run', createdAt: at, attachments: [], ...patch }
}
export function run(patch: Partial<LocalRun> = {}): LocalRun {
  return { id: 'run', conversationId: 'conversation', branchId: 'branch', buddyId: 'default', triggeringMessageId: 'user', modelId: 'model', providerId: 'provider', reasoningLevel: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', purpose: 'chat', status: 'completed', startedAt: at, completedAt: at, errorCode: null, ...patch }
}
export function event(sequence: number, type: string, payload: Record<string, unknown>, runId = 'run'): LocalRunEvent {
  return { sequence, type, payload, runId, createdAt: at }
}
export function terminal(output: string | null = null) {
  return { card: 'terminal' as const, command: 'pnpm dev', cwd: 'D:\\project', exitCode: null as number | null, signal: null, description: null, output, truncated: false }
}
