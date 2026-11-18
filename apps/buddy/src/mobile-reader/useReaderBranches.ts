import type { LocalRun } from '@buddy-shared/runs/runApi'
import type { InjectionKey, Ref } from 'vue'
import type { ChatMessageBranchNavigator } from '../modules/tasks/reader'
import type { ReaderEntry } from './readerBridge'
import type { ReaderUpdate } from './readerProtocol'
import { computed, inject, provide } from 'vue'
import { projectMessageBranchNavigators } from '../modules/tasks/reader'

const readerBranchesKey: InjectionKey<Readonly<Ref<ReadonlyMap<string, ChatMessageBranchNavigator>>>> = Symbol('reader-branches')

export function provideReaderBranches(entries: Ref<ReaderEntry[]>, runs: Ref<LocalRun[]>, branches: Ref<NonNullable<ReaderUpdate['branches']>>, selected: Ref<string | null>) {
  const navigators = computed(() => {
    const messages = entries.value.flatMap(entry => entry.messages)
    return projectMessageBranchNavigators(
      messages.flatMap(message => message.branchId ? [{ id: message.id, branchId: message.branchId, role: message.role }] : []),
      runs.value.map(run => ({ ...run, runId: run.id })),
      new Set(messages.filter(message => message.actionsVisible).map(message => message.id)),
      branches.value,
      selected.value ?? '',
    )
  })
  provide(readerBranchesKey, navigators)
}

export function useReaderBranch(message: () => { id: string, runId: string | null, canRegenerate: boolean }) {
  const navigators = inject(readerBranchesKey, undefined)
  return computed(() => navigators?.value.get(message().id) ?? (message().canRegenerate ? navigators?.value.get(message().runId ?? '') : undefined))
}

export function useReaderTurnBranch(runId: () => string) {
  const navigators = inject(readerBranchesKey, undefined)
  return computed(() => navigators?.value.get(runId()))
}
