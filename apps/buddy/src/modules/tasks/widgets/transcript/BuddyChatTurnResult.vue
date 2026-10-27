<script setup lang="ts">
import type { LocalRunTokenUsage } from '@buddy-shared/usage/runTokenUsage'
import type { ChatAgentTurn } from '../../model/transcript/chatAgentTurn'
import type { ChatMessageBranchNavigator } from '../../model/transcript/chatMessageBranches'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed } from 'vue'
import { projectChatAgentTurnActions } from '../../model/transcript/chatMessageActions'
import BuddyChatActionToolbar from './BuddyChatActionToolbar.vue'

const props = defineProps<{
  actionsDisabled: boolean
  branchNavigator: ChatMessageBranchNavigator | null
  language: BuddyLocale
  followingUp?: boolean
  canFollowup?: boolean
  turn: ChatAgentTurn
  usage: LocalRunTokenUsage | null
}>()
const emit = defineEmits<{
  activateBranch: [branchId: string]
  regenerate: []
  followup: []
}>()
const actions = computed(() => projectChatAgentTurnActions(props.turn, props.actionsDisabled, true, props.canFollowup))
</script>

<template>
  <footer
    class="buddy-chat-turn-result flex flex-wrap items-center gap-x-3 gap-y-1 pb-[var(--buddy-chat-gap-turn)] text-muted text-[length:var(--buddy-chat-tool-font-size)]"
    :data-task-result-run-id="turn.runId"
  >
    <BuddyChatActionToolbar
      :actions="actions"
      :branch-navigator="branchNavigator"
      copy-text=""
      :created-at="turn.completedAt ?? turn.startedAt"
      :language="language"
      role="assistant"
      :target-key="`run-${turn.runId}`"
      :usage="usage"
      :following-up="followingUp"
      @activate-branch="emit('activateBranch', $event)"
      @regenerate="emit('regenerate')"
      @followup="emit('followup')"
    />
  </footer>
</template>
