import type { ContextPanelOperationRecord } from '@buddy-shared/context-panel/contextPanel'
import type { UseTaskContextPanelOptions } from '../typing'
import { ContextPanelHost } from '@buddy-electron/main/context-panel/ContextPanelHost'
import { onTestFinished, vi } from 'vitest'
import { computed, effectScope, shallowRef } from 'vue'
import { useTaskContextPanel } from '../useTaskContextPanel'

export function contextPanelFixture(overrides: Partial<UseTaskContextPanelOptions> = {}) {
  const operations: ContextPanelOperationRecord[] = []
  const host = new ContextPanelHost(async (operation) => {
    operations.push(operation)
  })
  const scope = effectScope()
  onTestFinished(() => scope.stop())
  const activeConversationId = overrides.activeConversationId ?? shallowRef(null)
  const options: UseTaskContextPanelOptions = {
    activeConversationId,
    activeDraftId: computed(() => `draft-${activeConversationId.value ?? 'new'}`),
    activeBranchId: shallowRef('branch'),
    activeRunId: shallowRef(null),
    mode: shallowRef('task'),
    taskVisible: shallowRef(true),
    spaces: shallowRef([]),
    changeSets: shallowRef([]),
    runOutputs: shallowRef([]),
    control: {
      getState: async () => host.getState(),
      execute: command => host.execute(command),
      onStateChanged: listener => host.subscribe(listener),
    },
    onError: vi.fn(),
    ...overrides,
  }
  return { host, options, operations, scope }
}

export function createTaskPanel(overrides: Partial<UseTaskContextPanelOptions> = {}) {
  const fixture = contextPanelFixture(overrides)
  return fixture.scope.run(() => useTaskContextPanel(fixture.options))!
}
