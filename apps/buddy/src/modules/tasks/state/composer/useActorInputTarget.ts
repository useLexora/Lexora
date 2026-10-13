import type { BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { Ref } from 'vue'
import type { TaskExecutionTree } from '../../contracts'
import { getBuddyUserContentActorReferences } from '@buddy-shared/conversation/buddyUserContent'
import { isExecutionTextInput } from '@buddy-shared/executions/executionComposerInput'
import { computed } from 'vue'
import { projectTaskPartners } from '../../model/executions/executionGroups'

export function useActorInputTarget(options: {
  content: Readonly<Ref<BuddyUserContentV1>>
  scopeKey: Readonly<Ref<string>>
  tree: Pick<TaskExecutionTree, 'groups' | 'target'>
}) {
  const target = computed(() => {
    if (!options.scopeKey.value.startsWith('conversation:') || !isExecutionTextInput(options.content.value))
      return null
    const actors = getBuddyUserContentActorReferences(options.content.value)
    if (actors.length !== 1)
      return null
    const record = projectTaskPartners(options.tree.groups.value).byBuddy.get(actors[0]!.actorId)?.find(record =>
      (record.kind === 'actor_child' && record.canSend)
      || (record.kind === 'root' && record.canAnswer && record.questions.some(question => question.open && question.audience === 'user')),
    )
    return record ? options.tree.target(record) : null
  })
  return { target }
}
