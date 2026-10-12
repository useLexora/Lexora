import type { LocalConversationTimelinePage } from '@buddy-shared/conversation/conversationApi'
import type { LocalConversationTreeNode } from '@buddy-shared/conversation/conversationTree'
import type { LocalRun } from '@buddy-shared/runs/runApi'
import type { ChatRunEventBuckets } from '../../../model/runs/typing'
import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { deferred } from '../../../../../../__tests__/deferred'
import { mergeChatRunEventBuckets } from '../../../model/runs/chatRunEventBuckets'
import { useConversationNodeDetail } from '../useConversationNodeDetail'

const now = '2026-09-09T00:00:00.000Z'

describe('conversation node detail', () => {
  it('ignores late content after another node, another conversation or closing', async () => {
    const pending = Array.from({ length: 4 }, () => deferred<LocalConversationTimelinePage>())
    let index = 0
    const conversationId = shallowRef<string | null>('conversation')
    const scope = effectScope()
    const detail = scope.run(() => useConversationNodeDetail({
      conversationId,
      language: shallowRef('zh-CN'),
      runs: shallowRef([]),
      runEventBuckets: shallowRef(new Map()),
      runOutputs: shallowRef([]),
      changeSets: shallowRef([]),
      load: () => pending[index++]!.promise,
    }))!
    try {
      detail.open(question('one'))
      detail.open(question('two'))
      pending[1]!.resolve(page('two'))
      await nextTick()
      pending[0]!.resolve(page('one'))
      await nextTick()
      expect(detail.data.value?.items.map(item => item.id)).toEqual(['two'])
      detail.open(question('three'))
      detail.close()
      pending[2]!.resolve(page('three'))
      await nextTick()
      expect(detail.visible.value).toBe(false)
      expect(detail.data.value).toBeNull()
      detail.open(question('four'))
      conversationId.value = 'other'
      pending[3]!.resolve(page('four'))
      await nextTick()
      expect(detail.target.value).toBeNull()
      expect(detail.rows.value).toEqual([])
    }
    finally { scope.stop() }
  })

  it('shows an output process and incremental text without adding its triggering input', async () => {
    const run: LocalRun = {
      buddyId: 'default',
      id: 'run',
      conversationId: 'conversation',
      branchId: 'branch',
      triggeringMessageId: 'input',
      status: 'running',
      startedAt: now,
      completedAt: null,
      modelId: 'model',
      providerId: 'provider',
      purpose: 'chat',
      reasoningLevel: null,
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
      errorCode: null,
    }
    const buckets = shallowRef<ChatRunEventBuckets>(new Map())
    const scope = effectScope()
    const detail = scope.run(() => useConversationNodeDetail({
      conversationId: shallowRef('conversation'),
      language: shallowRef('zh-CN'),
      runs: shallowRef([run]),
      runEventBuckets: buckets,
      runOutputs: shallowRef([]),
      changeSets: shallowRef([]),
      load: async () => ({ items: [], runs: [run], runEvents: [], outputs: [], changeSets: [], nextCursor: null }),
    }))!
    try {
      detail.open({ ...question('answer'), kind: 'answer', runId: run.id, messageId: null, status: 'running' })
      await nextTick()
      buckets.value = mergeChatRunEventBuckets(buckets.value, [
        { runId: run.id, sequence: 1, type: 'message.started', createdAt: now, payload: { messageId: 'answer', role: 'assistant' } },
        { runId: run.id, sequence: 2, type: 'message.delta', createdAt: now, payload: { messageId: 'answer', delta: 'Hello' } },
      ])
      await nextTick()
      buckets.value = mergeChatRunEventBuckets(buckets.value, [{ runId: run.id, sequence: 3, type: 'message.delta', createdAt: now, payload: { messageId: 'answer', delta: ' world' } }])
      await nextTick()
      expect(detail.rows.value.filter(row => row.kind === 'message').map(row => row.message.content)).toEqual([{ text: 'Hello world' }])
      expect(detail.rows.value.map(row => row.kind)).toEqual(['agent-turn', 'message', 'activity'])
    }
    finally { scope.stop() }
  })
})

function question(id: string): LocalConversationTreeNode {
  return { id, parentId: null, kind: 'question', branchId: 'branch', messageId: id, runId: null, text: id, quotes: [], quoteCount: 0, status: null, active: false, toolCount: 0, attempts: [], attachments: [], attachmentCount: 0, artifacts: [], artifactCount: 0, metadata: null }
}
function page(id: string): LocalConversationTimelinePage {
  return { items: [{ id, kind: 'message', role: 'user', content: { text: id }, conversationId: 'conversation', branchId: 'branch', runId: null, createdAt: now, attachments: [] }], runs: [], runEvents: [], outputs: [], changeSets: [], nextCursor: null }
}
