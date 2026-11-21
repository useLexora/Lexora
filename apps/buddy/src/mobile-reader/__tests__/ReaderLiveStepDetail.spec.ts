// @vitest-environment jsdom
import type { ReaderActionInput, ReaderStepDetailReply } from '../readerProtocol'
import { expect, it, vi } from 'vitest'
import { createApp, h, nextTick, provide, shallowRef } from 'vue'
import ReaderLiveStepDetail from '../ReaderLiveStepDetail.vue'
import { readerStepDetailKey } from '../readerStepDetail'
import { readerLanguageKey } from '../readerStrings'

it('follows exactly one expanded step, cancels an unfinished read on collapse and stops at failure or completion', async () => {
  vi.useFakeTimers()
  const reply = shallowRef<ReaderStepDetailReply>()
  const open = shallowRef(true)
  const actions: ReaderActionInput[] = []
  const scope = { stepId: 'step73', groupId: 'group2', runId: 'run1' }
  const app = createApp({ setup() {
    provide(readerStepDetailKey, reply)
    provide(readerLanguageKey, shallowRef('zh'))
    return () => open.value ? h(ReaderLiveStepDetail, { ...scope, send: action => actions.push(action) }) : null
  } })
  const root = document.createElement('div')
  function receive(requestId: string, text: string, status: 'running' | 'failed' | 'completed') {
    reply.value = { stepId: scope.stepId, type: 'step-detail', error: null, topic: 'task', requestId, result: { stepId: scope.stepId, status, messageId: null, revision: 'a'.repeat(64), truncated: false, available: true, text } }
  }
  const currentRead = () => {
    const action = actions.at(-1)
    if (action?.action !== 'read-step-detail')
      throw new Error('Expected one active step read')
    expect(action).toMatchObject(scope)
    return action.requestId
  }
  try {
    app.mount(root)
    receive(currentRead(), 'make apk', 'running')
    await nextTick()
    expect(root.textContent).toContain('make apk')
    vi.advanceTimersByTime(3000)
    const pending = currentRead()
    expect(actions.at(-1)).toHaveProperty('knownRevision', 'a'.repeat(64))
    open.value = false
    await nextTick()
    expect(actions.at(-1)).toEqual({ action: 'stop-step-detail', requestId: pending })
    receive(pending, 'late', 'running')
    vi.advanceTimersByTime(9000)
    expect(actions).toHaveLength(3)
    for (const status of ['failed', 'completed'] as const) {
      open.value = true
      await nextTick()
      receive(currentRead(), status, status)
      await nextTick()
      const count = actions.length
      vi.advanceTimersByTime(9000)
      expect(actions).toHaveLength(count)
      expect(root.textContent).toContain(status)
      open.value = false
      await nextTick()
    }
  }
  finally {
    app.unmount()
    vi.useRealTimers()
  }
})
