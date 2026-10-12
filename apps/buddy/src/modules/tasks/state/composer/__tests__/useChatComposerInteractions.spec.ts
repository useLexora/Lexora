import type { LocalRun } from '@buddy-shared/runs/runApi'

import { describe, expect, it } from 'vitest'
import { nextTick, shallowRef } from 'vue'

import { useChatComposerInteractions } from '../useChatComposerInteractions'

describe('useChatComposerInteractions', () => {
  it('publishes no-op feedback only for a command started by the current UI session', async () => {
    const runs = shallowRef<ReadonlyArray<LocalRun>>([
      run('historical', 'failed', 'CONTEXT_COMPACTION_NOT_NEEDED'),
    ])
    const interactions = useChatComposerInteractions({ runs })

    expect(interactions.interaction.value).toBeNull()

    interactions.trackActionCommand('current')
    runs.value = [
      ...runs.value,
      run('current', 'failed', 'CONTEXT_COMPACTION_NOT_NEEDED'),
    ]
    await nextTick()

    expect(interactions.interaction.value).toEqual({
      autoDismissMs: 5_000,
      dismissible: true,
      id: 'command-feedback:current',
      kind: 'notice',
      messageKey: 'desktop.chat.compactionNotNeeded',
      tone: 'info',
    })

    interactions.dismissInteraction('another')
    expect(interactions.interaction.value).not.toBeNull()
    interactions.dismissInteraction('command-feedback:current')
    expect(interactions.interaction.value).toBeNull()
  })

  it('does not publish feedback for material command outcomes', async () => {
    const runs = shallowRef<ReadonlyArray<LocalRun>>([])
    const interactions = useChatComposerInteractions({ runs })
    interactions.trackActionCommand('completed')
    interactions.trackActionCommand('failed')
    runs.value = [
      run('completed', 'completed', null),
      run('failed', 'failed', 'COMPACTION_FAILED'),
    ]
    await nextTick()

    expect(interactions.interaction.value).toBeNull()
  })
})

function run(
  id: string,
  status: LocalRun['status'],
  errorCode: string | null,
): LocalRun {
  return {
    buddyId: 'default',
    branchId: 'branch-1',
    completedAt: status === 'queued' || status === 'running'
      ? null
      : '2026-09-03T00:00:02.000Z',
    conversationId: 'conversation-1',
    errorCode,
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write',
    id,
    modelId: 'model-1',
    providerId: 'provider-1',
    purpose: 'conversation.compaction',
    reasoningLevel: null,
    startedAt: '2026-09-03T00:00:01.000Z',
    status,
    triggeringMessageId: 'message-1',
  }
}
