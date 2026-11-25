// @vitest-environment jsdom
import type { ChatActivityInput } from '../../modules/tasks/reader'
import type { ReaderActionInput, ReaderUpdate } from '../readerProtocol'
import { expect, it, vi } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { readerActionSchema } from '../readerProtocol'
import { describeReaderComposerActivity, useReaderComposerActivity } from '../useReaderComposerActivity'

const base: NonNullable<ReaderUpdate['composerActivity']> = { requestId: '1', runId: 'root', status: 'running', awaitingApproval: false, awaitingAnswer: false, stopping: false, runningTool: false, runningReasoning: false, replying: false }

it('renders only attested turn-window facts with desktop wording and priority', () => {
  const show = (facts: Partial<typeof base>) => describeReaderComposerActivity({ ...base, ...facts }, undefined, 'zh', 0)
  expect(show({ status: 'queued' })).toMatchObject({ label: '等待开始', active: false })
  expect(show({ replying: true })).toMatchObject({ label: '正在回复', active: true })
  expect(show({ replying: true, runningReasoning: true })).toMatchObject({ label: '正在思考' })
  expect(show({ runningReasoning: true, runningTool: true })).toMatchObject({ label: '正在执行' })
  expect(show({ runningTool: true, awaitingApproval: true })).toMatchObject({ label: '有操作待批准', warning: true, active: false })
  expect(show({ runningTool: true, awaitingAnswer: true })).toMatchObject({ label: '等待回答', active: false })
  expect(show({ runningTool: true, awaitingAnswer: true, stopping: true })).toMatchObject({ label: '正在停止', active: false })
})

it('publishes only the scoped presentation, ticks legacy retry deadlines, and releases them on switch', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const scope = effectScope()
  try {
    const source = shallowRef<ReaderUpdate['composerActivity']>(base)
    const turn = shallowRef<ChatActivityInput>({ status: 'running', nodes: [], progress: { phase: 'model_requesting', toolName: null, retry: { attempt: 1, maxAttempts: 2, retryAt: new Date(2000).toISOString() } } })
    const language = shallowRef('zh')
    const actions: ReaderActionInput[] = []
    scope.run(() => useReaderComposerActivity(source, () => turn.value, language, action => actions.push(action)))
    expect(actions.at(-1)).toEqual({ action: 'composer-activity', requestId: '1', label: '2 秒后重试', active: false, warning: true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(actions.at(-1)).toMatchObject({ label: '1 秒后重试' })
    source.value = null
    await nextTick()
    const count = actions.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(actions).toHaveLength(count)
    language.value = 'en'
    turn.value = { status: 'running', nodes: [], progress: null }
    source.value = { ...base, requestId: '2', runId: 'other', awaitingAnswer: true }
    await nextTick()
    expect(readerActionSchema.parse({ ...actions.at(-1), topic: 'other-branch' })).toEqual({ action: 'composer-activity', requestId: '2', topic: 'other-branch', label: 'Waiting for an answer', active: false, warning: true })
  }
  finally {
    scope.stop()
    vi.useRealTimers()
  }
})
