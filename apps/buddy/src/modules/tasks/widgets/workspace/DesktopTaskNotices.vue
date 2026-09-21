<script setup lang="ts">
import type { TaskNoticesProps } from './typing'
import type { DesktopSettingsCategory } from '@/shared/navigation/desktopRoutes'
import { Dismiss16Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopApprovalCard from './DesktopApprovalCard.vue'
import DesktopChatStatus from './DesktopChatStatus.vue'
import DesktopDraftRestorationNotice from './DesktopDraftRestorationNotice.vue'

const props = defineProps<TaskNoticesProps>()
const emit = defineEmits<{
  openSettings: [category: DesktopSettingsCategory]
  selectModel: []
}>()
const { t } = useBuddyI18n(() => props.language)
const restorationConflict = computed(() => props.restoration.conflict.value)
const restorationState = computed(() => props.restoration.state.value)
const visibleChatBlocker = computed(() => props.status.visibleChatBlocker.value)
const canRestartRuntime = computed(() => props.status.canRestartRuntime.value)
const runtimeError = computed(() => props.status.runtimeError.value)
const runtimeState = computed(() => props.status.runtimeState.value)
const approvalViews = computed(() => props.execution.approvalViews.value)
const editingMessageId = computed(() => props.execution.editingMessageId.value)
const resolvingApprovalActions = computed(() => props.execution.resolvingApprovalActions.value)
</script>

<template>
  <DesktopDraftRestorationNotice
    :conflict="restorationConflict"
    :language="language"
    :resolve-remote="restoration.resolveRemote"
    :restore="restoration.restore"
    :state="restorationState"
  />
  <DesktopChatStatus
    :blocker="visibleChatBlocker"
    :can-restart-runtime="canRestartRuntime"
    :language="language"
    :runtime-error="runtimeError"
    :runtime-status="runtimeState.status"
    @dismiss-blocker="status.dismissChatBlocker"
    @open-settings="emit('openSettings', $event)"
    @restart-runtime="status.restartRuntime"
    @select-model="emit('selectModel')"
  />

  <article v-if="editingMessageId" class="desktop-chat-page__editing" role="status">
    <DesktopIcon class="desktop-chat-page__editing-icon" name="messageEdit" />
    <strong>{{ t('desktop.chat.editingHistoryMessage') }}</strong>
    <NButton
      class="buddy-icon-button"
      quaternary
      size="tiny"
      :aria-label="t('common.cancel')"
      @click="execution.cancelEditUserMessage"
    >
      <template #icon>
        <DesktopIcon :component="Dismiss16Regular" />
      </template>
    </NButton>
  </article>

  <div v-if="approvalViews.length" class="desktop-chat-page__approvals">
    <DesktopApprovalCard
      v-for="approval in approvalViews"
      :key="approval.id"
      :approval="approval"
      :language="language"
      :resolving-action="resolvingApprovalActions.get(approval.id) ?? null"
      @approve="execution.resolveApproval(approval.id, $event)"
      @deny="execution.resolveApproval(approval.id, 'deny')"
    />
  </div>
</template>

<style scoped lang="scss">
.desktop-chat-page__approvals {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.4rem;
}

.desktop-chat-page__editing {
  display: grid;
  min-height: 2.75rem;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.55rem;
  border: 1px solid var(--buddy-accent-border);
  border-radius: 0.625rem;
  background: var(--buddy-accent-surface);
  color: var(--buddy-accent-on-surface);
  padding: 0.4rem 0.45rem 0.4rem 0.65rem;

  strong {
    font-size: 0.82rem;
    font-weight: 650;
    line-height: 1.4;
  }

  .buddy-icon-button {
    width: 1.75rem;
    height: 1.75rem;
    color: var(--buddy-accent-text);
  }
}

.desktop-chat-page__editing-icon {
  color: var(--buddy-accent-text);
  font-size: 1.1rem;
}
</style>
