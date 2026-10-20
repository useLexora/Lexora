<script setup lang="ts">
import type { ExecutionTarget } from '@buddy-shared/executions/executionPresentationApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { MAX_BUDDY_MESSAGE_TEXT_LENGTH } from '@buddy-shared/conversation/buddyMessageContent'
import { NButton, NInput, NSpin } from 'naive-ui'
import { computed, shallowRef, watch } from 'vue'
import { executionDisplayName } from '../../model/executions/executionDisplayName'
import { useExecutionDetail } from '../../state/runs/useExecutionDetail'
import BuddyChatAgentTurn from '../transcript/BuddyChatAgentTurn.vue'
import BuddyChatAgentTurnFlow from '../transcript/BuddyChatAgentTurnFlow.vue'
import BuddyChatCompactionRow from '../transcript/BuddyChatCompactionRow.vue'
import BuddyChatMessageBody from '../transcript/BuddyChatMessageBody.vue'
import BuddyChatTokenUsage from '../transcript/BuddyChatTokenUsage.vue'
import BuddyChatTurnChanges from '../transcript/BuddyChatTurnChanges.vue'
import BuddyChatTurnOutputs from '../transcript/BuddyChatTurnOutputs.vue'
import { provideChatBuddyIdentity } from '../transcript/chatBuddyIdentity'
import { useChatContent } from '../transcript/chatContentContext'
import BuddyExecutionInputs from './BuddyExecutionInputs.vue'
import BuddyExecutionQuestion from './BuddyExecutionQuestion.vue'
import BuddyExecutionStatus from './BuddyExecutionStatus.vue'
import { executionLabels } from './executionLabels'

const props = defineProps<{ target: ExecutionTarget, visible: boolean, language: BuddyLocale }>()
const emit = defineEmits<{ openArtifact: [id: string], openChanges: [id: string], returnToTask: [], titleChange: [title: string] }>()
const target = computed(() => props.target)
const state = useExecutionDetail(target, computed(() => props.visible))
const detail = state.detail
const execution = computed(() => detail.value?.execution)
const displayName = computed(() => execution.value ? executionDisplayName(execution.value) : null)
const labels = computed(() => executionLabels(props.language, execution.value?.errorCode))
const supplementLabels = computed(() => execution.value?.kind === 'actor_child'
  ? { title: labels.value.actorSupplement, placeholder: labels.value.actorSupplementPlaceholder, send: labels.value.actorSend }
  : { title: labels.value.supplement, placeholder: labels.value.supplementPlaceholder, send: labels.value.send })
const content = useChatContent()
const draft = shallowRef('')
const sending = shallowRef(false)
const stopping = shallowRef(false)
const failed = shallowRef(false)
const retry = shallowRef<{ messageId: string, text: string } | null>(null)
const live = computed(() => state.environment?.ready.value && props.visible && execution.value?.canSend)
const showSupplement = computed(() => execution.value?.kind === 'npc_child'
  || (execution.value?.kind === 'actor_child' && (execution.value.phase !== 'closed' || !!draft.value.trim())))
