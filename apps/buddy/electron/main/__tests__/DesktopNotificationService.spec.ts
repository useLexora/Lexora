import type { LocalExecution } from '../../../shared/executions/executionPresentationApi'
import { describe, expect, it, vi } from 'vitest'
import { DesktopNotificationService } from '../DesktopNotificationService'

function fixture(kind: LocalExecution['kind'] = 'root') {
  const run = {
    approvalPolicy: 'policy',
    buddyId: 'reviewer',
    branchId: 'branch-1',
    completedAt: '2026-08-19T08:00:00.000Z',
    conversationId: 'conversation-1',
    errorCode: null,
    executionProfile: 'workspace_write',
    id: 'run-1',
    modelId: 'test-model',
    providerId: 'test-provider',
    purpose: 'chat',
    reasoningLevel: 'high',
    startedAt: '2026-08-19T07:59:00.000Z',
    status: 'completed',
    triggeringMessageId: 'message-1',
  }
  const execution: LocalExecution = {
    runId: run.id,
    rootRunId: kind === 'root' ? run.id : 'root',
    parentRunId: kind === 'root' ? null : 'root',
    buddyId: run.buddyId,
    buddyName: '审查者',
    ordinal: kind === 'root' ? null : 2,
    kind,
    phase: 'closed',
    status: 'completed',
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    updatedAt: run.completedAt,
    progress: null,
    toolCount: 1,
    stopping: false,
    task: '检查发布产物\n  与升级路径',
    waitingFor: null,
    activeChildren: 0,
    canCancel: false,
    canAnswer: false,
    canSend: false,
    cleanup: 'clean',
    errorCode: null,
    affectedResources: [],
    questions: [],
  }
  const state = {
    settings: { notificationsEnabled: true, subtaskNotificationsEnabled: true, notifyWhenFocused: false },
    focused: false,
    executions: [execution],
  }
  const notifications: { body: string, title: string }[] = []
  const clicks: (() => void)[] = []
  const openTarget = vi.fn()
  const request = vi.fn(async (method: string) => {
    if (method === 'runs.get')
      return run
    if (method === 'executions.list')
      return state.executions
    if (method === 'conversations.get') {
      return {
        buddyId: 'default',
        activeBranchId: run.branchId,
        approvalPolicy: 'policy',
        createdAt: run.startedAt,
        deletedAt: null,
        executionProfile: 'workspace_write',
        id: run.conversationId,
        modelSelection: null,
        spaceId: null,
        title: '整理发布说明',
        updatedAt: run.completedAt,
      }
    }
    throw new Error('Unexpected notification request')
  })
  const service = new DesktopNotificationService({
    createNotification(input) {
      return { onClick: listener => clicks.push(listener), show: () => notifications.push(input) }
    },
    getLanguage: () => 'zh-CN',
    getSettings: () => state.settings,
    isWindowFocused: () => state.focused,
    openTarget,
    request,
  })
  const event = (type = 'run.completed', sequence = 8) => ({
    method: 'run.event',
    params: { createdAt: run.completedAt, payload: { errorCode: null }, runId: run.id, sequence, type },
  })
  return { service, state, run, execution, request, notifications, clicks, openTarget, event }
}

describe('desktopNotificationService', () => {
  it('filters events, respects master and foreground settings, and opens a deduplicated root notification when subtasks are disabled', async () => {
    const f = fixture()
    f.state.settings.subtaskNotificationsEnabled = false
    for (const type of ['run.cancelled', 'tool.completed'])
      await f.service.handle(f.event(type))
    expect(f.notifications).toEqual([])
    await Promise.all([f.service.handle(f.event()), f.service.handle(f.event())])
    await f.service.handle(f.event())
    expect(f.notifications).toEqual([{ body: '任务已完成', title: '整理发布说明' }])
    f.clicks[0]!()
    expect(f.openTarget).toHaveBeenCalledWith({ conversationId: f.run.conversationId, runId: f.run.id })
    f.state.focused = true
    f.state.settings.notificationsEnabled = false
    f.state.settings.notifyWhenFocused = true
    for (const type of ['approval.requested', 'run.completed', 'run.failed'])
      await f.service.handle(f.event(type, 9))
    expect(f.notifications).toHaveLength(1)
    f.state.settings.notificationsEnabled = true
    f.state.settings.notifyWhenFocused = false
    for (const type of ['approval.requested', 'run.completed', 'run.failed'])
      await f.service.handle(f.event(type, 9))
    expect(f.notifications).toHaveLength(1)
    f.state.settings.notifyWhenFocused = true
    for (const type of ['approval.requested', 'run.completed', 'run.failed'])
      await f.service.handle(f.event(type, 9))
    expect(f.notifications.slice(1)).toEqual([
      { body: '等待你的确认', title: '整理发布说明' },
      { body: '任务已完成', title: '整理发布说明' },
      { body: '任务失败', title: '整理发布说明' },
    ])
  })

  it.each(['npc_child', 'actor_child'] as const)('identifies %s and independently suppresses its approval, completion and failure notifications', async (kind) => {
    const f = fixture(kind)
    for (const type of ['approval.requested', 'run.completed', 'run.failed'])
      await f.service.handle(f.event(type))
    expect(f.notifications).toEqual([
      { title: '子任务 #2 · 整理发布说明', body: '审查者 · 子任务等待你的确认\n检查发布产物 与升级路径' },
      { title: '子任务 #2 · 整理发布说明', body: '审查者 · 子任务已完成\n检查发布产物 与升级路径' },
      { title: '子任务 #2 · 整理发布说明', body: '审查者 · 子任务失败\n检查发布产物 与升级路径' },
    ])
    f.clicks[0]!()
    expect(f.openTarget).toHaveBeenCalledWith({ conversationId: f.run.conversationId, runId: f.run.id })
    f.state.settings.subtaskNotificationsEnabled = false
    for (const type of ['approval.requested', 'run.completed', 'run.failed'])
      await f.service.handle(f.event(type, 9))
    expect(f.notifications).toHaveLength(3)
  })

  it('rechecks settings and focus after loading notification context', async () => {
    for (const change of ['subtask', 'master', 'focus'] as const) {
      const f = fixture('npc_child')
      const gate = Promise.withResolvers<void>()
      f.request.mockImplementationOnce(async () => {
        await gate.promise
        return f.run
      })
      const handling = f.service.handle(f.event())
      if (change === 'subtask')
        f.state.settings.subtaskNotificationsEnabled = false
      else if (change === 'master')
        f.state.settings.notificationsEnabled = false
      else
        f.state.focused = true
      gate.resolve()
      await handling
      expect(f.notifications).toEqual([])
    }
  })

  it('does not mislabel an unavailable execution and allows retry after a failed context read', async () => {
    const f = fixture('npc_child')
    f.request.mockRejectedValueOnce(new Error('Isolated read failure'))
    await expect(f.service.handle(f.event())).rejects.toThrow('Isolated read failure')
    f.state.executions = []
    await f.service.handle(f.event())
    expect(f.notifications).toEqual([])
    f.state.executions = [f.execution]
    await f.service.handle(f.event())
    expect(f.notifications).toEqual([{ title: '子任务 #2 · 整理发布说明', body: '审查者 · 子任务已完成\n检查发布产物 与升级路径' }])
  })
})
