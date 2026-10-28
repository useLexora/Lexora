import type { BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { BuddyInputDelivery } from '@buddy-shared/conversation/chatApi'
import type { Ref } from 'vue'
import type { TaskExecutionTree } from '../../contracts'
import { getBuddyUserContentActorReferences } from '@buddy-shared/conversation/buddyUserContent'
import { isExecutionTextInput } from '@buddy-shared/executions/executionComposerInput'
import { computed } from 'vue'

export function useActorInputTarget(options: {
  content: Readonly<Ref<BuddyUserContentV1>>
  scopeKey: Readonly<Ref<string>>
  defaultActorId?: Readonly<Ref<string | null>>
  followUpBehavior?: Readonly<Ref<'queue' | 'steer'>>
  tree: Pick<TaskExecutionTree, 'groups' | 'target'>
}) {
  const actors = computed(() => [...new Set(getBuddyUserContentActorReferences(options.content.value).map(actor => actor.actorId))])
  const actorId = computed(() => actors.value.length === 1 ? actors.value[0]! : options.defaultActorId?.value ?? null)
  const execution = computed(() => {
    if (!options.scopeKey.value.startsWith('conversation:') || !actorId.value)
      return null
    const candidates = [...options.tree.groups.value.byRun.values()].filter(record =>
      record.buddyId === actorId.value && (record.kind === 'root' || record.kind === 'actor_child') && record.phase !== 'closed',
    )
    return candidates.length === 1 ? candidates[0]! : null
  })
  const target = computed(() => execution.value ? options.tree.target(execution.value) : null)
  const answering = computed(() => actors.value.length <= 1 && !!execution.value?.canAnswer
    && execution.value.questions.some(question => question.open && question.audience === 'user'))
  const delivery = computed<BuddyInputDelivery | undefined>(() => {
    if (!options.scopeKey.value.startsWith('conversation:') || !actorId.value)
      return undefined
    return {
      mode: target.value && !answering.value && options.followUpBehavior?.value === 'queue' ? 'next' : 'current',
      actorId: actorId.value,
      target: target.value ? { rootRunId: target.value.rootRunId, runId: target.value.runId } : null,
    }
  })
  const mailboxTarget = computed(() => {
    const record = execution.value
    if (!record || delivery.value?.mode !== 'current' || actors.value.length > 1 || record.stopping || record.phase === 'closing' || !isExecutionTextInput(options.content.value))
      return null
    return (record.kind === 'actor_child' && record.canSend)
      || answering.value
      ? target.value
      : null
  })
  return { actorId, execution, target, mailboxTarget, delivery }
}

export type ActorInputTarget = ReturnType<typeof useActorInputTarget>
