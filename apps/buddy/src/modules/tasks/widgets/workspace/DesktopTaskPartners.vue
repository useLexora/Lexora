<script setup lang="ts">
import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import type { TaskChatWorkspace } from '../../contracts'
import { Stop20Filled } from '@vicons/fluent'
import { NButton, NTooltip } from 'naive-ui'
import { computed, shallowReactive } from 'vue'
import { BuddySelector } from '@/modules/buddies'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { projectTaskPartners } from '../../model/executions/executionGroups'
import { executionLabels } from '../executions/executionLabels'

const props = defineProps<{ workspace: TaskChatWorkspace }>()
const tree = props.workspace.executionTree
const session = props.workspace.session
const labels = computed(() => executionLabels(props.workspace.language.value))
const partners = computed(() => projectTaskPartners(tree.groups.value))
const activity = computed(() => ({
  count: partners.value.activeCount,
  byBuddy: partners.value.activityByBuddy,
  label: partners.value.activeCount ? labels.value.partnersWorking.replace('{count}', String(partners.value.activeCount)) : labels.value.partners,
}))
const stopping = shallowReactive(new Set<string>())
const failed = shallowReactive(new Set<string>())
function stopTargets(buddyId: string) {
  const actors = (partners.value.byBuddy.get(buddyId) ?? []).filter(actor => actor.phase !== 'closed')
  const root = actors.find(actor => actor.kind === 'root')
  return root ? [root] : actors
}
function stopLabel(buddyId: string) {
  return stopTargets(buddyId).some(actor => actor.kind === 'root') ? labels.value.stopCollaboration : labels.value.stop
}
function criticalStatus(actor: LocalExecution) {
  if (stopping.has(actor.runId) || actor.stopping)
    return labels.value.stopping
  if (actor.cleanup === 'degraded')
    return labels.value.cleanupBadge
  if (actor.status === 'failed')
    return labels.value.failed
  if (actor.questions.some(question => question.open && question.audience === 'user'))
    return labels.value.waitingAnswer
  if (actor.waitingFor === 'approval')
    return labels.value.waitingApproval
  return null
}
const notices = computed(() => new Map([...partners.value.byBuddy].map(([id, actors]) => [id, actors.map(actor => ({ actor, status: criticalStatus(actor) })).filter(item => item.status || failed.has(item.actor.runId))])))
async function stopBuddy(buddyId: string) {
  await Promise.all(stopTargets(buddyId).map(actor => stop(actor.runId)))
}
async function stop(runId: string) {
  const actor = tree.groups.value.byRun.get(runId)
  if (!actor?.canCancel || !tree.ready.value || stopping.has(runId))
    return
  const target = tree.target(actor)
  stopping.add(runId)
  failed.delete(runId)
  try {
    await tree.api.cancel(target)
    await tree.refresh()
  }
  catch {
    failed.add(runId)
  }
  finally {
    stopping.delete(runId)
  }
}
</script>

<template>
  <BuddySelector :buddy-id="session.selectedBuddyId.value" :members="session.members" :disabled="session.isSelectingBuddy.value || workspace.execution.isSending.value" :select="session.selectBuddy" :activity="activity">
    <template #member-actions="{ buddyId }">
      <NTooltip>
        <template #trigger>
          <NButton size="small" secondary type="error" class="buddy-icon-button" :aria-label="stopLabel(buddyId)" :loading="stopTargets(buddyId).some(actor => stopping.has(actor.runId))" :disabled="!tree.ready.value || !stopTargets(buddyId).some(actor => actor.canCancel && !actor.stopping)" @click="stopBuddy(buddyId)">
            <template #icon>
              <DesktopIcon :component="Stop20Filled" :size="18" />
            </template>
          </NButton>
        </template>
        {{ stopLabel(buddyId) }}
      </NTooltip>
    </template>
    <template #member-activity="{ buddyId }">
      <div v-for="{ actor, status } in notices.get(buddyId)" :key="actor.runId" class="grid min-w-0 gap-2 ml-11 mt-1" :data-partner-execution="actor.runId">
        <span v-if="status" class="text-[12px]" :class="actor.status === 'failed' || actor.cleanup === 'degraded' ? 'text-danger' : 'text-muted'" role="status">
          <template v-if="(partners.byBuddy.get(buddyId)?.length ?? 0) > 1">#{{ actor.ordinal }} · </template>{{ status }}
        </span>
        <p v-if="failed.has(actor.runId)" role="alert" class="m-0 text-[12px] text-danger">
          {{ labels.actionFailed }}
        </p>
      </div>
    </template>
  </BuddySelector>
</template>