const updated = computed(() => execution.value ? new Intl.DateTimeFormat(props.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(execution.value.updatedAt)) : '')
provideChatBuddyIdentity(() => detail.value ? [detail.value.run] : [])
watch(displayName, (title) => {
  if (title)
    emit('titleChange', title)
}, { immediate: true })
watch(() => target.value && [target.value.conversationId, target.value.branchId, target.value.rootRunId, target.value.runId].join(':'), () => {
  draft.value = ''
  retry.value = null
  failed.value = false
})
async function send() {
  if (!live.value || !draft.value.trim() || sending.value || !state.environment)
    return
  const recipient = { ...props.target }
  const text = draft.value.trim()
  const attempt = retry.value?.text === text ? retry.value : { messageId: crypto.randomUUID(), text }
  retry.value = attempt
  sending.value = true
  failed.value = false
  try {
    await state.environment.api.send({ ...recipient, ...attempt })
    if (recipient.runId === props.target.runId) {
      if (draft.value.trim() === text)
        draft.value = ''
      retry.value = null
      await state.refresh()
    }
  }
  catch {
    if (recipient.runId === props.target.runId)
      failed.value = true
  }
  finally {
    sending.value = false
  }
}
async function stop() {
  if (!execution.value?.canCancel || !state.environment?.ready.value || stopping.value)
    return
  stopping.value = true
  failed.value = false
  try {
    await state.environment.api.cancel(props.target)
    await state.refresh()
  }
  catch {
    failed.value = true
  }
  finally {
    stopping.value = false
  }
}
async function answer(questionId: string, text: string) {
  if (!execution.value?.canAnswer || !state.environment?.ready.value)
    throw new Error('Execution is no longer accepting answers')
  await state.environment.api.answer({ ...props.target, questionId, text })
  await state.refresh()
}
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col bg-surface [overflow-wrap:anywhere]" data-testid="execution-detail" :data-execution-id="target.runId">
    <div class="flex-1 min-h-0 min-w-0 overflow-auto p-4 grid grid-cols-1 content-start gap-4">
      <div v-if="state.loading.value" class="flex justify-center p-4">
        <NSpin :size="20" />
      </div>
      <p v-if="state.failed.value" role="alert" class="m-0 text-danger text-[12px]">
        {{ labels.loadFailed }} <NButton quaternary size="tiny" @click="state.refresh">
          {{ labels.reload }}
        </NButton>
      </p>
      <template v-if="detail && execution">
        <header class="grid grid-cols-1 min-w-0 gap-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <strong class="min-w-0 flex-1 text-fg text-[14px]">{{ displayName }}</strong>
            <NButton v-if="execution.canCancel" quaternary size="small" :loading="stopping" :disabled="!state.environment?.ready.value" @click="stop">
              {{ stopping ? labels.stopping : labels.stop }}
            </NButton>
          </div>
          <span v-if="detail.caller" class="text-muted text-[12px]">{{ labels.caller }}{{ executionDisplayName(detail.caller) }}</span>
          <BuddyExecutionStatus :execution="execution" :language="language" :stopping="stopping" />
          <span class="text-muted text-[11px]">{{ labels.updated }} {{ updated }}</span>
          <p class="m-0 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-muted text-[13px]">
            {{ execution.task }}
          </p>
        </header>
        <BuddyExecutionQuestion v-for="question in execution.questions" :key="`${target.runId}:${question.questionId}`" :question="question" :enabled="execution.canAnswer && !!state.environment?.ready.value" :language="language" :reply="answer" />
        <p v-if="execution.waitingFor === 'approval'" class="m-0 text-warning text-[12px]" role="status">
          {{ labels.approvalHint }}
        </p>
        <div v-if="execution.cleanup === 'degraded'" class="grid grid-cols-1 min-w-0 gap-1 text-warning text-[12px]" role="alert">
          <p class="m-0">
            {{ labels.cleanup }}
          </p>
          <span v-for="resource in execution.affectedResources" :key="resource.kind === 'host' ? 'host' : resource.path" class="min-w-0 [overflow-wrap:anywhere]">{{ resource.kind === 'host' ? labels.host : resource.path }}</span>
        </div>
        <div class="grid grid-cols-1 min-w-0 gap-[var(--buddy-chat-gap-block)]" data-testid="execution-process">
          <template v-for="row in state.rows.value" :key="row.key">
            <BuddyChatMessageBody v-if="row.kind === 'message'" :message="row.message" :language="language" :final="!row.streaming" :turn-outputs="row.turnOutputs" :turn-changes="row.turnChanges" :write-clipboard-text="content.writeClipboardText" />
            <BuddyChatAgentTurn v-else-if="row.kind === 'agent-turn'" :turn="row.turn" :language="language" :show-identity="false" :show-outcome="row.showOutcome" />
            <BuddyChatAgentTurnFlow v-else-if="row.kind === 'activity-flow'" :nodes="row.nodes" :failure-detail-text="null" :language="language" />
            <BuddyChatCompactionRow v-else-if="row.kind === 'compaction'" :node="row.compaction" :language="language" />
          </template>
          <p v-if="!state.rows.value.length" class="m-0 text-muted text-[12px]">
            {{ labels.processEmpty }}
          </p>
        </div>
        <BuddyChatTokenUsage v-if="detail.usage" :usage="detail.usage" :language="language" />
        <BuddyChatTurnOutputs v-if="detail.artifacts.length" :artifacts="detail.artifacts" :language="language" @open-artifact="emit('openArtifact', $event)" />
        <BuddyChatTurnChanges v-if="detail.changes" :change-set="detail.changes" :language="language" @open-changes="emit('openChanges', $event)" />
        <BuddyExecutionInputs :inputs="detail.inputs" :language="language" />
      </template>
    </div>
    <p v-if="failed" role="alert" class="m-0 p-3 text-danger text-[12px]">
      {{ labels.actionFailed }}
    </p>
    <form v-if="showSupplement && execution" class="flex-none grid grid-cols-1 min-w-0 gap-2 p-3 border-t-1 border-t-solid border-t-border" data-testid="execution-supplement" @submit.prevent="send">
      <label class="text-muted text-[12px]">{{ labels.recipient }}<strong class="text-fg">{{ displayName }}</strong></label>
      <NInput v-model:value="draft" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" :maxlength="MAX_BUDDY_MESSAGE_TEXT_LENGTH" :placeholder="supplementLabels.placeholder" :readonly="!live" :disabled="sending" />
      <div class="flex flex-wrap min-w-0 items-center justify-between gap-2">
        <span v-if="!live" class="text-muted text-[11px]">{{ execution.canSend ? labels.unavailable : labels.readOnly }}</span>
        <NButton class="ml-auto" size="small" :loading="sending" :disabled="!live || !draft.trim()" attr-type="submit">
          {{ supplementLabels.send }}
        </NButton>
      </div>
    </form>
  </section>
</template>
