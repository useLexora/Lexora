import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalContextUsageSnapshotRequest } from '@buddy-shared/conversation/contextApi'
import type { ExtensionViewInput } from '@buddy-shared/extensions/extensionApi'
import type { TaskWorkspacePool } from '../TaskWorkspacePool'
import type { TaskCapability } from '@/modules/tasks/contracts'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { Emitter } from '@buddy-shared/events/Emitter'
import { expect, it } from 'vitest'
import { shallowRef } from 'vue'
import { createWorkbenchDataPort } from '../createWorkbenchDataPort'

function fixture() {
  const branch = shallowRef('branch-a')
  const runtime = shallowRef({ status: 'ready' })
  const contextTarget = shallowRef<LocalContextUsageSnapshotRequest | null>({ actorId: 'actor-a', runId: 'run-a', conversationId: 'task-a', branchId: 'branch-a', draftId: 'draft-a', approvalPolicy: 'policy', executionProfile: 'workspace_write', spaceId: null, modelSelection: { providerId: 'provider', modelId: 'model', reasoning: null, serviceTier: null } })
  const task = { contextTarget, session: { activeTaskId: shallowRef('task-a') }, workspace: { session: { activeBranchId: branch }, restoration: { state: shallowRef('ready') }, status: { runtimeState: runtime } } } as unknown as TaskCapability
  const changes = new Emitter<void>(() => {})
  const poolChanges = new Emitter<void>(() => {})
  const metricsChanges = new Emitter<{ conversationId: string, revision: number }>(() => {})
  const controller = { layout: { activePane: 'other-pane', views: { 'task-view': { resource: { scheme: 'task', id: 'task-a' } }, 'file-view': { resource: { scheme: 'file', id: 'file' } } } }, pane: (id: string) => id === 'task-pane' ? { view: 'task-view' } : id === 'file-pane' ? { view: 'file-view' } : null, onDidChangeLayout: changes.event } as unknown as WorkbenchController
  const pool = { peek: () => task, onDidChange: poolChanges.event } as unknown as TaskWorkspacePool
  const api = { runs: {
    metrics: async (input: { conversationId: string, branchId: string }) => ({ ...input, turns: 2, steps: 3, tokens: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 }, throughput: { samples: 0, tokensPerSecond: null } }),
    onMetricsChanged: (listener: (event: { conversationId: string, revision: number }) => void) => metricsChanges.event(listener).dispose,
  }, context: { getUsageSnapshot: async () => ({ status: 'ready', totalTokens: 40, contextWindow: 100 }) } } as unknown as LocalChatApi
  return { port: createWorkbenchDataPort({ api, controller, pool }), contextTarget, branch, runtime, metricsChanges, input: (instanceId?: string) => ({ instanceId } as ExtensionViewInput) }
}

it('reads the explicitly associated pane, never the globally active pane or an unbound/file view', async () => {
  const f = fixture()
  expect(await f.port.binding(f.input('task-pane'), 'task.metrics')!.read()).toEqual({ source: 'task.metrics', status: 'ready', value: { taskId: 'task-a', branchId: 'branch-a', turns: 2, steps: 3, tokens: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 }, throughput: { samples: 0, tokensPerSecond: null } } })
  for (const id of [undefined, 'other-pane', 'file-pane'])
    expect(f.port.binding(f.input(id), 'task.metrics')).toBeNull()
})
it('keeps context execution identity separate from task aggregate scope', async () => {
  const f = fixture()
  expect(await f.port.binding(f.input('task-pane'), 'context.usage')!.read()).toEqual({ source: 'context.usage', status: 'ready', value: { taskId: 'task-a', branchId: 'branch-a', actorId: 'actor-a', runId: 'run-a', tokens: 40, window: 100, percent: 40 } })
  const previous = f.port.binding(f.input('task-pane'), 'context.usage')!.key
  f.contextTarget.value = { ...f.contextTarget.value!, actorId: 'actor-b', runId: 'run-b' }
  expect(f.port.binding(f.input('task-pane'), 'context.usage')!.key).not.toBe(previous)
  expect(await f.port.binding(f.input('task-pane'), 'context.usage')!.read()).toMatchObject({ value: { actorId: 'actor-b', runId: 'run-b' } })
  f.contextTarget.value = { ...f.contextTarget.value!, branchId: 'other-branch' }
  expect(f.port.binding(f.input('task-pane'), 'context.usage')).toBeNull()
})
it('notifies bound scope changes synchronously and stops observing when released', async () => {
  const f = fixture()
  const seen: Array<string | null> = []
  const stop = f.port.observeChanges(f.input('task-pane'), () => seen.push(f.port.binding(f.input('task-pane'), 'task.metrics')?.key ?? null))
  f.metricsChanges.fire({ conversationId: 'other-task', revision: 1 })
  expect(seen).toEqual([])
  f.branch.value = 'branch-b'
  expect(seen.at(-1)).toContain('branch-b')
  f.runtime.value = { status: 'stopped' }
  expect(await f.port.binding(f.input('task-pane'), 'task.metrics')!.read()).toEqual({ source: 'task.metrics', status: 'unavailable', value: null })
  const count = seen.length
  stop()
  f.branch.value = 'branch-c'
  f.metricsChanges.fire({ conversationId: 'task-a', revision: 2 })
  expect(seen).toHaveLength(count)
})
